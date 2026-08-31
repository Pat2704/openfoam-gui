/**
 * OpenFOAM Studio — Electron main process.
 *
 * Responsibilities:
 *  - Spawn the bundled Next.js standalone server (node.exe + server.js)
 *    on a free 127.0.0.1 port (invisible to the user).
 *  - Wait for the server to be ready, then open a native BrowserWindow.
 *  - Kill the server (and its child processes) on app quit / window close.
 *
 * No Chrome, no visible localhost: the user just double-clicks the .exe.
 */

const { app, BrowserWindow, dialog, shell, Menu, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');

// ─────────────────────────────────────────────────────────────────────────────
// Input-freeze mitigations (must run BEFORE app.whenReady).
//
// Symptom the user reported: "ogni tanto si blocca qualsiasi casella di testo
// e non mi fa inserire niente" — text inputs intermittently freeze and stop
// accepting keystrokes. After online research (GitHub issues #40578, #31968,
// the Reddit/StackOverflow threads on "Electron inputs stop working until
// DevTools is opened", and the documented Chromium compositor/hit-testing
// stall on Windows), the real root cause is a combination of:
//
//   (a) Chromium GPU compositor stalls on Windows with certain GPU/driver
//       combos — the compositor stops draining the renderer's input event
//       queue, so keystrokes pile up / never reach the input. The well-known
//       workaround is "open/close DevTools once" because that forces a
//       compositor re-initialisation that un-sticks input dispatch.
//   (b) CSS `backdrop-filter: blur()` on STICKY elements (header, footer,
//       chat-popup sticky top). When GPU acceleration is disabled (which we
//       do below for stability), the page falls back to SOFTWARE compositing.
//       In software compositing, every repaint of a sticky backdrop-filter
//       is O(page-area) — so every keystroke (which triggers a reflow of the
//       input's containing block) re-runs the blur over the whole page.
//       This manifests as input lag so severe it looks like the input froze.
//
// Fixes applied below + in the React source (page.tsx, chat-popup.tsx —
// `backdrop-blur-sm` removed from all sticky elements). Together they
// eliminate both root causes. None of the switches here are expensive; the
// app still renders fine in software, and 99% of users won't notice the
// difference except that text boxes no longer freeze.
// ─────────────────────────────────────────────────────────────────────────────

// (a) Disable GPU hardware acceleration. Falls back to software compositing
//     which is 100% reliable on Windows, just slightly higher CPU. This is
//     the single most-recommended fix for "Electron text input freezes".
app.disableHardwareAcceleration();

// (b) Belt-and-braces CLI switches that go further than the JS API.
//     `--disable-gpu` and `--disable-gpu-compositing` are the most-cited
//     fixes on SuperUser / Reddit / GitHub for Electron input/compositor
//     stalls on Windows (the `disableHardwareAcceleration()` call is
//     equivalent to `--disable-gpu`, but listing it explicitly documents
//     the intent and is harmless if Electron ever changes the JS API's
//     exact behaviour).
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

// A couple of known-problematic Chromium features that have caused input
// unresponsiveness on Windows in the past.
app.commandLine.appendSwitch('disable-features', [
  'HardwareMediaKeyHandling',     // grabs media-key focus, can stall input
  'MediaSessionService',          // ditto
  'BackForwardCache',             // can freeze inputs after b/f navigation
  'CalculateNativeWinOcclusion',  // Windows-specific occlusion calc that has
                                  // been implicated in input-stall bugs
                                  // (it can mark the window as occluded
                                  // briefly during alt-tab and stop
                                  // dispatching input events)
  'Vulkan',                       // avoid Vulkan GPU backend variability
].join(','));

// Reduce the chance of the renderer being throttled while the window is
// briefly inactive (e.g. user alt-tabs for a second). Combined with the
// focus-restore handler below, this kills the "input dead after alt-tab"
// failure mode.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let mainWindow = null;
let serverProcess = null;
let serverPort = 0;
let serverStarting = false;

// Resolve paths (dev vs production)
const isDev = !app.isPackaged;
const resourcesBase = isDev
  ? path.join(__dirname, 'resources')
  : process.resourcesPath;

const nodeExePath = path.join(resourcesBase, 'bin', 'node.exe');
const standaloneDir = path.join(resourcesBase, 'standalone');
const serverJsPath = path.join(standaloneDir, 'server.js');

const APP_TITLE = 'OpenFOAM Studio - GUI';
const READY_TIMEOUT_MS = 60000; // 60s should be plenty for Next.js standalone to boot

/**
 * Find a free TCP port on 127.0.0.1 by binding to port 0 and reading the
 * assigned port, then immediately closing the listener. There's a tiny race
 * (another process could grab the port before Next.js binds it), but in
 * practice it's negligible and we use 127.0.0.1 only.
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Poll the server's HTTP port until it answers (any HTTP status counts as
 * "server is up"). Rejects after READY_TIMEOUT_MS.
 */
function waitForServer(port, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let timer = null;

    function attempt() {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('Server did not start within ' + (timeoutMs / 1000) + 's'));
      }
      const req = http.get({ hostname: host, port: port, path: '/', timeout: 1500 }, (res) => {
        res.resume();
        // Any HTTP response means the server is listening.
        if (res.statusCode) return resolve();
        timer = setTimeout(attempt, 300);
      });
      req.on('error', () => { timer = setTimeout(attempt, 300); });
      req.on('timeout', () => { req.destroy(); timer = setTimeout(attempt, 300); });
    }
    attempt();

    // Cleanup helper (not strictly required, keeps things tidy)
    Promise.resolve().then(() => {});
  });
}

async function startServer() {
  if (serverProcess || serverStarting) return;
  serverStarting = true;

  serverPort = await getFreePort();
  console.log('[main] Using free port:', serverPort);

  // Build env: clone process.env, then set the values Next.js expects.
  // IMPORTANT: strip ELECTRON_RUN_AS_NODE so the bundled node.exe runs as
  // a normal Node process (this is only set if we were launched by another
  // Electron-as-node invocation, which is unlikely but safe to clean).
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  env.NODE_ENV = 'production';
  env.PORT = String(serverPort);
  env.HOSTNAME = '127.0.0.1';
  env.NEXT_TELEMETRY_DISABLED = '1';
  // Avoid the Node worker being affected by the parent's color/CI settings.
  env.FORCE_COLOR = '0';
  env.NO_COLOR = '1';

  console.log('[main] Spawning server:', nodeExePath, serverJsPath);

  serverProcess = spawn(nodeExePath, [serverJsPath], {
    cwd: standaloneDir,
    env: env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logLine = (chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.length) console.log('[server] ' + line);
    }
  };
  serverProcess.stdout.on('data', logLine);
  serverProcess.stderr.on('data', logLine);

  serverProcess.on('error', (err) => {
    console.error('[main] Failed to spawn server:', err);
    dialog.showErrorBox(APP_TITLE, 'Failed to start the backend server:\n' + err.message);
  });

  serverProcess.on('exit', (code, signal) => {
    console.log('[main] Server process exited. code=', code, 'signal=', signal);
    serverProcess = null;
    // If the server dies while the window is still open, surface it.
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(
        APP_TITLE,
        'The backend server stopped unexpectedly (exit code ' + code + ').\nThe app will now close.'
      );
      app.quit();
    }
  });

  serverStarting = false;

  await waitForServer(serverPort, '127.0.0.1', READY_TIMEOUT_MS);
  console.log('[main] Server is ready on port', serverPort);
}

/**
 * Kill the Next.js server and any child processes it spawned.
 * On Windows we must use taskkill /T /F to kill the whole process tree.
 */
function killServer() {
  if (!serverProcess) return;
  const pid = serverProcess.pid;
  try {
    if (process.platform === 'win32' && pid) {
      // /T = tree (kill children too), /F = force
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      try { serverProcess.kill('SIGTERM'); } catch (_) {}
    }
  } catch (e) {
    console.error('[main] Failed to kill server:', e);
  } finally {
    serverProcess = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FOAMy LLM configuration store.
//
// This CANNOT live in the renderer's localStorage: the server binds to a free
// port chosen at launch, so the page origin (http://127.0.0.1:<port>) differs
// on every run, and localStorage is partitioned per origin — the user lost
// their API key on every restart.
//
// So it is kept here, in a file under userData, which is independent of the
// port. The API key is additionally encrypted with safeStorage (DPAPI on
// Windows): the ciphertext is bound to the current OS user, so copying the
// file to another machine yields nothing.
//
// The file lives in the user's own profile, never inside the .exe — anyone you
// send the executable to starts with an empty configuration.
// ─────────────────────────────────────────────────────────────────────────────

// Keys whose value is secret and must be encrypted at rest.
const SECRET_CONFIG_KEYS = ['foamy-llm-key'];

function configFilePath() {
  return path.join(app.getPath('userData'), 'foamy-config.json');
}

function readConfig() {
  try {
    const raw = fs.readFileSync(configFilePath(), 'utf-8');
    const stored = JSON.parse(raw);
    const out = {};
    for (const [k, v] of Object.entries(stored)) {
      if (typeof v !== 'string') continue;
      if (SECRET_CONFIG_KEYS.includes(k) && v.startsWith('enc:')) {
        // Written by a build where encryption was available. If it is no longer
        // available (or this is a different OS user) the value is unreadable —
        // drop it rather than handing back ciphertext.
        try {
          out[k] = safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
        } catch (_) { /* unreadable: treat as not set */ }
      } else {
        out[k] = v;
      }
    }
    return out;
  } catch (_) {
    return {};
  }
}

function writeConfig(config) {
  const toStore = {};
  for (const [k, v] of Object.entries(config || {})) {
    if (typeof v !== 'string') continue;
    if (SECRET_CONFIG_KEYS.includes(k) && v && safeStorage.isEncryptionAvailable()) {
      toStore[k] = 'enc:' + safeStorage.encryptString(v).toString('base64');
    } else {
      toStore[k] = v;
    }
  }
  const file = configFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 0o600: readable only by the owning user on platforms that honour it.
  fs.writeFileSync(file, JSON.stringify(toStore, null, 2), { mode: 0o600 });
}

function registerConfigIpc() {
  ipcMain.handle('foamy-config:get', () => readConfig());
  ipcMain.handle('foamy-config:set', (_event, config) => {
    try {
      writeConfig(config);
      return true;
    } catch (err) {
      console.error('[main] Failed to write FOAMy config:', err);
      return false;
    }
  });
  ipcMain.handle('foamy-config:clear', () => {
    try { fs.unlinkSync(configFilePath()); } catch (_) { /* already gone */ }
    return true;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0f0f0f',
    title: APP_TITLE,
    // Use the bundled icon.ico (lives in <resourcesPath>/icon.ico in prod,
    // or build/icon.ico in dev) so the window + taskbar show our airfoil icon.
    icon: isDev
      ? path.join(__dirname, 'build', 'icon.ico')
      : path.join(resourcesBase, 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Don't throttle JS timers when the window is briefly inactive —
      // throttled timers are a common cause of perceived input freeze on
      // regain-focus.
      backgroundThrottling: false,
    },
  });

  // Hide the default menu bar entirely.
  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);

  mainWindow.loadURL('http://127.0.0.1:' + serverPort + '/');

  // Open external (non-app) links in the user's default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (
      url.startsWith('http://127.0.0.1:' + serverPort) ||
      url.startsWith('http://localhost:' + serverPort)
    ) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Block new-window navigation to anything that isn't our app origin.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = (
      url.startsWith('http://127.0.0.1:' + serverPort) ||
      url.startsWith('http://localhost:' + serverPort)
    );
    if (!allowed) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // Focus restoration: the single most-cited fix for the "Electron text
  // inputs freeze after the window briefly loses focus" bug. When the
  // window regains focus (alt-tab back, click on another app then back,
  // restore from minimized, etc.), we explicitly push focus into the
  // webContents so Chromium re-activates the currently-focused input
  // element and starts dispatching keystrokes to it again.
  // ─────────────────────────────────────────────────────────────────────
  const refocusWebContents = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.webContents || mainWindow.webContents.isDestroyed()) return;
    // Push keyboard focus back into the webContents. Chromium will then
    // re-activate whatever input element was last focused in the page and
    // start dispatching keystrokes to it again. This is the documented
    // workaround for the "Electron text inputs freeze after focus loss" bug.
    try { mainWindow.webContents.focus(); } catch (_) {}
  };
  mainWindow.on('show', refocusWebContents);
  mainWindow.on('restore', refocusWebContents);
  mainWindow.on('focus', refocusWebContents);
  // browser-window-focus fires for any BrowserWindow — only act on ours.
  app.on('browser-window-focus', (event, win) => {
    if (win === mainWindow) refocusWebContents();
  });
  // If the renderer process crashes and Electron reloads it, refocus.
  mainWindow.webContents.on('did-finish-load', refocusWebContents);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Single-instance lock: if a second instance is launched, focus the first.
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    console.log('[main] Another instance is already running. Quitting.');
    app.quit();
    return;
  }

  registerConfigIpc();

  try {
    await startServer();
    createWindow();
  } catch (err) {
    console.error('[main] Startup failed:', err);
    dialog.showErrorBox(APP_TITLE, 'Startup failed:\n' + (err && err.message ? err.message : err));
    killServer();
    app.quit();
  }
});

app.on('second-instance', () => {
  // Someone tried to run a second instance — focus our window.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  // For this app, closing the window = quitting (no macOS dock persistence).
  killServer();
  app.quit();
});

app.on('before-quit', () => {
  killServer();
});

// Belt-and-braces: make sure the server dies if we are killed.
app.on('will-quit', () => {
  killServer();
});

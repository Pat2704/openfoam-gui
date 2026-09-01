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
// History, because it matters for what is and is not safe to remove here.
//
// Text inputs used to intermittently stop accepting keystrokes until the user
// clicked another app and back. The first response was a shotgun: disable GPU
// acceleration entirely, on the theory that a Chromium compositor stall was
// eating input events. It helped enough to look like a fix.
//
// The actual causes were found later, and both are gone from the codebase:
//
//   1. window.confirm() / alert(). A native modal frequently fails to hand
//      keyboard focus back to the page when it closes. Every confirmation now
//      goes through the in-page dialog in src/components/ui/confirm-host.tsx.
//   2. child_process calls without `windowsHide: true`. This process owns no
//      console, so Windows allocated a fresh console window for every wsl.exe
//      child; it flashed for a few milliseconds and stole foreground focus.
//      Every call in src/lib/wsl.ts now passes the flag.
//
// With those two fixed, disabling the GPU no longer buys anything — and it
// costs a lot: WebGL fell back to SwiftShader (measured: renderer reported as
// "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device ...))", webgl feature status
// "unavailable_software"), which makes the 3D mesh viewer unusable. With
// acceleration on, the same probe reports the real adapter through D3D11.
//
// So hardware acceleration is ENABLED. If the input freeze ever comes back,
// this is the first thing to suspect: re-adding
//     app.disableHardwareAcceleration();
//     app.commandLine.appendSwitch('disable-gpu');
//     app.commandLine.appendSwitch('disable-gpu-compositing');
// restores the old behaviour, at the cost of the mesh viewer. Do that only
// after ruling out a third native-focus cause of the same family (anything
// that briefly takes foreground focus: native dialogs, console children,
// external processes).
// ─────────────────────────────────────────────────────────────────────────────

// Chromium features that have caused input unresponsiveness on Windows and are
// unrelated to the GPU — these stay disabled.
app.commandLine.appendSwitch('disable-features', [
  'HardwareMediaKeyHandling',     // grabs media-key focus, can stall input
  'MediaSessionService',          // ditto
  'BackForwardCache',             // can freeze inputs after b/f navigation
  'CalculateNativeWinOcclusion',  // Windows-specific occlusion calc that has
                                  // been implicated in input-stall bugs
                                  // (it can mark the window as occluded
                                  // briefly during alt-tab and stop
                                  // dispatching input events)
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

// Startup timing, printed with every [main] line. Run the exe from a terminal
// to see where the seconds go — the numbers are the reason for the shape of
// the startup path below (window first, server in parallel, WSL pre-warmed).
const T0 = Date.now();
function elapsed() { return String(Date.now() - T0).padStart(5, ' ') + 'ms'; }
function log(...args) { console.log('[main]', elapsed(), ...args); }

/**
 * The page shown while the Next.js server is still booting.
 *
 * The window used to be created only AFTER the server answered, so the user
 * clicked the icon and stared at the desktop for a second or two with no sign
 * that anything was happening. Now the window appears immediately with this,
 * and swaps to the real URL when the server is up.
 *
 * Inlined as a data: URL — it must not depend on the server it is waiting for.
 */
const SPLASH_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html><head><meta charset="utf-8"><title>${APP_TITLE}</title>
<style>
  html,body{height:100%;margin:0}
  body{background:#0f0f0f;color:#e7e7e7;display:flex;align-items:center;justify-content:center;
       font:14px/1.5 "Segoe UI",system-ui,sans-serif}
  .b{text-align:center}
  .t{font-size:17px;font-weight:600;letter-spacing:.2px}
  .s{margin-top:6px;color:#8b8b8b;font-size:12px}
  .r{margin:18px auto 0;width:150px;height:2px;background:#262626;overflow:hidden;border-radius:2px}
  .r i{display:block;width:40%;height:100%;background:#ef6c2b;animation:m 1.1s ease-in-out infinite}
  @keyframes m{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}
</style></head>
<body><div class="b">
  <div class="t">OpenFOAM Studio</div>
  <div class="s">Starting the local server…</div>
  <div class="r"><i></i></div>
</div></body></html>`)}`;

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
      // 60ms between attempts: the server usually answers within the first few
      // hundred ms, and at 300ms we spent most of the wait sleeping past a
      // server that was already up.
      const req = http.get({ hostname: host, port: port, path: '/', timeout: 1500 }, (res) => {
        res.resume();
        // Any HTTP response means the server is listening.
        if (res.statusCode) return resolve();
        timer = setTimeout(attempt, 60);
      });
      req.on('error', () => { timer = setTimeout(attempt, 60); });
      req.on('timeout', () => { req.destroy(); timer = setTimeout(attempt, 60); });
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
  log('Using free port:', serverPort);

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
  log('Server is ready on port', serverPort);
  warmUpWsl();
}

/**
 * Fire one throwaway request at the WSL layer while the page is still loading.
 *
 * The first call into src/lib/wsl.ts pays for everything: `wsl --list -q`, the
 * distro waking up, validating the cached bashrc, sourcing the OpenFOAM
 * environment. It costs well over a second on a cold WSL, and the Dashboard
 * used to pay it on its own first request, with the UI already on screen and
 * showing an error state while it waited. Doing it here overlaps that cost with
 * Chromium loading the page.
 *
 * Deliberately fire-and-forget: if it fails, the real request will report it.
 */
function warmUpWsl() {
  try {
    const req = http.get(
      { hostname: '127.0.0.1', port: serverPort, path: '/api/wsl?action=version', timeout: 30000 },
      (res) => { res.resume(); res.on('end', () => log('WSL warm-up done')); }
    );
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
  } catch (_) { /* never fatal */ }
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

  // The splash goes up straight away; loadApp() swaps in the real page as soon
  // as the server answers. Waiting for the server before creating the window
  // meant the app looked like it had not launched at all.
  mainWindow.loadURL(SPLASH_HTML);
  log('Window created (splash)');

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

// Single-instance lock, taken BEFORE anything is spawned: a second launch must
// not start a server of its own, and it exits too early to be sure it would
// clean one up.
const gotSingleInstanceLock = app.requestSingleInstanceLock();

/**
 * Start the server WITHOUT waiting for Electron to be ready.
 *
 * Spawning node.exe and Chromium's own initialisation are independent, and
 * they used to run one after the other: whenReady → getFreePort → spawn →
 * poll → window. Kicking the server off here overlaps the two, and by the time
 * the window exists the server is usually already answering.
 */
const serverReady = gotSingleInstanceLock
  ? startServer().catch((err) => {
      // Reported once Electron is ready and a dialog can actually be shown.
      log('Server startup failed:', err && err.message ? err.message : err);
      throw err;
    })
  : Promise.resolve();

/** Swap the splash for the app once the server answers. */
async function loadApp() {
  try {
    await serverReady;
  } catch (err) {
    dialog.showErrorBox(APP_TITLE, 'Startup failed:\n' + (err && err.message ? err.message : err));
    killServer();
    app.quit();
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.loadURL('http://127.0.0.1:' + serverPort + '/');
  log('App loaded');
}

app.whenReady().then(async () => {
  log('Electron ready');
  if (!gotSingleInstanceLock) {
    log('Another instance is already running. Quitting.');
    app.quit();
    return;
  }

  registerConfigIpc();
  createWindow();
  await loadApp();
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

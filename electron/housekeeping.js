/**
 * Startup housekeeping: remove what earlier runs left behind in TEMP.
 *
 * Three things accumulated there, launch after launch, and nothing ever took
 * them away again:
 *
 *  - Portable extractions. The portable stub unpacks the whole app (~350 MB)
 *    into %TEMP%\<27-character id> and deletes it when the app exits. When the
 *    stub itself is ended first — End Task, a crash, a logoff, Windows shutting
 *    down — the folder stays forever. Six of them, 2.1 GB, were found on one
 *    machine.
 *  - ParaView session folders (openfoam-studio-paraview-session-*). The worker
 *    removes its folder when it is stopped, but on quit the server is ended with
 *    `taskkill /F /T`, so that code never runs: the warm-up engine alone left
 *    one folder per launch.
 *  - Claude system-prompt files (openfoam-studio-agent/system-prompt-*). They
 *    are content-addressed, so every distinct prompt added a file for good.
 *    src/lib/claude-cli.ts rewrites one whenever it is missing.
 *
 * Fixing each cause at its source is not possible for the first (the stub is
 * electron-builder's) and not reliable for the second (no code runs after a
 * forced kill), so the sweep happens at the next start instead, which covers
 * every way the previous run may have ended.
 *
 * The ORDER matters, and is why this is split in two:
 *
 *  - snapshotLeftovers() runs synchronously BEFORE the server is spawned. It
 *    only lists names, so it costs milliseconds, and the list it returns can
 *    contain nothing the new server creates: those folders get fresh random
 *    names afterwards. The prompt files are deleted right here, while no agent
 *    can be using them, because their names are NOT fresh — the new server may
 *    recreate the very same file a moment later.
 *  - removeLeftovers() then deletes the listed folders in the background,
 *    without holding up the window.
 *
 * A folder whose programs are still running is left alone, so that another
 * copy of the app — or a server orphaned by an app that was ended in Task
 * Manager — is never half-deleted under a live process. The test is opening
 * the executables for writing, which Windows refuses while they run. Renaming
 * the folder is NOT such a test: measured, Windows renames a folder with a
 * running .exe in it without complaint. A portable folder written in the last
 * ten minutes is left alone too: that is a stub extracting into it right now.
 *
 * A folder is renamed before it is deleted, so that a deletion cut short
 * (a locked file, the app closed meanwhile) still carries a name the next start
 * recognises and finishes.
 *
 * Nothing here may throw: housekeeping must never stand between the user and
 * the app.
 */

const path = require('path');

/**
 * Electron's `fs` treats every `.asar` file as a folder, so removing a portable
 * extraction stopped at resources/app.asar and left the folder behind (seen in
 * the packaged app; plain Node, and so the tests, never show it). `original-fs`
 * is Electron's unpatched module; under plain Node it does not exist.
 */
const fs = (() => {
  try { return require('original-fs'); } catch (_) { return require('fs'); }
})();

/** The portable stub's folder name: a KSUID, 27 base-62 characters. */
const PORTABLE_DIR = /^[0-9A-Za-z]{27}$/;
const PARAVIEW_DIR = /^openfoam-studio-paraview-session-/;
/** A folder already renamed for deletion whose removal did not finish. */
const TRASH_DIR = /^openfoam-studio-trash-/;
const AGENT_DIR = 'openfoam-studio-agent';
const AGENT_PROMPT = /^system-prompt-/;
/** A portable folder this recent may still be being extracted. */
const FRESH_MS = 10 * 60 * 1000;
/** The programs a portable extraction runs: the app, and the server's node. */
const EXECUTABLES = [['OpenFOAMStudio.exe'], ['resources', 'bin', 'node.exe']];

/** Is one of the folder's programs running right now? */
function isRunning(dir) {
  for (const parts of EXECUTABLES) {
    try {
      fs.closeSync(fs.openSync(path.join(dir, ...parts), 'r+'));
    } catch (err) {
      if (!err || err.code !== 'ENOENT') return true;
    }
  }
  return false;
}

/** Is this one of our portable extractions, rather than any other KSUID folder? */
function isPortableExtraction(dir, now) {
  return now - fs.statSync(dir).mtimeMs > FRESH_MS
    && fs.existsSync(path.join(dir, 'OpenFOAMStudio.exe'))
    && fs.existsSync(path.join(dir, 'resources', 'standalone', 'server.js'));
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * List what to remove, and delete the agent's prompt files now.
 *
 * @param {object} options
 * @param {string} options.tmpDir      the TEMP folder to sweep
 * @param {string} options.currentDir  the folder this app runs from; never removed
 * @param {number} [options.now]       for tests
 * @returns {{ folders: string[], prompts: number }}
 */
function snapshotLeftovers({ tmpDir, currentDir, now = Date.now() }) {
  const folders = [];
  let prompts = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch (_) {
    return { folders, prompts };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(tmpDir, entry.name);
    if (currentDir && samePath(full, currentDir)) continue;
    if (PARAVIEW_DIR.test(entry.name) || TRASH_DIR.test(entry.name)) {
      folders.push(full);
    } else if (PORTABLE_DIR.test(entry.name)) {
      try { if (isPortableExtraction(full, now)) folders.push(full); } catch (_) { /* unreadable: leave it */ }
    } else if (entry.name === AGENT_DIR) {
      let files = [];
      try { files = fs.readdirSync(full); } catch (_) { /* nothing to do */ }
      for (const file of files) {
        if (!AGENT_PROMPT.test(file)) continue;
        try { fs.unlinkSync(path.join(full, file)); prompts++; } catch (_) { /* in use: next time */ }
      }
    }
  }
  return { folders, prompts };
}

/**
 * Delete the folders snapshotLeftovers() listed, skipping any still in use.
 *
 * @param {string[]} folders
 * @returns {Promise<{ removed: number, skipped: number }>}
 */
async function removeLeftovers(folders) {
  let removed = 0;
  let skipped = 0;
  for (const folder of folders) {
    if (isRunning(folder)) {
      skipped++;
      continue;
    }
    let target = folder;
    if (!TRASH_DIR.test(path.basename(folder))) {
      target = path.join(path.dirname(folder),
        'openfoam-studio-trash-' + process.pid + '-' + removed + '-' + path.basename(folder));
      try {
        await fs.promises.rename(folder, target);
      } catch (err) {
        // ENOENT: someone else removed it meanwhile, which is fine. Anything
        // else means a file in it is held open: leave it for a later start.
        if (!err || err.code !== 'ENOENT') skipped++;
        continue;
      }
    }
    try {
      await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 2 });
      removed++;
    } catch (_) {
      // The renamed folder matches TRASH_DIR, so the next start finishes it.
      skipped++;
    }
  }
  return { removed, skipped };
}

module.exports = { snapshotLeftovers, removeLeftovers };

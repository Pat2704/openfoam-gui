/**
 * OpenFOAM Studio — preload script.
 *
 * Runs in the renderer with contextIsolation enabled and the sandbox on. The
 * Next.js app is a normal web app and needs no Node/Electron APIs, with one
 * exception: the FOAMy LLM configuration.
 *
 * WHY THE CONFIG CANNOT LIVE IN localStorage HERE
 * -----------------------------------------------
 * main.js starts the bundled server on a FREE port chosen at launch, so the
 * page origin is http://127.0.0.1:<random> and changes on every run.
 * localStorage is partitioned per origin, so every launch got a brand new,
 * empty store — the user had to retype their API key every single time.
 *
 * So the config is stored by the main process in a file under app.getPath
 * ('userData'), which does not depend on the port. The API key is encrypted
 * with Electron's safeStorage (DPAPI on Windows), meaning the file is tied to
 * the current OS user and is useless if copied to another machine.
 *
 * The store lives on the machine that runs the app, never inside the .exe:
 * whoever you send the executable to starts with an empty configuration.
 *
 * Note: we deliberately do NOT touch document.title here — the page <title>
 * set by Next.js metadata ("OpenFOAM Studio - GUI") must remain authoritative
 * so the native window title is correct.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicitly enumerated surface: three calls, no arbitrary IPC.
contextBridge.exposeInMainWorld('foamyStore', {
  /** @returns {Promise<Record<string,string>>} the stored config ({} if none) */
  get: () => ipcRenderer.invoke('foamy-config:get'),
  /** @param {Record<string,string>} config */
  set: (config) => ipcRenderer.invoke('foamy-config:set', config),
  clear: () => ipcRenderer.invoke('foamy-config:clear'),
});

// ─────────────────────────────────────────────────────────────────────────────
// Light or dark, before the first paint.
//
// next-themes decides the theme from localStorage in a script it runs at the
// top of the document — and localStorage here is empty on every launch, for the
// port reason above, so the window always came up in the default (light) even
// for a user who had chosen dark. Reading the durable copy AFTER the page has
// loaded can only fix it late, as a visible flash.
//
// A preload runs before any page script, so the choice can be put where
// next-themes will look for it a moment later. The read is synchronous for that
// reason alone: there is no await here that would not already be too late. The
// renderer still writes both copies itself (see src/app/page.tsx), so nothing
// depends on this working — it only decides whether the correct theme is there
// from the first frame or arrives one tick later.
// ─────────────────────────────────────────────────────────────────────────────
try {
  // Only the app's own pages have a usable store; the splash is a data: URL,
  // whose origin is opaque and whose localStorage throws on access.
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    const config = ipcRenderer.sendSync('foamy-config:get-sync') || {};
    const theme = config['ui-theme'];
    if (theme === 'light' || theme === 'dark') {
      // 'theme' is next-themes' default storageKey; THEME_STORAGE_KEY in
      // src/lib/foamy-store.ts is the same string, named on that side.
      localStorage.setItem('theme', theme);
    }
  }
} catch (_) {
  // No store, no storage, or an IPC channel that is not there: the renderer's
  // own restore path handles it.
}

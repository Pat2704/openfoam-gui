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

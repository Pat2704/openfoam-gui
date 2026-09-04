/**
 * Persistence for the FOAMy LLM configuration (provider, base URL, model,
 * API format and the API key).
 *
 * Two backends, picked at runtime:
 *
 *  - Packaged app: `window.foamyStore`, exposed by electron/preload.js. The
 *    main process keeps the values in a file under userData and encrypts the
 *    API key with safeStorage.
 *
 *    This exists because localStorage does NOT work in the packaged app: the
 *    bundled server binds to a free port chosen at launch, so the page origin
 *    is http://127.0.0.1:<random> and differs on every run. localStorage is
 *    partitioned per origin, so each launch got an empty store and the user
 *    had to retype their API key every time.
 *
 *  - Browser (`npm run dev`): localStorage, where the origin is stable.
 *
 * Either way the values live on the machine running the app and never inside
 * the .exe — anyone you send the executable to starts with nothing configured.
 */

export const FOAMY_KEYS = [
  'foamy-llm-provider',
  'foamy-llm-key',
  'foamy-model-id',
  'foamy-base-url',
  'foamy-api-format',
  // The Claude agent's two choices. They live here for the same reason the
  // rest does: in the packaged app the page origin changes every launch, so
  // localStorage would forget them between runs.
  'claude-agent-model',
  'claude-agent-effort',
  // Where Claude Code is, when the automatic search cannot reach it.
  'claude-agent-path',
  // Whether the guard rails are off for the Claude agent.
  'claude-agent-unrestricted',
] as const;

export type FoamyConfig = Partial<Record<(typeof FOAMY_KEYS)[number], string>>;

type FoamyStoreBridge = {
  get: () => Promise<Record<string, string>>;
  set: (config: Record<string, string>) => Promise<boolean>;
  clear: () => Promise<boolean>;
};

function bridge(): FoamyStoreBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { foamyStore?: FoamyStoreBridge }).foamyStore ?? null;
}

/** True when running inside the packaged Electron app. */
export function hasNativeStore(): boolean {
  return bridge() !== null;
}

export async function loadFoamyConfig(): Promise<FoamyConfig> {
  const native = bridge();
  if (native) {
    try {
      return (await native.get()) as FoamyConfig;
    } catch {
      return {};
    }
  }
  try {
    const out: FoamyConfig = {};
    for (const k of FOAMY_KEYS) {
      const v = localStorage.getItem(k);
      if (v) out[k] = v;
    }
    // Legacy key, renamed to foamy-model-id.
    if (!out['foamy-model-id']) {
      const legacy = localStorage.getItem('foamy-model-override');
      if (legacy) {
        out['foamy-model-id'] = legacy;
        try {
          localStorage.setItem('foamy-model-id', legacy);
          localStorage.removeItem('foamy-model-override');
        } catch { /* ignore */ }
      }
    }
    return out;
  } catch {
    // localStorage can throw in private windows / when site data is blocked.
    return {};
  }
}

/**
 * Change some keys and leave the others alone.
 *
 * saveFoamyConfig writes EVERY key, blanking the ones it was not given — which
 * is what FOAMy's settings form wants, and exactly what a panel that only owns
 * two of the keys must not do.
 */
export async function patchFoamyConfig(partial: FoamyConfig): Promise<boolean> {
  const current = await loadFoamyConfig();
  return saveFoamyConfig({ ...current, ...partial });
}

/**
 * Write the configuration, and SAY whether it was written.
 *
 * This used to return `Promise<void>` and swallow every error, which meant the
 * settings form could only ever report success — so a write that failed (the
 * userData directory not writable, a full disk, the IPC channel gone) was
 * announced as "Configuration saved", and the user discovered otherwise on the
 * next launch, when their API key was missing and nothing had ever suggested a
 * problem. The caller can now tell the truth.
 */
export async function saveFoamyConfig(config: FoamyConfig): Promise<boolean> {
  const payload: Record<string, string> = {};
  for (const k of FOAMY_KEYS) payload[k] = config[k] ?? '';

  const native = bridge();
  if (native) {
    try { await native.set(payload); return true; } catch { return false; }
  }
  try {
    for (const [k, v] of Object.entries(payload)) localStorage.setItem(k, v);
    return true;
  } catch {
    // localStorage throws in a private window or with site data blocked.
    return false;
  }
}

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

export async function saveFoamyConfig(config: FoamyConfig): Promise<void> {
  const payload: Record<string, string> = {};
  for (const k of FOAMY_KEYS) payload[k] = config[k] ?? '';

  const native = bridge();
  if (native) {
    try { await native.set(payload); } catch { /* nothing else to fall back to */ }
    return;
  }
  try {
    for (const [k, v] of Object.entries(payload)) localStorage.setItem(k, v);
  } catch { /* ignore */ }
}

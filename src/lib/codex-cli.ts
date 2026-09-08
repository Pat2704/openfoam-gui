/** Codex app-server over stdio: ChatGPT login, durable conversations, scoped tools.
 * No API key, SDK dependency, terminal window or connection to the desktop task.
 * Protocol verified against codex-cli 0.153.1; see docs/RULES.md.
 */
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { homedir } from 'os';
import { Rpc } from './codex-rpc';
import definitions from '../../electron/mcp/openfoam-tools.json';
import { callTool } from './agent-policy';
import { buildModeNotice, sanitizeUserMessage } from './agent-prompt';
import { CODEX_CONFIG, modelChoices, panelEvents, type PanelEvent, type CodexModel } from './codex-protocol';

const run = promisify(execFile);
type Listener = (event: PanelEvent) => void;
interface Install { path: string; version: string; source: string }
interface Session {
  threadId?: string; turnId?: string; busy: boolean; interrupted: boolean;
  unrestricted: boolean; started: number; listeners: Set<Listener>; context: string;
}
const sessions = new Map<string, Session>();
let install: Install | null = null;
let explicit = '';
let probe: { path: string; source: string; error: string }[] = [];
let searching: Promise<Install | null> | null = null;
let connecting: Promise<Rpc> | null = null;
let client: Rpc | null = null;
let login: { started: boolean; done: boolean; url?: string; error?: string; loginId?: string } = { started: false, done: false };

function emit(session: Session, event: PanelEvent) {
  for (const fn of session.listeners) { try { fn(event); } catch { /* disconnected UI */ } }
}
function finish(session: Session, error?: string) {
  if (!session.busy) return;
  session.busy = false;
  session.turnId = undefined;
  if (error) emit(session, { t: 'error', message: error });
  emit(session, { t: 'done', ok: !error, text: '', turns: 1, durationMs: Date.now() - session.started });
  session.listeners.clear();
}

/** Native executables only. npm shims are pointers, never shell command text. */
function nativeCandidates(candidate: string): string[] {
  if (/\.exe$/i.test(candidate)) return [candidate];
  const root = join(dirname(candidate), 'node_modules', '@openai', 'codex');
  return [
    join(root, 'node_modules', '@openai', `codex-win32-${process.arch}`, 'vendor',
      process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
    join(root, 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'),
  ];
}
export async function findCodex(path = '', force = false): Promise<Install | null> {
  const typed = path.trim().replace(/^"|"$/g, '');
  if (typed !== explicit) {
    if ([...sessions.values()].some(s => s.busy)) throw new Error('Stop the current Codex turn before changing its installation.');
    client?.close(); client = null; connecting = null;
    install = null; explicit = typed;
  }
  if (install && !force) return install;
  if (searching) return searching;
  searching = (async () => {
    probe = [];
    const candidates: { path: string; source: string }[] = [];
    const add = (p: string, source: string) => {
      for (const native of nativeCandidates(p)) if (!candidates.some(c => c.path === native)) candidates.push({ path: native, source });
    };
    if (typed) {
      if (!isAbsolute(typed)) { probe.push({ path: typed, source: 'the path you set', error: 'Use an absolute path to codex.exe.' }); return null; }
      add(typed, 'the path you set');
    } else {
      if (process.env.OFSTUDIO_CODEX_PATH) add(process.env.OFSTUDIO_CODEX_PATH, 'found by the app at startup');
      const roaming = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
      add(join(roaming, 'npm', 'codex.cmd'), 'npm global install');
      const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
      const base = join(local, 'OpenAI', 'Codex', 'bin');
      try { for (const folder of readdirSync(base).reverse()) add(join(base, folder, 'codex.exe'), 'Codex desktop app'); } catch { /* optional install */ }
      try {
        const { stdout } = await run('where.exe', ['codex'], { windowsHide: true, timeout: 5000 });
        for (const p of stdout.trim().split(/\r?\n/)) add(p, 'PATH');
      } catch { /* optional PATH */ }
    }
    for (const c of candidates) {
      if (!existsSync(c.path)) { probe.push({ ...c, error: 'File not found.' }); continue; }
      try {
        const { stdout } = await run(c.path, ['--version'], { windowsHide: true, timeout: 60000 });
        const version = stdout.match(/codex-cli\s+(\d+\.\d+\.\d+)/)?.[1];
        if (!version) throw new Error('This executable did not identify itself as Codex CLI.');
        const [major, minor, patch] = version.split('.').map(Number);
        if (major === 0 && (minor < 153 || (minor === 153 && patch < 1))) throw new Error('Codex CLI 0.153.1 or newer is required. Update with npm install -g @openai/codex.');
        install = { ...c, version }; return install;
      } catch (e) { probe.push({ ...c, error: e instanceof Error ? e.message : String(e) }); }
    }
    install = null; return null;
  })();
  try { return await searching; } finally { searching = null; }
}

async function onMessage(rpc: Rpc, msg: any) {
  const p = msg.params || {};
  const session = [...sessions.values()].find(s => s.threadId === p.threadId);
  if (msg.method === 'account/login/completed') {
    login = { ...login, done: true, error: p.success ? undefined : p.error || 'Sign-in did not complete.' }; return;
  }
  if (msg.id !== undefined) {
    if (msg.method === 'item/tool/call' && session?.busy && !session.interrupted &&
        (!p.namespace || p.namespace === 'openfoam') && definitions.some(t => t.name === p.tool)) {
      const mode = session.unrestricted; // captured from the UI's turn, NEVER model arguments
      emit(session, { t: 'tool_use', id: p.callId, name: p.tool, input: p.arguments });
      let result;
      try { result = await callTool(p.tool, p.arguments || {}, mode); }
      catch (e) { result = { error: e instanceof Error ? e.message : String(e) }; }
      const ok = !('error' in result);
      const text = 'error' in result ? result.error : result.text;
      emit(session, { t: 'tool_result', id: p.callId, ok, text });
      rpc.write({ id: msg.id, result: { contentItems: [{ type: 'inputText', text }], success: ok } });
    } else {
      // Fail closed if a future CLI adds an approval or another tool source.
      rpc.write({ id: msg.id, error: { code: -32601, message: 'Only the OpenFOAM tools of an active turn are available.' } });
    }
    return;
  }
  if (!session?.busy) return;
  if (msg.method === 'turn/started') session.turnId = p.turn?.id;
  for (const event of panelEvents(msg.method, p)) emit(session, event);
  if (msg.method === 'turn/completed') finish(session, p.turn?.status === 'failed' ? p.turn.error?.message || 'Codex failed.' : undefined);
}

async function connection(): Promise<Rpc> {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const found = install || await findCodex(explicit);
    if (!found) throw new Error('Codex CLI was not found.');
    // Own credential/session store. A login/logout here never signs the user's
    // desktop Codex out, and their AGENTS.md, MCPs and plugins are not inherited.
    const root = process.env.OFSTUDIO_CODEX_HOME || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'openfoam-studio', 'codex');
    const cwd = join(root, 'workspace'); mkdirSync(cwd, { recursive: true });
    const env = { ...process.env, CODEX_HOME: root };
    for (const key of Object.keys(env)) if (/^(OPENAI_|ANTHROPIC_|CLAUDE|CODEX_)/.test(key) && key !== 'CODEX_HOME') delete env[key as keyof typeof env];
    const args = ['app-server', '--listen', 'stdio://'];
    for (const [key, value] of Object.entries(CODEX_CONFIG)) {
      // The overrides used here are scalars or empty TOML tables.
      args.push('-c', `${key}=${typeof value === 'object' ? '{}' : JSON.stringify(value)}`);
    }
    const child = spawn(found.path, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const rpc = new Rpc(child, msg => { void onMessage(rpc, msg).catch(() => rpc.close()); }, error => {
      if (client !== rpc) return;
      client = null;
      for (const s of sessions.values()) finish(s, error.message);
      if (login.started && !login.done) login = { ...login, done: true, error: error.message };
    });
    try {
      await rpc.request('initialize', { clientInfo: { name: 'openfoam_studio', title: 'OpenFOAM Studio', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      rpc.write({ method: 'initialized', params: {} });
      client = rpc; return rpc;
    } catch (e) { rpc.close(); throw e; }
  })();
  try { return await connecting; } finally { connecting = null; }
}

export async function codexStatus(path = '', force = false) {
  const found = await findCodex(path, force);
  if (!found) return { installed: false, auth: { loggedIn: false }, probe, models: [] };
  const rpc = await connection();
  const account = await rpc.request('account/read', { refreshToken: false });
  const models: CodexModel[] = []; let cursor: string | null = null;
  do {
    const page = await rpc.request('model/list', { limit: 100, includeHidden: false, cursor });
    models.push(...modelChoices(page.data)); cursor = page.nextCursor || null;
  } while (cursor);
  const a = account.account;
  return { installed: true, ...found, probe: [], models,
    auth: { loggedIn: a?.type === 'chatgpt', email: a?.email, subscriptionType: a?.planType, authMethod: a?.type } };
}
export async function startLogin(path = '') {
  await findCodex(path);
  const rpc = await connection();
  if (login.started && !login.done) return login;
  const result = await rpc.request('account/login/start', { type: 'chatgpt' });
  login = { started: true, done: false, url: result.authUrl, loginId: result.loginId };
  return login;
}
export function loginState() { return login; }
export async function logout() {
  for (const id of sessions.keys()) await endSession(id);
  const rpc = await connection();
  if (login.loginId && !login.done) await rpc.request('account/login/cancel', { loginId: login.loginId });
  await rpc.request('account/logout'); login = { started: false, done: false }; return true;
}

export async function send(options: { sessionId: string; message: string; model: string; effort: string;
  systemPrompt: string; unrestricted: boolean }, listener: Listener) {
  let session = sessions.get(options.sessionId);
  if (session?.busy) throw new Error('Codex is already working on this conversation.');
  if (!session) {
    if (sessions.size >= 32) throw new Error('Too many Codex conversations. Close an existing conversation first.');
    session = { busy: false, interrupted: false, unrestricted: false, started: 0, context: '', listeners: new Set() };
    sessions.set(options.sessionId, session);
  }
  // Resuming re-applies baseInstructions, which describe only the mode in force
  // NOW — so a thread that has already run needs the change announced, exactly
  // as on the Claude side. `started` is the marker that it has run.
  const modeChanged = session.started > 0 && session.unrestricted !== options.unrestricted;
  session.busy = true; session.interrupted = false; session.started = Date.now();
  session.listeners.add(listener); session.unrestricted = options.unrestricted;
  try {
    const rpc = await connection();
    const config = { ...CODEX_CONFIG, model_reasoning_effort: options.effort };
    const common = { model: options.model, approvalPolicy: 'never', sandbox: 'read-only',
      config, baseInstructions: options.systemPrompt, developerInstructions: 'Only use the provided OpenFOAM functions. You have no native environment. The user selects Guarded or No limits; tool arguments never change that mode.' };
    if (!session.threadId) {
      const result = await rpc.request('thread/start', { ...common, environments: [],
        dynamicTools: definitions.map(t => ({ type: 'function', name: t.name, inputSchema: t.inputSchema,
          description: t.name === 'run_openfoam' ? `${t.description} When the user switches to No limits, the same tool accepts a WSL shell command, except /mnt/ paths.` : t.description })) });
      session.threadId = result.thread.id;
    } else {
      // A loaded thread can rejoin without applying new instructions. Unload
      // first so changing the active case or Guarded mode actually updates them.
      if (session.context !== options.systemPrompt) await rpc.request('thread/unsubscribe', { threadId: session.threadId });
      await rpc.request('thread/resume', { ...common, threadId: session.threadId });
    }
    session.context = options.systemPrompt;
    if (session.interrupted) { finish(session); return; }
    const result = await rpc.request('turn/start', { threadId: session.threadId, model: options.model, effort: options.effort,
      environments: [],
      input: [{ type: 'text',
        text: (modeChanged ? buildModeNotice(options.unrestricted) : '') + sanitizeUserMessage(options.message),
        text_elements: [] }] });
    if (session.busy) session.turnId = result.turn.id;
    if (session.interrupted && session.turnId) await rpc.request('turn/interrupt', { threadId: session.threadId, turnId: session.turnId });
  } catch (e) { finish(session, e instanceof Error ? e.message : String(e)); }
}
export function unsubscribe(id: string, listener: Listener) { sessions.get(id)?.listeners.delete(listener); }
export async function interrupt(id: string) {
  const s = sessions.get(id); if (!s?.busy) return false;
  s.interrupted = true;
  if (s.threadId && s.turnId && client) await client.request('turn/interrupt', { threadId: s.threadId, turnId: s.turnId });
  return true;
}
export async function endSession(id: string) {
  const s = sessions.get(id); if (!s) return;
  await interrupt(id);
  finish(s); sessions.delete(id);
  if (s.threadId && client) await client.request('thread/unsubscribe', { threadId: s.threadId });
}

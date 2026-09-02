/**
 * Driving Claude Code from inside the app.
 *
 * The user's requirement was that the agent run on their Claude SUBSCRIPTION,
 * not on an API key — the key path already exists in FOAMy, with several
 * providers, and paying twice for the same thing is what we were asked to
 * avoid. The subscription lives in the Claude Code installation on this
 * machine, so the app drives that binary rather than talking to the API.
 *
 * It is headless, and that is the whole point of the redesign: `claude` is
 * started with `-p --input-format stream-json --output-format stream-json`,
 * which is its programmatic mode. There is no terminal, no window, no
 * `claude mcp add` for the user to type. The conversation happens in the app.
 *
 * ── What the agent can touch ────────────────────────────────────────────────
 *
 * Every built-in tool is switched OFF (`--tools ""`), and the only tool source
 * is the app's own MCP server (`--mcp-config` + `--strict-mcp-config`). That
 * second flag is not decoration: WITHOUT it a session inherits the user's
 * claude.ai connectors — a probe run picked up eleven Google Drive tools — and
 * an agent working on someone's CFD case has no business holding those.
 * `--setting-sources ''` does the same for the user's own settings files.
 *
 * So the tool list is exactly the nine in electron/mcp/openfoam-mcp.mjs, whose
 * policy is src/lib/agent-policy.ts: read, write and run OpenFOAM executables,
 * confined to the run directory. `rm` is not in that list and cannot be
 * expressed. `--permission-mode bypassPermissions` therefore does not mean
 * "anything goes" — it means the app does not prompt for tools it has already
 * constrained, which is what the user asked for.
 *
 * ── Lifecycle ───────────────────────────────────────────────────────────────
 *
 * One long-lived child process per chat session, kept across turns, so the
 * model keeps its context and each message costs one round trip rather than a
 * cold start. Model and effort are launch flags, so changing either restarts
 * the process with `--resume <session id>`, which is why session persistence is
 * deliberately left ON.
 */

import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process';
import { promisify } from 'util';
import { existsSync, readdirSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir, homedir } from 'os';
import { randomUUID } from 'crypto';

// ── Finding the binary ──────────────────────────────────────────────────────

export interface ClaudeInstall {
  path: string;
  version: string;
  /** Where it was found — shown in the panel so a wrong pick is diagnosable. */
  source: string;
  /**
   * The path is a .cmd/.bat shim and must go through a shell.
   *
   * Node refuses to spawn one directly since the fix for CVE-2024-27980:
   * `spawn('claude.cmd')` throws EINVAL. Only used when no real .exe could be
   * found, because passing the agent's JSON MCP config through cmd.exe quoting
   * is a good deal more fragile than not doing so.
   */
  shell: boolean;
}

const run = promisify(execFile);

/** Only a SUCCESS is ever stored here — see findClaude for why that matters. */
let cachedInstall: ClaudeInstall | undefined;
/** In flight, so a burst of status polls probes the disk once, not five times. */
let installProbe: Promise<ClaudeInstall | null> | null = null;

/** What the last unsuccessful search tried, and what went wrong with each. */
export interface ProbeAttempt {
  path: string;
  source: string;
  error: string;
}
let lastProbe: ProbeAttempt[] = [];
/** The path the panel last supplied, so a change to it re-runs the search. */
let lastExplicitPath = '';
/**
 * What the search itself saw — the directories it looked in and what the
 * filesystem said about them.
 *
 * Kept because "no candidate was found" is not a diagnosis: it cannot
 * distinguish a missing installation from an environment where the search was
 * looking in the wrong place, which is exactly the ambiguity that cost a whole
 * debugging round on the packaged app.
 */
let searchNotes: ProbeAttempt[] = [];

/** The panel shows this when it cannot find Claude Code — a silent failure is
 *  a failure nobody can fix. */
export function probeReport(): ProbeAttempt[] {
  return lastProbe;
}

/**
 * How long one `claude --version` may take.
 *
 * Generous on purpose. The first run happens moments after the portable stub
 * has extracted 348 MB into TEMP, so the disk is busy and Windows Defender is
 * scanning a binary it has never seen; 15 s was enough on a warm machine and
 * not on a cold one.
 */
const PROBE_TIMEOUT_MS = 60000;

/**
 * Turn whatever we found into something Node can actually start.
 *
 * `npm install -g @anthropic-ai/claude-code` puts three shims on the PATH —
 * `claude` (a shell script), `claude.cmd` and `claude.ps1` — and NONE of them
 * can be spawned directly on Windows: measured on this machine, they fail with
 * ENOENT, EINVAL and UNKNOWN respectively. The package's real binary sits at
 * node_modules/@anthropic-ai/claude-code/bin/claude.exe next to them, so a shim
 * tells us where to look rather than being the answer itself.
 */
function resolveShim(candidate: string): { path: string; shell: boolean } | null {
  if (/\.exe$/i.test(candidate)) return { path: candidate, shell: false };

  const real = join(
    dirname(candidate), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe',
  );
  if (existsSync(real)) return { path: real, shell: false };

  // Last resort: run the shim through a shell, which does work.
  if (/\.(cmd|bat)$/i.test(candidate)) return { path: candidate, shell: true };
  return null;
}

/** Sort "2.1.9" below "2.1.247" — string order would not. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/**
 * Candidate paths, best first.
 *
 * The Claude Code desktop app keeps its CLI under a VERSION-NAMED directory
 * (…\Claude\claude-code\2.1.247\claude.exe), so the path changes with every
 * update and cannot be hardcoded — the newest one wins. The other entries
 * cover a standalone install.
 */
async function candidatePaths(explicitPath = ''): Promise<{ path: string; source: string; shell?: boolean }[]> {
  const out: { path: string; source: string; shell?: boolean }[] = [];
  searchNotes = [];
  const note = (source: string, path: string, error: string) => searchNotes.push({ source, path, error });

  // What the user typed in the panel, first — it is the only source that can
  // reach an installation the automatic search has no way to guess.
  const typed = explicitPath.trim().replace(/^"|"$/g, '');
  if (typed) {
    if (!existsSync(typed)) {
      note('the path you set', typed, 'there is no file at that path');
    } else {
      const resolved = resolveShim(typed);
      if (resolved) out.push({ path: resolved.path, source: 'the path you set', shell: resolved.shell });
      else note('the path you set', typed, 'that file cannot be started directly — point at claude.exe');
    }
  }

  const override = process.env.OFSTUDIO_CLAUDE_PATH;
  if (override && existsSync(override)) out.push({ path: override, source: 'found by the app at startup' });

  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  const desktopRoot = join(appData, 'Claude', 'claude-code');
  note('environment', desktopRoot,
    `APPDATA=${process.env.APPDATA || '(unset)'} · USERPROFILE=${process.env.USERPROFILE || '(unset)'} · homedir=${homedir()}`);
  try {
    const entries = readdirSync(desktopRoot);
    const versions = entries
      .filter(d => /^\d+\.\d+/.test(d))
      .sort(compareVersions)
      .reverse();
    note('desktop app', desktopRoot, `entries: [${entries.join(', ')}] · version-shaped: [${versions.join(', ')}]`);
    for (const v of versions) {
      const exe = join(desktopRoot, v, 'claude.exe');
      const there = existsSync(exe);
      note('desktop app', exe, `claude.exe present: ${there}`);
      if (there) { out.push({ path: exe, source: `Claude Code desktop ${v}` }); break; }
    }
  } catch (err: unknown) {
    note('desktop app', desktopRoot, `cannot read the directory: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The npm global install. This is the one an ordinary process can always
  // reach — %APPDATA%\npm is on PATH and owned by the user — and the only one
  // that worked on the machine where the desktop app's own copy was invisible.
  const npmRoot = join(appData, 'npm');
  const npmBinary = join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  if (existsSync(npmBinary)) out.push({ path: npmBinary, source: 'npm global install' });
  else note('npm global install', npmBinary, 'not installed there');

  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  for (const p of [
    join(localAppData, 'Programs', 'claude-code', 'claude.exe'),
    join(localAppData, 'Programs', 'claude', 'claude.exe'),
    join(localAppData, 'claude-code', 'claude.exe'),
    join(localAppData, 'Claude', 'claude-code', 'claude.exe'),
    join(homedir(), '.local', 'bin', 'claude.exe'),
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), '.claude', 'local', 'claude.exe'),
    // The npm global install, which is the one an ordinary process can always
    // reach: %APPDATA%\npm is on PATH and owned by the user.
    join(appData, 'npm', 'claude.cmd'),
    join(appData, 'npm', 'claude.exe'),
  ]) {
    if (existsSync(p)) out.push({ path: p, source: 'standalone install' });
  }

  // Last resort: whatever is on PATH. Also a process, so also awaited.
  try {
    const { stdout } = await run('where', ['claude'], {
      encoding: 'utf-8', timeout: 10000, windowsHide: true,
    });
    for (const p of String(stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
      if (!existsSync(p)) continue;
      const resolved = resolveShim(p);
      if (resolved) out.push({ path: resolved.path, source: 'PATH', shell: resolved.shell });
      else note('PATH', p, 'not something Node can start directly (npm shim without a binary beside it)');
    }
  } catch (err: unknown) {
    note('PATH', 'where claude', err instanceof Error ? err.message.split('\n')[0] : String(err));
  }

  return out;
}

/**
 * Locate Claude Code, or null. Cached — the answer only changes on install.
 *
 * ASYNC on purpose. Every probe here runs a process, and this file is imported
 * by a route handler inside the Next server, where the synchronous form would
 * stall the WHOLE server — every other request, including a solve the user is
 * watching — for as long as the probe takes. src/lib/wsl.ts carries the same
 * lesson: an eight-second index build had to be moved off the synchronous path
 * for exactly this reason.
 */
export async function findClaude(
  options: { force?: boolean; explicitPath?: string } = {},
): Promise<ClaudeInstall | null> {
  // A path the user just typed must never be answered from the cache.
  if (options.force || (options.explicitPath && options.explicitPath !== lastExplicitPath)) forgetClaude();
  lastExplicitPath = options.explicitPath || '';
  // Only a success is cached. A FAILURE must not be, and that is the whole
  // point: the previous version stored `null` and returned it forever, so one
  // slow probe at startup left the app insisting Claude Code was not installed
  // for the rest of its life — with a "Look again" button that re-read the same
  // cached no. A wrong yes is impossible; a wrong no was permanent.
  if (cachedInstall) return cachedInstall;
  if (installProbe) return installProbe;

  installProbe = (async () => {
    const attempts: ProbeAttempt[] = [];
    for (const c of await candidatePaths(lastExplicitPath)) {
      try {
        const { stdout } = await run(...versionCommand(c.path, Boolean(c.shell)));
        cachedInstall = {
          path: c.path, version: String(stdout).trim(), source: c.source, shell: Boolean(c.shell),
        };
        lastProbe = [];
        return cachedInstall;
      } catch (err: unknown) {
        // Kept, not swallowed: this list is what the panel shows the user.
        attempts.push({
          path: c.path,
          source: c.source,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (!attempts.length) {
      // Nothing was even worth running. The notes say what the search saw,
      // which is the difference between "not installed" and "looked in the
      // wrong place".
      attempts.push({
        path: '',
        source: 'search',
        error: 'no claude.exe in %APPDATA%\\Claude\\claude-code, in the usual standalone locations, or on PATH',
      });
      attempts.push(...searchNotes);
    }
    lastProbe = attempts;
    return null;
  })();

  try { return await installProbe; } finally { installProbe = null; }
}

/**
 * `execFile` arguments for asking a candidate its version.
 *
 * A shim has to go through a shell, and a shell needs the path quoted — the
 * user's profile has a space in it, and `C:\Users\Tommaso Ferrara\...` without
 * quotes is two arguments.
 */
function versionCommand(path: string, shell: boolean): [string, string[], Record<string, unknown>] {
  return [
    shell ? `"${path}"` : path,
    ['--version'],
    { encoding: 'utf-8', timeout: PROBE_TIMEOUT_MS, windowsHide: true, env: childEnv(), shell },
  ];
}

/**
 * The install as already resolved, without probing for it.
 *
 * Used where a process is about to be launched and blocking is not an option.
 * The route resolves the install before it reaches that point, so the cache is
 * warm by then.
 */
export function knownClaude(): ClaudeInstall | null {
  return cachedInstall ?? null;
}

/** Forget the cached lookup — used after a login, or when the panel retries. */
export function forgetClaude(): void {
  cachedInstall = undefined;
  cachedAuth = null;
}

/**
 * The environment a child gets.
 *
 * Anything inherited that names Claude or Anthropic is REMOVED. Two reasons,
 * both real: during development this app may itself be started from a Claude
 * Code session, whose CLAUDE_CODE_* variables point the child at its parent's
 * session and auth; and ANTHROPIC_API_KEY in the user's environment would
 * silently bill the API for what the user asked to run on their subscription.
 */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key.startsWith('ANTHROPIC_')) {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

// ── Authentication ──────────────────────────────────────────────────────────

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
  orgName?: string;
}

/**
 * Ask the CLI who it is logged in as.
 *
 * Cached for a few seconds, because the panel asks whenever it opens and each
 * call is a process launch. Signing in or out clears the cache, so the panel
 * never shows a stale identity right after the user changed it.
 */
let cachedAuth: { at: number; value: AuthStatus } | null = null;
const AUTH_TTL_MS = 15000;

export async function authStatus(): Promise<AuthStatus> {
  if (cachedAuth && Date.now() - cachedAuth.at < AUTH_TTL_MS) return cachedAuth.value;

  const install = await findClaude();
  if (!install) return { loggedIn: false };

  const remember = (value: AuthStatus) => {
    cachedAuth = { at: Date.now(), value };
    return value;
  };

  try {
    const { stdout } = await run(
      install.shell ? `"${install.path}"` : install.path,
      ['auth', 'status'],
      { encoding: 'utf-8', timeout: PROBE_TIMEOUT_MS, windowsHide: true, env: childEnv(), shell: install.shell },
    );
    return remember(JSON.parse(String(stdout)) as AuthStatus);
  } catch (err: unknown) {
    // A logged-out CLI exits 1 but still prints the JSON on stdout.
    const stdout = (err as { stdout?: string })?.stdout;
    if (typeof stdout === 'string' && stdout.trim().startsWith('{')) {
      try { return remember(JSON.parse(stdout) as AuthStatus); } catch { /* fall through */ }
    }
    return remember({ loggedIn: false });
  }
}

/**
 * The sign-in flow, driven from the app.
 *
 * `claude auth login --claudeai` opens the browser itself and prints the URL it
 * opened; if the browser session is already signed in, the callback completes
 * on its own. Otherwise it waits on stdin for the code the page shows, which is
 * why the process is kept and `submitLoginCode` exists.
 *
 * One at a time — a second attempt replaces the first.
 */
interface PendingLogin {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  url: string;
  done: boolean;
  ok: boolean;
}
let pendingLogin: PendingLogin | null = null;

export function loginState(): { running: boolean; url: string; output: string; done: boolean; ok: boolean } {
  if (!pendingLogin) return { running: false, url: '', output: '', done: false, ok: false };
  return {
    running: !pendingLogin.done,
    url: pendingLogin.url,
    output: pendingLogin.lines.join('\n'),
    done: pendingLogin.done,
    ok: pendingLogin.ok,
  };
}

export async function startLogin(): Promise<{ started: boolean; error?: string }> {
  const install = await findClaude();
  if (!install) return { started: false, error: 'Claude Code is not installed on this machine' };
  if (pendingLogin && !pendingLogin.done) return { started: true };

  const child = spawn(
    install.shell ? `"${install.path}"` : install.path,
    ['auth', 'login', '--claudeai'],
    { env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: install.shell },
  );
  const state: PendingLogin = { child, lines: [], url: '', done: false, ok: false };
  pendingLogin = state;

  const absorb = (chunk: Buffer) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t) state.lines.push(t);
      const match = t.match(/https:\/\/\S+/);
      if (match && !state.url) state.url = match[0];
      if (/login successful/i.test(t)) { state.ok = true; }
    }
    if (state.lines.length > 60) state.lines.splice(0, state.lines.length - 60);
  };
  child.stdout.on('data', absorb);
  child.stderr.on('data', absorb);
  child.on('exit', code => {
    state.done = true;
    if (code === 0) state.ok = true;
    forgetClaude();
  });
  child.on('error', err => {
    state.done = true;
    state.lines.push(String(err?.message || err));
  });

  return { started: true };
}

/** Forward the code from the OAuth page to the waiting login process. */
export function submitLoginCode(code: string): boolean {
  if (!pendingLogin || pendingLogin.done) return false;
  try {
    pendingLogin.child.stdin.write(code.trim() + '\n');
    return true;
  } catch {
    return false;
  }
}

export async function logout(): Promise<boolean> {
  const install = await findClaude();
  if (!install) return false;
  try {
    await run(
      install.shell ? `"${install.path}"` : install.path,
      ['auth', 'logout'],
      { encoding: 'utf-8', timeout: PROBE_TIMEOUT_MS, windowsHide: true, env: childEnv(), shell: install.shell },
    );
    return true;
  } catch {
    return false;
  } finally {
    // Whatever happened, the cached identity is no longer trustworthy.
    forgetClaude();
  }
}

// ── Sessions ────────────────────────────────────────────────────────────────

/** What the UI is told. Deliberately small — the panel renders these directly. */
export type AgentEventOut =
  | { t: 'ready'; model: string; tools: string[]; claudeSessionId: string }
  | { t: 'block_start'; channel: 'text' | 'thinking' }
  | { t: 'delta'; channel: 'text' | 'thinking'; text: string }
  | { t: 'block_end'; channel: 'text' | 'thinking'; text: string }
  | { t: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { t: 'tool_result'; id: string; ok: boolean; text: string }
  | { t: 'done'; ok: boolean; text: string; turns: number; durationMs: number; costUsd: number }
  | { t: 'error'; message: string };

/**
 * The models offered in the panel.
 *
 * Aliases, not pinned ids: `opus` follows the newest Opus the user's plan gives
 * them, so this list does not go stale when a model is superseded. `effort`
 * records whether the model accepts the reasoning control — Haiku 4.5 predates
 * it and rejects the flag.
 */
export const MODELS = [
  { id: 'opus', label: 'Claude Opus', hint: 'Deepest reasoning', effort: true },
  { id: 'sonnet', label: 'Claude Sonnet', hint: 'Balanced — fast and strong', effort: true },
  { id: 'haiku', label: 'Claude Haiku', hint: 'Fastest, for simple work', effort: false },
] as const;

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

interface Session {
  id: string;
  /** The UUID Claude Code knows this conversation by, for --resume. */
  claudeSessionId: string;
  child: ChildProcessWithoutNullStreams | null;
  model: string;
  effort: Effort;
  systemPrompt: string;
  /** The user switched the guard rails off for this conversation. */
  unrestricted: boolean;
  buffer: string;
  listeners: Set<(event: AgentEventOut) => void>;
  /** A turn is in flight; a second message must wait for `done`. */
  busy: boolean;
  lastUsed: number;
  /** Set while a block is open, so a missing delta stream is still rendered. */
  openChannel: 'text' | 'thinking' | null;
  /** A turn has already completed, so --resume has something to resume. */
  hasRun: boolean;
}

const sessions = new Map<string, Session>();

/** Where the child runs. It has no filesystem tools; this is just a valid cwd. */
function workingDirectory(): string {
  const dir = join(tmpdir(), 'openfoam-studio-agent');
  try { mkdirSync(dir, { recursive: true }); } catch { /* already there */ }
  return dir;
}

/**
 * The MCP configuration handed to the agent: one server, ours.
 *
 * The bridge runs on the node that ships inside the app (the packaged exe has
 * no other), and is told the port and token through its environment.
 *
 * The dynamic paths in this file (here and in `candidatePaths`) are why
 * `next.config.ts` carries an `outputFileTracingExcludes` list — see the
 * comment there before adding another one.
 */
function mcpConfig(unrestricted: boolean): string {
  const node = process.env.OFSTUDIO_MCP_NODE || process.execPath;
  const script = process.env.OFSTUDIO_MCP_SCRIPT
    || resolve('electron', 'mcp', 'openfoam-mcp.mjs');
  return JSON.stringify({
    mcpServers: {
      openfoam: {
        command: node,
        args: [script],
        env: {
          OFSTUDIO_PORT: String(process.env.PORT || 3000),
          OFSTUDIO_AGENT_TOKEN: process.env.OFSTUDIO_AGENT_TOKEN || '',
          // The guard rails, or the absence of them. Passed HERE, in the tool
          // server's environment, so the model cannot ask for the other mode:
          // it only ever writes tool arguments.
          OFSTUDIO_AGENT_MODE: unrestricted ? 'unrestricted' : 'guarded',
        },
      },
    },
  });
}

function emit(session: Session, event: AgentEventOut): void {
  for (const listener of session.listeners) {
    try { listener(event); } catch { /* a dead listener must not stop the rest */ }
  }
}

/** Translate one line of Claude Code's stream-json into what the panel needs. */
function handleLine(session: Session, line: string): void {
  let ev: Record<string, unknown>;
  try { ev = JSON.parse(line); } catch { return; }
  const type = ev.type;

  if (type === 'system' && ev.subtype === 'init') {
    session.claudeSessionId = String(ev.session_id || session.claudeSessionId);
    emit(session, {
      t: 'ready',
      model: String(ev.model || session.model),
      tools: Array.isArray(ev.tools) ? (ev.tools as string[]) : [],
      claudeSessionId: session.claudeSessionId,
    });
    return;
  }

  // Live typing. The authoritative text arrives with the `assistant` event
  // below and replaces what was streamed, so a dropped delta cannot corrupt
  // the transcript — it only makes the block appear all at once.
  if (type === 'stream_event') {
    const inner = ev.event as Record<string, unknown> | undefined;
    if (!inner) return;
    if (inner.type === 'content_block_start') {
      const block = inner.content_block as { type?: string } | undefined;
      if (block?.type === 'text' || block?.type === 'thinking') {
        session.openChannel = block.type;
        emit(session, { t: 'block_start', channel: block.type });
      }
      return;
    }
    if (inner.type === 'content_block_delta') {
      const delta = inner.delta as { type?: string; text?: string; thinking?: string } | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        emit(session, { t: 'delta', channel: 'text', text: delta.text });
      } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        emit(session, { t: 'delta', channel: 'thinking', text: delta.thinking });
      }
      return;
    }
    return;
  }

  if (type === 'assistant') {
    const message = ev.message as { content?: unknown[] } | undefined;
    for (const raw of message?.content || []) {
      const block = raw as { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };
      if (block.type === 'text' && typeof block.text === 'string') {
        emit(session, { t: 'block_end', channel: 'text', text: block.text });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        emit(session, { t: 'block_end', channel: 'thinking', text: block.thinking });
      } else if (block.type === 'tool_use') {
        emit(session, {
          t: 'tool_use',
          id: String(block.id || ''),
          // Strip the MCP prefix: the panel shows "run_openfoam", not
          // "mcp__openfoam__run_openfoam".
          name: String(block.name || '').replace(/^mcp__openfoam__/, ''),
          input: (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>,
        });
      }
    }
    session.openChannel = null;
    return;
  }

  // Tool results come back as a synthetic user turn.
  if (type === 'user') {
    const message = ev.message as { content?: unknown[] } | undefined;
    for (const raw of message?.content || []) {
      const block = raw as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
      if (block.type !== 'tool_result') continue;
      let text = '';
      if (typeof block.content === 'string') text = block.content;
      else if (Array.isArray(block.content)) {
        text = block.content
          .map(c => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
          .join('\n');
      }
      emit(session, {
        t: 'tool_result',
        id: String(block.tool_use_id || ''),
        ok: block.is_error !== true,
        text,
      });
    }
    return;
  }

  if (type === 'result') {
    session.busy = false;
    emit(session, {
      t: 'done',
      ok: ev.is_error !== true,
      text: typeof ev.result === 'string' ? ev.result : '',
      turns: Number(ev.num_turns) || 0,
      durationMs: Number(ev.duration_ms) || 0,
      costUsd: Number(ev.total_cost_usd) || 0,
    });
  }
}

function spawnChild(session: Session, resume: boolean): { ok: true } | { ok: false; error: string } {
  const install = knownClaude();
  if (!install) return { ok: false, error: 'Claude Code is not installed on this machine' };

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', session.model,
    // Every built-in tool off; ours are the only ones left.
    '--tools', '',
    '--mcp-config', mcpConfig(session.unrestricted),
    // Without this the session inherits the user's claude.ai connectors.
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--permission-mode', 'bypassPermissions',
    '--append-system-prompt', session.systemPrompt,
  ];
  // Haiku 4.5 predates the effort control and rejects it.
  if (MODELS.find(m => m.id === session.model)?.effort) {
    args.push('--effort', session.effort);
  }
  if (resume) args.push('--resume', session.claudeSessionId);
  else args.push('--session-id', session.claudeSessionId);

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(install.shell ? `"${install.path}"` : install.path, args, {
      cwd: workingDirectory(),
      env: childEnv(),
      // Never let a console window flash on the user's desktop.
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: install.shell,
    });
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'could not start Claude Code' };
  }

  session.child = child;
  session.buffer = '';

  child.stdout.on('data', (chunk: Buffer) => {
    session.buffer += chunk.toString();
    let index: number;
    while ((index = session.buffer.indexOf('\n')) >= 0) {
      const line = session.buffer.slice(0, index).trim();
      session.buffer = session.buffer.slice(index + 1);
      if (line) handleLine(session, line);
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.error('[agent]', text.slice(0, 500));
  });

  child.on('exit', (code, signal) => {
    // A process we have already replaced must not touch the session it no
    // longer belongs to. Changing the model, the effort or the mode stops the
    // old child and starts a new one immediately, and the old one's exit
    // arrives AFTER that — it used to null out the new child and report
    // "stopped unexpectedly (exit 0)" (or "exit null", when the exit came from
    // kill()) on a turn that had only just begun. That is the spurious error
    // the user was seeing and having to resend past.
    if (session.child !== child) return;

    session.child = null;
    if (session.busy) {
      session.busy = false;
      emit(session, {
        t: 'error',
        message: 'Claude Code stopped unexpectedly '
          + `(${signal ? `signal ${signal}` : `exit ${code}`}). The next message starts it again.`,
      });
      emit(session, { t: 'done', ok: false, text: '', turns: 0, durationMs: 0, costUsd: 0 });
    }
  });

  child.on('error', err => {
    if (session.child !== child) return;        // same reason as the exit handler
    session.child = null;
    emit(session, { t: 'error', message: String(err?.message || err) });
  });

  return { ok: true };
}

export interface SendOptions {
  sessionId: string;
  message: string;
  model: string;
  effort: Effort;
  systemPrompt: string;
  unrestricted: boolean;
}

/**
 * Send one message and stream what comes back.
 *
 * The child is reused across turns. It is restarted only when the model or the
 * effort changed (both are launch flags) — and then with `--resume`, so the
 * conversation survives the restart.
 */
export function send(
  options: SendOptions,
  listener: (event: AgentEventOut) => void,
): { ok: true } | { ok: false; error: string } {
  let session = sessions.get(options.sessionId);

  if (!session) {
    session = {
      id: options.sessionId,
      claudeSessionId: randomUUID(),
      child: null,
      model: options.model,
      effort: options.effort,
      systemPrompt: options.systemPrompt,
      unrestricted: options.unrestricted,
      buffer: '',
      listeners: new Set(),
      busy: false,
      lastUsed: Date.now(),
      openChannel: null,
      hasRun: false,
    };
    sessions.set(options.sessionId, session);
  }

  if (session.busy) return { ok: false, error: 'the agent is still working on the previous message' };

  // All of these are LAUNCH-time properties of the child, the mode included —
  // it lives in the tool server's environment. Changing any of them restarts
  // the process, with --resume, so the conversation survives the switch.
  const settingsChanged = session.model !== options.model
    || session.effort !== options.effort
    || session.unrestricted !== options.unrestricted
    || session.systemPrompt !== options.systemPrompt;
  /**
   * The mode changed under a conversation that has already run.
   *
   * The restart gives the agent the new tool descriptions and system prompt,
   * but NOT a reason to revise what it already said. Observed: after refusing
   * to delete a file in guarded mode, it went on refusing once the limits were
   * lifted — its own earlier "I can't delete files" was still the most
   * authoritative thing in its context. So the change is announced.
   */
  const modeChanged = session.hasRun && session.unrestricted !== options.unrestricted;

  const hadChild = session.child !== null;
  if (settingsChanged && hadChild) {
    stopChild(session);
  }
  session.model = options.model;
  session.effort = options.effort;
  session.systemPrompt = options.systemPrompt;
  session.unrestricted = options.unrestricted;

  session.listeners.add(listener);
  session.lastUsed = Date.now();

  if (!session.child) {
    // Resume only if this conversation has already run once — a fresh UUID has
    // nothing to resume and Claude Code would refuse it.
    const started = spawnChild(session, session.hasRun);
    if (!started.ok) {
      session.listeners.delete(listener);
      return started;
    }
  }

  session.busy = true;
  session.hasRun = true;
  const notice = modeChanged
    ? (options.unrestricted
      ? '[The user has just switched this conversation to UNRESTRICTED mode. Your run_openfoam tool '
        + 'is now a real shell: deleting, moving, pipes, redirects and chaining all work. Anything '
        + 'you said earlier about not being able to do those things no longer applies.]\n\n'
      : '[The user has just switched this conversation back to GUARDED mode. run_openfoam now accepts '
        + 'only the OpenFOAM executables this installation ships, one per call, with no shell syntax. '
        + 'Anything you did earlier with a shell is no longer available.]\n\n')
    : '';

  try {
    session.child!.stdin.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: notice + options.message }] },
    }) + '\n');
  } catch (err: unknown) {
    session.busy = false;
    session.listeners.delete(listener);
    return { ok: false, error: err instanceof Error ? err.message : 'could not reach Claude Code' };
  }

  return { ok: true };
}

export function unsubscribe(sessionId: string, listener: (event: AgentEventOut) => void): void {
  sessions.get(sessionId)?.listeners.delete(listener);
}

function stopChild(session: Session): void {
  const child = session.child;
  session.child = null;
  session.busy = false;
  if (!child) return;
  try { child.stdin.end(); } catch { /* already gone */ }
  // stdin.end() is the graceful exit; make sure it does not linger.
  setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 2000);
}

/** Stop the current turn without losing the conversation. */
export function interrupt(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session?.child) return false;
  try {
    session.child.stdin.write(JSON.stringify({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' },
    }) + '\n');
    return true;
  } catch {
    stopChild(session);
    return true;
  }
}

/** End a conversation: the next message starts a new one. */
export function endSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  stopChild(session);
  session.listeners.clear();
  sessions.delete(sessionId);
}

export function sessionInfo(sessionId: string): { running: boolean; busy: boolean } {
  const session = sessions.get(sessionId);
  return { running: Boolean(session?.child), busy: Boolean(session?.busy) };
}

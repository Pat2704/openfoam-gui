'use client';

/**
 * Claude, inside the app.
 *
 * FOAMy is a copilot: it answers, proposes a file, and the user clicks Apply.
 * This is an AGENT — it reads the case, writes the files and runs OpenFOAM
 * itself, through the tools in src/lib/agent-policy.ts. So the two panels are
 * deliberately different objects and neither replaces the other: same shape of
 * window (draggable, resizable, floating launcher), different conversation.
 *
 * The layout follows Claude Desktop rather than a chat widget: the assistant's
 * text sits plainly on the page instead of in a bubble, the user's turn is the
 * only thing in a bubble, thinking and tool calls are collapsible rows in the
 * flow, and the model and reasoning controls live INSIDE the composer, where
 * Claude Desktop puts them.
 *
 * It talks to /api/agent over SSE, because one turn is a sequence of events
 * spread over minutes (thinking → tool → result → text), not a single reply.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  X, Send, Trash2, Loader2, GripHorizontal, Check, Copy, ChevronDown, ChevronRight,
  Square, AlertCircle, ExternalLink, LogOut, LogIn, UserRound, Sparkles, Wrench, FolderOpen,
  Shield, ShieldOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCaseContext } from '@/lib/case-context';
import { toast } from 'sonner';
import { loadFoamyConfig, patchFoamyConfig } from '@/lib/foamy-store';
import { LAUNCHER_Z, bringToFront, isFront } from '@/lib/floating-order';

// ── Claude's mark ───────────────────────────────────────────────────────────

/**
 * The Claude burst, drawn rather than shipped as an asset.
 *
 * Twelve rays around a centre, the shorter ones offset between the longer —
 * built in code so it stays crisp at every size the panel uses (16 px in a
 * message, 28 px in the launcher) with no bitmap to scale.
 */
/**
 * Rounded to three decimals, and computed ONCE at module scope.
 *
 * Not cosmetic: raw `Math.cos` output serialises differently on the server and
 * in the browser (…016046 against …0160461), which React reports as a
 * hydration mismatch on every page load. Fixed-width strings are identical on
 * both sides.
 */
const CLAUDE_RAYS = Array.from({ length: 12 }, (_, i) => {
  const angle = (i * 30 * Math.PI) / 180;
  const long = i % 2 === 0;
  const inner = 2.6;
  const outer = long ? 10.4 : 8.2;
  const at = (radius: number, fn: (n: number) => number) => (12 + fn(angle) * radius).toFixed(3);
  return {
    x1: at(inner, Math.cos), y1: at(inner, Math.sin),
    x2: at(outer, Math.cos), y2: at(outer, Math.sin),
    w: long ? 2.5 : 1.9,
  };
});

function ClaudeMark({ className = '', color = 'currentColor' }: { className?: string; color?: string }) {
  const rays = CLAUDE_RAYS;
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      {rays.map((r, i) => (
        <line
          key={i}
          x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2}
          stroke={color} strokeWidth={r.w} strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

// ── Conversation model ──────────────────────────────────────────────────────

type Block =
  | { kind: 'text'; text: string; live: boolean }
  | { kind: 'thinking'; text: string; live: boolean }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; status: 'running' | 'ok' | 'error'; result: string };

interface Turn {
  role: 'user' | 'assistant';
  text?: string;
  blocks?: Block[];
  /** Set on the assistant turn when the run ended badly. */
  error?: string;
  meta?: { durationMs: number; turns: number };
}

interface AgentStatus {
  installed: boolean;
  path: string;
  version: string;
  source: string;
  auth: { loggedIn: boolean; email?: string; subscriptionType?: string; authMethod?: string };
  commands: number;
  indexReady: boolean;
  corpusReady: boolean;
  /** Filled only when Claude Code was NOT found: what was tried, and why each failed. */
  probe?: { path: string; source: string; error: string }[];
}

const MODELS = [
  { id: 'opus', label: 'Claude Opus', hint: 'Deepest reasoning', effort: true },
  { id: 'sonnet', label: 'Claude Sonnet', hint: 'Balanced — fast and strong', effort: true },
  { id: 'haiku', label: 'Claude Haiku', hint: 'Fastest, for simple work', effort: false },
];

const EFFORTS = [
  { id: 'low', label: 'Low', hint: 'Answer quickly, little deliberation' },
  { id: 'medium', label: 'Medium', hint: 'Some thinking on harder steps' },
  { id: 'high', label: 'High', hint: 'The default — thorough' },
  { id: 'xhigh', label: 'Extra high', hint: 'Best for long agentic work' },
  { id: 'max', label: 'Max', hint: 'When correctness matters more than time' },
];

/** A one-line summary of a tool call, in the terms the user thinks in. */
function describeTool(name: string, input: Record<string, unknown>): string {
  const c = typeof input.case === 'string' ? input.case : '';
  const p = typeof input.path === 'string' ? input.path : '';
  switch (name) {
    case 'list_cases': return 'the cases in the run directory';
    case 'case_info': return c;
    case 'list_case_files': return [c, p].filter(Boolean).join('/');
    case 'read_case_file': return `${c}/${p}`;
    case 'write_case_file': return `${c}/${p}`;
    case 'run_openfoam': return `${typeof input.command === 'string' ? input.command : ''} in ${c}`;
    case 'validate_case_files': return Array.isArray(input.paths) ? (input.paths as string[]).join(', ') : c;
    case 'foam_lookup': return String(input.name || input.kind || '');
    case 'search_tutorials': return String(input.query || '');
    default: return '';
  }
}

const TOOL_VERB: Record<string, string> = {
  list_cases: 'Listing cases',
  case_info: 'Inspecting case',
  list_case_files: 'Listing files',
  read_case_file: 'Reading',
  write_case_file: 'Writing',
  run_openfoam: 'Running',
  validate_case_files: 'Validating',
  foam_lookup: 'Checking against the installation',
  search_tutorials: 'Searching the tutorials',
};

export default function ClaudePanel() {
  const { caseName } = useCaseContext();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [sessionId] = useState(() => `claude-${Date.now()}`);

  const [status, setStatus] = useState<AgentStatus | null>(null);
  /**
   * Where Claude Code is, when the app cannot work it out.
   *
   * Needed because the automatic search only knows the standard locations, and
   * on at least one machine none of them were reachable by an ordinary process
   * — the panel was then a dead end with no way for the user to correct it.
   */
  const [claudePath, setClaudePath] = useState('');
  const [pathDraft, setPathDraft] = useState('');
  /**
   * The guard rails, off.
   *
   * Off by default and asked about before it goes on, because it is the one
   * control here that changes what the agent can destroy. Turning it either way
   * restarts the agent process — the mode lives in that process's environment,
   * which is what stops the model from granting it to itself.
   */
  const [unrestricted, setUnrestricted] = useState(false);
  const [model, setModel] = useState('sonnet');
  const [effort, setEffort] = useState('high');
  const [menu, setMenu] = useState<'model' | 'effort' | 'account' | null>(null);

  // Sign-in
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginUrl, setLoginUrl] = useState('');
  const [loginCode, setLoginCode] = useState('');
  /**
   * Shown IN the panel, not only as a toast.
   *
   * A toast was the only report of a failed sign-in, and the app's toasts were
   * not being displayed at all — so the button genuinely did nothing visible.
   * The toasts work now, but the message that explains why the panel is unusable
   * belongs in the panel, where the user is already looking.
   */
  const [loginError, setLoginError] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Persisted choices ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfg = await loadFoamyConfig();
      if (cancelled) return;
      if (cfg['claude-agent-model']) setModel(cfg['claude-agent-model']);
      if (cfg['claude-agent-effort']) setEffort(cfg['claude-agent-effort']);
      if (cfg['claude-agent-path']) { setClaudePath(cfg['claude-agent-path']); setPathDraft(cfg['claude-agent-path']); }
      setUnrestricted(cfg['claude-agent-unrestricted'] === 'on');
    })();
    return () => { cancelled = true; };
  }, []);

  const chooseModel = useCallback((id: string) => {
    setModel(id);
    setMenu(null);
    void patchFoamyConfig({ 'claude-agent-model': id });
  }, []);

  /**
   * One click, no dialog.
   *
   * There used to be a confirmation here. The user asked for it to go: the
   * button is deliberate enough on its own, its state is legible at a glance,
   * and every call it permits is listed in the conversation as it happens.
   */
  const toggleUnrestricted = useCallback(() => {
    const next = !unrestricted;
    setUnrestricted(next);
    void patchFoamyConfig({ 'claude-agent-unrestricted': next ? 'on' : 'off' });
    toast.info(next ? 'Unrestricted — Claude can run any command' : 'Back to OpenFOAM commands only');
  }, [unrestricted]);

  const chooseEffort = useCallback((id: string) => {
    setEffort(id);
    setMenu(null);
    void patchFoamyConfig({ 'claude-agent-effort': id });
  }, []);

  // ── Status ──
  const [statusError, setStatusError] = useState('');
  const [checking, setChecking] = useState(false);

  /**
   * Ask the server what it can see.
   *
   * `force` is what the "Look again" button sends: without it the server may
   * answer from a remembered result, which is exactly the trap that made the
   * button useless before.
   *
   * A failed REQUEST is kept apart from a missing INSTALLATION. They used to be
   * the same thing here — any error response was stored as the status, and
   * since it had no `installed` field the panel confidently announced that
   * Claude Code was not installed, whatever had actually gone wrong.
   */
  const refreshStatus = useCallback(async (force = false) => {
    setChecking(true);
    try {
      const res = await fetch(
        `/api/agent?action=status${force ? '&refresh=1' : ''}`
        + (claudePath ? `&path=${encodeURIComponent(claudePath)}` : ''),
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || typeof data.installed !== 'boolean') {
        setStatusError(data?.error || `The app could not answer (HTTP ${res.status}).`);
        return;
      }
      setStatusError('');
      setStatus(data);
    } catch {
      setStatusError('Could not reach the app’s own server.');
    } finally {
      setChecking(false);
    }
  }, [claudePath]);

  useEffect(() => { if (open) void refreshStatus(); }, [open, refreshStatus]);

  // ── Window geometry (same behaviour as the FOAMy popup) ──
  const [winPos, setWinPos] = useState({ left: 0, top: 0 });
  const [size, setSize] = useState({ w: 520, h: 620 });
  // Shared with the FOAMy popup — see src/lib/floating-order.ts.
  const [z, setZ] = useState(LAUNCHER_Z + 1);
  const raise = useCallback(() => { if (!isFront(z)) setZ(bringToFront()); }, [z]);
  const isDragging = useRef<string | null>(null);
  const isResizing = useRef(false);
  const dragStart = useRef({ mx: 0, my: 0, left: 0, top: 0 });
  const resizeStart = useRef({ mx: 0, my: 0, w: 0, h: 0 });

  const btnRef = useRef<HTMLButtonElement>(null);
  const btnPosRef = useRef({ left: 0, top: 0 });
  const btnInitialized = useRef(false);

  /**
   * Park the launcher at the bottom right — above FOAMy's, which sits at
   * innerHeight - 86.
   *
   * Guarded, because the viewport can still be 0×0 when this first runs (a
   * hidden or not-yet-laid-out window), and `innerWidth - 86` is then -86:
   * the button exists, is "visible" to the DOM, and is nowhere on screen.
   * So placing is retried until the viewport is real, and repeated on resize
   * whenever the button would otherwise be left outside the window.
   */
  useEffect(() => {
    const place = (force: boolean) => {
      const button = btnRef.current;
      if (!button) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (vw < 100 || vh < 100) return;          // not laid out yet; try later
      const { left, top } = btnPosRef.current;
      const outside = left > vw - 56 || top > vh - 56 || left < 0 || top < 0;
      if (!force && btnInitialized.current && !outside) return;
      const x = Math.max(0, vw - 86);
      const y = Math.max(0, vh - 156);
      btnPosRef.current = { left: x, top: y };
      button.style.transform = `translate(${x}px, ${y}px)`;
      btnInitialized.current = true;
    };

    place(false);
    // One rAF covers the common case of a viewport that is measured a tick late.
    const frame = requestAnimationFrame(() => place(false));
    const onResize = () => place(false);
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const handleOpen = useCallback(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(size.w, vw - 40);
    const h = Math.min(size.h, vh - 40);
    setWinPos({ left: vw - w - 24, top: Math.max(12, vh - h - 24) });
    setSize({ w, h });
    setZ(bringToFront());
    setOpen(true);
  }, [size]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (isDragging.current === 'button' && btnRef.current) {
        const dx = e.clientX - dragStart.current.mx;
        const dy = e.clientY - dragStart.current.my;
        const left = Math.max(0, Math.min(dragStart.current.left + dx, window.innerWidth - 56));
        const top = Math.max(0, Math.min(dragStart.current.top + dy, window.innerHeight - 56));
        btnPosRef.current = { left, top };
        btnRef.current.style.transform = `translate(${left}px, ${top}px)`;
        return;
      }
      if (isDragging.current === 'window') {
        const dx = e.clientX - dragStart.current.mx;
        const dy = e.clientY - dragStart.current.my;
        setWinPos({
          left: Math.max(0, Math.min(dragStart.current.left + dx, window.innerWidth - 60)),
          top: Math.max(0, Math.min(dragStart.current.top + dy, window.innerHeight - 60)),
        });
        return;
      }
      if (isResizing.current) {
        const dx = e.clientX - resizeStart.current.mx;
        const dy = e.clientY - resizeStart.current.my;
        setSize({
          w: Math.max(360, Math.min(resizeStart.current.w + dx, window.innerWidth - winPos.left - 10)),
          h: Math.max(340, Math.min(resizeStart.current.h + dy, window.innerHeight - winPos.top - 10)),
        });
      }
    };
    const onUp = () => {
      isDragging.current = null;
      isResizing.current = false;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [winPos]);

  const onBtnMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStart.current = { mx: e.clientX, my: e.clientY, left: btnPosRef.current.left, top: btnPosRef.current.top };
    isDragging.current = 'button';
    document.body.style.userSelect = 'none';
  }, []);

  const onWinDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStart.current = { mx: e.clientX, my: e.clientY, left: winPos.left, top: winPos.top };
    isDragging.current = 'window';
    document.body.style.userSelect = 'none';
  }, [winPos]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeStart.current = { mx: e.clientX, my: e.clientY, w: size.w, h: size.h };
    isResizing.current = true;
    document.body.style.userSelect = 'none';
  }, [size]);

  // Auto-scroll unless the user has scrolled up to read something.
  const stickToBottom = useRef(true);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);
  useEffect(() => {
    if (stickToBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  });

  useEffect(() => {
    if (!open || !inputRef.current) return;
    // Cleared on close. Without it, opening and immediately closing the panel
    // still fired 100 ms later and pulled keyboard focus into an input the user
    // could no longer see — so the next thing they typed went nowhere visible.
    const id = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  // ── Applying one streamed event to the transcript ──
  const apply = useCallback((event: Record<string, unknown>) => {
    const t = event.t;
    setTurns(prev => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (!last || last.role !== 'assistant') return next;
      const blocks = [...(last.blocks || [])];

      const closeLive = () => {
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if ((b.kind === 'text' || b.kind === 'thinking') && b.live) { blocks[i] = { ...b, live: false }; break; }
        }
      };

      if (t === 'block_start') {
        blocks.push({ kind: event.channel as 'text' | 'thinking', text: '', live: true });
      } else if (t === 'delta') {
        const channel = event.channel as 'text' | 'thinking';
        const i = blocks.findIndex(b => (b.kind === channel) && b.live);
        if (i >= 0) {
          const b = blocks[i] as { kind: 'text' | 'thinking'; text: string; live: boolean };
          blocks[i] = { ...b, text: b.text + String(event.text || '') };
        } else {
          blocks.push({ kind: channel, text: String(event.text || ''), live: true });
        }
      } else if (t === 'block_end') {
        // The authoritative text of the block. It replaces whatever the deltas
        // built, so a dropped delta cannot leave a half-written paragraph.
        const channel = event.channel as 'text' | 'thinking';
        const i = blocks.findIndex(b => b.kind === channel && b.live);
        if (i >= 0) blocks[i] = { kind: channel, text: String(event.text || ''), live: false };
        else blocks.push({ kind: channel, text: String(event.text || ''), live: false });
      } else if (t === 'tool_use') {
        closeLive();
        blocks.push({
          kind: 'tool',
          id: String(event.id || ''),
          name: String(event.name || ''),
          input: (event.input || {}) as Record<string, unknown>,
          status: 'running',
          result: '',
        });
      } else if (t === 'tool_result') {
        const i = blocks.findIndex(b => b.kind === 'tool' && b.id === event.id);
        if (i >= 0) {
          const b = blocks[i] as Extract<Block, { kind: 'tool' }>;
          blocks[i] = { ...b, status: event.ok === false ? 'error' : 'ok', result: String(event.text || '') };
        }
      } else if (t === 'error') {
        next[next.length - 1] = { ...last, blocks, error: String(event.message || '') };
        return next;
      } else if (t === 'done') {
        closeLive();
        next[next.length - 1] = {
          ...last,
          blocks,
          meta: { durationMs: Number(event.durationMs) || 0, turns: Number(event.turns) || 0 },
        };
        return next;
      }

      next[next.length - 1] = { ...last, blocks };
      return next;
    });
  }, []);

  // ── Send ──
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || running) return;

    setTurns(prev => [...prev, { role: 'user', text }, { role: 'assistant', blocks: [] }]);
    setInput('');
    setRunning(true);
    stickToBottom.current = true;

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId, message: text, model, effort,
          caseName: caseName || undefined,
          claudePath: claudePath || undefined,
          unrestricted,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        apply({ t: 'error', message: data?.error || `The agent could not start (HTTP ${res.status}).` });
        setRunning(false);
        void refreshStatus();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        let cut: number;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try { apply(JSON.parse(line.slice(6))); } catch { /* ignore a bad frame */ }
          }
        }
      }
    } catch (err: unknown) {
      if ((err as { name?: string })?.name !== 'AbortError') {
        apply({ t: 'error', message: 'Lost the connection to the app while the agent was working.' });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [input, running, sessionId, model, effort, caseName, claudePath, unrestricted, apply, refreshStatus]);

  const stop = useCallback(async () => {
    try {
      await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'interrupt', sessionId }),
      });
    } catch { /* the abort below still ends the turn on screen */ }
    abortRef.current?.abort();
    setRunning(false);
  }, [sessionId]);

  const clear = useCallback(async () => {
    abortRef.current?.abort();
    setTurns([]);
    setRunning(false);
    try {
      await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'end', sessionId }),
      });
    } catch { /* silent */ }
  }, [sessionId]);

  const savePath = useCallback(async () => {
    const next = pathDraft.trim();
    setClaudePath(next);
    await patchFoamyConfig({ 'claude-agent-path': next });
    // refreshStatus closes over the OLD value, so ask with the new one directly.
    setChecking(true);
    try {
      const res = await fetch(
        `/api/agent?action=status&refresh=1${next ? `&path=${encodeURIComponent(next)}` : ''}`,
      );
      const data = await res.json().catch(() => null);
      if (data && typeof data.installed === 'boolean') {
        setStatus(data);
        setStatusError('');
        if (data.installed) toast.success(`Found Claude Code ${data.version}`);
      }
    } catch { /* the panel keeps showing what it had */ } finally {
      setChecking(false);
    }
  }, [pathDraft]);

  // ── Sign-in ──
  const signIn = useCallback(async () => {
    setLoggingIn(true);
    setLoginUrl('');
    setLoginError('');
    try {
      const res = await fetch('/api/agent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'login', claudePath: claudePath || undefined }),
      });
      const data = await res.json();
      if (!data?.started) {
        const message = data?.error || 'Could not start the sign-in.';
        setLoginError(message);
        toast.error(message);
        setLoggingIn(false);
        return;
      }
      // Poll: the CLI opens the browser itself and finishes on its own when the
      // browser is already signed in; otherwise it waits for the code.
      for (let i = 0; i < 150; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const state = await fetch('/api/agent?action=login').then(r => r.json()).catch(() => null);
        if (state?.url) setLoginUrl(state.url);
        if (state?.done) {
          setLoggingIn(false);
          await refreshStatus(true);
          const fresh = await fetch('/api/agent?action=status').then(r => r.json()).catch(() => null);
          if (fresh?.auth?.loggedIn) {
            toast.success(`Signed in as ${fresh.auth.email || 'your Claude account'}`);
          } else {
            const message = 'The sign-in did not complete. Check the browser window that opened.';
            setLoginError(message);
            toast.error(message);
          }
          return;
        }
      }
      setLoggingIn(false);
    } catch {
      const message = 'Could not start the sign-in.';
      setLoginError(message);
      toast.error(message);
      setLoggingIn(false);
    }
  }, [refreshStatus, claudePath]);

  const submitCode = useCallback(async () => {
    const code = loginCode.trim();
    if (!code) return;
    setLoginCode('');
    try {
      await fetch('/api/agent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'loginCode', code }),
      });
    } catch { toast.error('Could not send the code.'); }
  }, [loginCode]);

  const signOut = useCallback(async () => {
    await fetch('/api/agent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logout' }),
    }).catch(() => null);
    await refreshStatus();
  }, [refreshStatus]);

  const currentModel = MODELS.find(m => m.id === model) || MODELS[1];
  const ready = status?.installed && status?.auth?.loggedIn;

  return (
    <>
      {!open && (
        <button
          ref={btnRef}
          onMouseDown={onBtnMouseDown}
          onClick={(e) => {
            if (Math.abs(e.clientX - dragStart.current.mx) < 5 && Math.abs(e.clientY - dragStart.current.my) < 5) {
              handleOpen();
            }
          }}
          className="fixed w-14 h-14 rounded-full bg-[#D97757] text-white shadow-lg hover:shadow-xl hover:shadow-[#D97757]/30 flex items-center justify-center cursor-grab active:cursor-grabbing transition-[box-shadow,filter] duration-150 hover:brightness-105"
          style={{ left: 0, top: 0, zIndex: LAUNCHER_Z, transform: `translate(${btnPosRef.current.left}px, ${btnPosRef.current.top}px)`, willChange: 'transform' }}
          title="Claude — agent for your cases (draggable)"
        >
          <ClaudeMark className="w-7 h-7" color="#ffffff" />
        </button>
      )}

      {open && (
        <div
          className="fixed flex flex-col rounded-xl border shadow-2xl overflow-hidden bg-[#FAF9F5] dark:bg-[#1F1E1B] text-foreground"
          style={{ left: winPos.left, top: winPos.top, width: size.w, height: size.h, zIndex: z }}
          // Capture, so clicking anywhere in the window raises it — including
          // on a control that stops the event before it would bubble to here.
          onMouseDownCapture={raise}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-3 py-2.5 border-b border-black/5 dark:border-white/10 cursor-grab active:cursor-grabbing select-none"
            onMouseDown={onWinDragStart}
          >
            <div className="flex items-center gap-2 min-w-0">
              <GripHorizontal className="w-4 h-4 text-muted-foreground/60 flex-shrink-0" />
              <ClaudeMark className="w-5 h-5 flex-shrink-0" color="#D97757" />
              <div className="min-w-0">
                <div className="text-sm font-semibold leading-tight">Claude</div>
                <div className="text-[10px] text-muted-foreground leading-tight flex items-center gap-1.5">
                  {caseName ? (
                    <span className="inline-flex items-center gap-1 truncate max-w-[160px]">
                      <FolderOpen className="w-2.5 h-2.5 flex-shrink-0" />{caseName}
                    </span>
                  ) : (
                    <span>Agent for your OpenFOAM cases</span>
                  )}
                  {status?.auth?.subscriptionType && (
                    <span className="uppercase tracking-wide text-[10px] px-1.5 py-px rounded bg-[#D97757]/15 text-[#B4573C] dark:text-[#E8A188] flex-shrink-0">
                      {status.auth.subscriptionType}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-0.5 flex-shrink-0" onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
              {/* Account — always here, signed in or not. */}
              <div className="relative">
                <button
                  className={`relative w-7 h-7 inline-flex items-center justify-center rounded-md transition-colors duration-150 active:bg-black/10 dark:active:bg-white/15 ${menu === 'account' ? 'bg-black/5 dark:bg-white/10 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/10'}`}
                  onClick={() => setMenu(menu === 'account' ? null : 'account')}
                  title={status?.auth?.loggedIn ? `Signed in as ${status.auth.email || 'your Claude account'}` : 'Claude account'}
                >
                  <UserRound className="w-3.5 h-3.5" />
                  {status && !status.auth?.loggedIn && (
                    <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-[#D97757]" />
                  )}
                </button>
                {menu === 'account' && (
                  <div className="absolute top-full right-0 mt-1 w-64 rounded-xl border bg-popover shadow-xl overflow-hidden z-50 text-left">
                    <div className="px-3 py-2 border-b">
                      <div className="text-[11px] font-medium truncate">
                        {status?.auth?.loggedIn ? (status.auth.email || 'Signed in') : 'Not signed in'}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {status?.auth?.loggedIn
                          ? `Claude ${status.auth.subscriptionType || 'account'} · no API key, nothing billed per message`
                          : 'The agent needs your Claude account to work'}
                      </div>
                    </div>
                    {status?.auth?.loggedIn ? (
                      <button
                        className="w-full text-left px-3 py-2 text-[11px] hover:bg-accent active:bg-accent/70 transition-colors duration-150 inline-flex items-center gap-1.5"
                        onClick={() => { setMenu(null); void signOut(); }}
                      >
                        <LogOut className="w-3 h-3" /> Sign out
                      </button>
                    ) : (
                      <button
                        className="w-full text-left px-3 py-2 text-[11px] hover:bg-accent active:bg-accent/70 transition-colors duration-150 inline-flex items-center gap-1.5 font-medium text-[#D97757] disabled:opacity-50 disabled:pointer-events-none"
                        onClick={() => { setMenu(null); void signIn(); }}
                        disabled={loggingIn}
                      >
                        {loggingIn
                          ? <><Loader2 className="w-3 h-3 animate-spin" /> Waiting for the browser…</>
                          : <><LogIn className="w-3 h-3" /> Sign in with your Claude account</>}
                      </button>
                    )}
                    <div className="px-3 py-1.5 border-t text-[10px] text-muted-foreground">
                      {status?.installed ? `Claude Code ${status.version} · ${status.source}` : 'Claude Code not found on this machine'}
                    </div>
                  </div>
                )}
              </div>
              <button
                className="w-7 h-7 inline-flex items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/10 active:bg-black/10 dark:active:bg-white/15 text-muted-foreground hover:text-foreground transition-colors duration-150"
                onClick={clear} title="New conversation"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <button
                className="w-7 h-7 inline-flex items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/10 active:bg-black/10 dark:active:bg-white/15 text-muted-foreground hover:text-foreground transition-colors duration-150"
                onClick={() => setOpen(false)} title="Close"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Conversation */}
          <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
            {!status && !statusError && (
              <div className="flex items-center justify-center h-full text-muted-foreground text-xs gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Looking for Claude Code…
              </div>
            )}

            {statusError && (
              <div className="flex flex-col items-center justify-center h-full text-center px-4">
                <AlertCircle className="w-8 h-8 mb-3 text-danger" />
                <p className="text-sm font-medium">Something went wrong in the app</p>
                <p className="text-xs text-muted-foreground mt-2 break-words">{statusError}</p>
                <Button
                  size="sm" variant="outline" className="mt-3 h-8 text-xs"
                  onClick={() => refreshStatus(true)} disabled={checking}
                >
                  Try again
                </Button>
              </div>
            )}

            {status && !status.installed && (
              <div className="flex flex-col items-center justify-center h-full text-center px-4">
                <ClaudeMark className="w-10 h-10 mb-3 opacity-30" color="#D97757" />
                <p className="text-sm font-medium">Claude Code was not found</p>
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                  This panel runs the agent on your Claude subscription by driving a local Claude
                  Code. It looked in the standard places and could not reach one — note that the
                  copy bundled inside the Claude desktop app is not always readable by other
                  programs. Installing the CLI itself fixes that:
                </p>
                <code className="mt-2 block w-full rounded border bg-muted/50 px-2 py-1.5 text-[11px] font-mono text-left">
                  npm install -g @anthropic-ai/claude-code
                </code>
                <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
                  Already have it somewhere else? Give the full path to <code>claude.exe</code> (or
                  <code> claude.cmd</code>) and the panel will use it.
                </p>
                <div className="mt-2 w-full flex gap-1.5">
                  <input
                    value={pathDraft}
                    onChange={e => setPathDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void savePath(); }}
                    placeholder="C:\\…\\claude.exe"
                    className="flex-1 min-w-0 h-8 text-[11px] font-mono px-2 rounded-lg border bg-background transition-colors duration-150 hover:border-foreground/25"
                  />
                  <Button size="sm" variant="outline" className="h-8 text-xs" onClick={savePath} disabled={checking}>
                    Use this
                  </Button>
                </div>
                <Button
                  size="sm" variant="outline" className="mt-3 h-8 text-xs"
                  onClick={() => refreshStatus(true)} disabled={checking}
                >
                  {checking ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> Searching…</> : 'Look again'}
                </Button>
                {status.probe && status.probe.length > 0 && (
                  <div className="mt-4 w-full text-left">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                      What was tried
                    </div>
                    <div className="rounded-lg border divide-y max-h-40 overflow-y-auto">
                      {status.probe.map((p, i) => (
                        <div key={i} className="px-2 py-1.5">
                          <div className="text-[11px] font-mono truncate">{p.path || p.source}</div>
                          <div className="text-[11px] text-danger break-words">{p.error}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {status?.installed && !status.auth?.loggedIn && (
              <div className="flex flex-col items-center justify-center h-full text-center px-4">
                <ClaudeMark className="w-10 h-10 mb-3" color="#D97757" />
                <p className="text-sm font-medium">Sign in with your Claude account</p>
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                  The agent runs on your subscription — no API key, and nothing billed per message.
                  Signing in opens your browser once.
                </p>
                <Button
                  size="sm"
                  className="mt-3 h-8 text-xs bg-[#D97757] hover:bg-[#C56647] active:bg-[#B4573C] text-white"
                  onClick={signIn}
                  disabled={loggingIn}
                >
                  {loggingIn ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Waiting for the browser…</> : 'Sign in'}
                </Button>
                {loginError && (
                  <div className="mt-3 w-full flex items-start gap-1.5 rounded-lg border border-danger/40 bg-danger-soft px-2.5 py-2 text-[11px] text-danger text-left">
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
                    <span>{loginError}</span>
                  </div>
                )}
                {loginUrl && (
                  <div className="mt-3 w-full space-y-2">
                    <a
                      href={loginUrl} target="_blank" rel="noopener noreferrer"
                      className="text-[11px] text-[#D97757] hover:underline inline-flex items-center gap-1"
                    >
                      <ExternalLink className="w-3 h-3" /> Open the sign-in page manually
                    </a>
                    <div className="flex gap-1.5">
                      <input
                        value={loginCode}
                        onChange={e => setLoginCode(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') submitCode(); }}
                        placeholder="Paste the code from the page, if it asks for one"
                        className="flex-1 min-w-0 h-8 text-[11px] px-2 rounded-lg border bg-background transition-colors duration-150 hover:border-foreground/25"
                      />
                      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={submitCode}>
                        Send
                      </Button>
                    </div>
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground mt-3">
                  Claude Code {status.version} · {status.source}
                </p>
              </div>
            )}

            {ready && turns.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center px-2">
                <ClaudeMark className="w-10 h-10 mb-3" color="#D97757" />
                <p className="text-sm font-medium">What should we work on?</p>
                <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed max-w-[300px]">
                  I can read and write the files of your cases and run OpenFOAM myself — inside the
                  run directory, with the executables this installation ships. I cannot delete anything.
                </p>
                <div className="mt-4 w-full space-y-1.5">
                  {[
                    caseName ? `Check ${caseName} and tell me if it is ready to run` : 'List my cases and tell me what state they are in',
                    'Run blockMesh and checkMesh, then explain the mesh quality',
                    'Set the inlet to 5 m/s and validate the files you change',
                  ].map((q, i) => (
                    <button
                      key={i}
                      onClick={() => setInput(q)}
                      className="block w-full text-left text-xs px-3 py-2 rounded-lg border border-black/10 dark:border-white/10 hover:bg-black/[0.03] dark:hover:bg-white/5 hover:border-[#D97757]/40 active:bg-black/[0.06] dark:active:bg-white/10 text-muted-foreground hover:text-foreground transition-colors duration-150"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {ready && turns.map((turn, i) => (
              <TurnView key={i} turn={turn} running={running && i === turns.length - 1} />
            ))}
          </div>

          {/* Composer — model and reasoning live in here, as in Claude Desktop */}
          {ready && (
            <div className="px-3 pb-3 pt-1">
              {/* The composer reads as ONE field, so the app's shared focus ring
                  goes on the box rather than on the textarea inside it — same
                  2px brand outline at the same offset, just around the thing the
                  user is actually typing into. */}
              <div className="rounded-2xl border border-black/10 dark:border-white/15 bg-white dark:bg-[#26251F] shadow-sm transition-colors duration-150 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(); }
                  }}
                  placeholder={caseName ? `Ask Claude to work on ${caseName}…` : 'Ask Claude…'}
                  rows={1}
                  disabled={running}
                  className="w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm min-h-[38px] max-h-[120px] focus:outline-none placeholder:text-muted-foreground/70 disabled:opacity-60 disabled:cursor-not-allowed"
                />
                <div className="flex items-center gap-1 px-2 pb-2" onClick={e => e.stopPropagation()}>
                  {/* Model */}
                  <div className="relative">
                    <button
                      onClick={() => setMenu(menu === 'model' ? null : 'model')}
                      className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg transition-colors duration-150 ${menu === 'model' ? 'bg-black/5 dark:bg-white/10 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/10'}`}
                    >
                      {currentModel.label}
                      <ChevronDown className="w-3 h-3" />
                    </button>
                    {menu === 'model' && (
                      <div className="absolute bottom-full left-0 mb-1 w-60 rounded-xl border bg-popover shadow-xl overflow-hidden z-50">
                        {MODELS.map(m => (
                          <button
                            key={m.id}
                            onClick={() => chooseModel(m.id)}
                            className={`block w-full text-left px-3 py-2 transition-colors duration-150 hover:bg-accent active:bg-accent/70 ${model === m.id ? 'bg-accent' : ''}`}
                          >
                            <div className="text-xs font-medium flex items-center gap-1.5">
                              {m.label}
                              {model === m.id && <Check className="w-3 h-3 text-[#D97757]" />}
                            </div>
                            <div className="text-[10px] text-muted-foreground">{m.hint}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Reasoning */}
                  <div className="relative">
                    <button
                      onClick={() => setMenu(menu === 'effort' ? null : 'effort')}
                      disabled={!currentModel.effort}
                      className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none ${menu === 'effort' ? 'bg-black/5 dark:bg-white/10 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/10'}`}
                      title={currentModel.effort ? 'How hard Claude thinks before acting' : 'This model has no reasoning control'}
                    >
                      <Sparkles className="w-3 h-3" />
                      {currentModel.effort ? (EFFORTS.find(e => e.id === effort)?.label || 'High') : 'No reasoning'}
                      <ChevronDown className="w-3 h-3" />
                    </button>
                    {menu === 'effort' && (
                      <div className="absolute bottom-full left-0 mb-1 w-60 rounded-xl border bg-popover shadow-xl overflow-hidden z-50">
                        <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground border-b">
                          Reasoning
                        </div>
                        {EFFORTS.map(e => (
                          <button
                            key={e.id}
                            onClick={() => chooseEffort(e.id)}
                            className={`block w-full text-left px-3 py-2 transition-colors duration-150 hover:bg-accent active:bg-accent/70 ${effort === e.id ? 'bg-accent' : ''}`}
                          >
                            <div className="text-xs font-medium flex items-center gap-1.5">
                              {e.label}
                              {effort === e.id && <Check className="w-3 h-3 text-[#D97757]" />}
                            </div>
                            <div className="text-[10px] text-muted-foreground">{e.hint}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* The guard rails. Deliberately plain when off and loud when
                      on — this is the one control that changes what can be
                      destroyed, so its state must be readable at a glance. */}
                  <button
                    onClick={toggleUnrestricted}
                    className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg transition-colors duration-150 ${
                      unrestricted
                        ? 'bg-[#D97757]/15 ring-1 ring-[#D97757]/45 text-[#B4573C] dark:text-[#E8A188] font-medium hover:bg-[#D97757]/25'
                        : 'text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/10 active:bg-black/10 dark:active:bg-white/15'
                    }`}
                    title={unrestricted
                      ? 'Unrestricted: any command runs, including destructive ones. Click to restore the limits.'
                      : 'Limited to the OpenFOAM executables this installation ships. Click to remove the limits.'}
                  >
                    {unrestricted ? <ShieldOff className="w-3 h-3" /> : <Shield className="w-3 h-3" />}
                    {unrestricted ? 'No limits' : 'Guarded'}
                  </button>

                  <div className="flex-1" />

                  {running ? (
                    <button
                      onClick={stop}
                      className="w-8 h-8 rounded-lg flex items-center justify-center bg-black/10 dark:bg-white/15 hover:bg-black/20 dark:hover:bg-white/25 active:bg-black/25 dark:active:bg-white/30 transition-colors duration-150"
                      title="Stop"
                    >
                      <Square className="w-3 h-3 fill-current" />
                    </button>
                  ) : (
                    <button
                      onClick={sendMessage}
                      disabled={!input.trim()}
                      className="w-8 h-8 rounded-lg flex items-center justify-center bg-[#D97757] text-white hover:bg-[#C56647] active:bg-[#B4573C] disabled:opacity-30 disabled:pointer-events-none transition-colors duration-150"
                      title="Send"
                    >
                      <Send className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-1.5 px-1">
                <span className="text-[10px] text-muted-foreground">
                  Runs on your Claude subscription · confined to the run directory
                </span>
              </div>
            </div>
          )}

          <div
            className="absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize flex items-end justify-end p-0.5 text-muted-foreground/60 hover:text-muted-foreground transition-colors duration-150"
            onMouseDown={onResizeStart}
            title="Drag to resize"
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M9 1v8H1M9 5v4H5M9 8h-1" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
            </svg>
          </div>
        </div>
      )}
    </>
  );
}

// ── One turn ────────────────────────────────────────────────────────────────

function TurnView({ turn, running }: { turn: Turn; running: boolean }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[#E8E6DC] dark:bg-[#33322C] px-3 py-2 text-sm whitespace-pre-wrap break-words">
          {turn.text}
        </div>
      </div>
    );
  }

  const blocks = turn.blocks || [];
  const empty = blocks.length === 0;

  return (
    <div className="space-y-2">
      {blocks.map((block, i) => {
        if (block.kind === 'tool') return <ToolCard key={i} block={block} />;
        if (block.kind === 'thinking') return <ThinkingCard key={i} text={block.text} live={block.live} />;
        return (
          <div key={i} className="text-sm leading-relaxed">
            <Markdown text={block.text} />
            {block.live && <span className="inline-block w-1.5 h-3.5 ml-0.5 align-middle bg-[#D97757] animate-pulse" />}
          </div>
        );
      })}

      {empty && running && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Thinking…
        </div>
      )}

      {turn.error && (
        <div className="flex items-start gap-1.5 rounded-lg border border-danger/40 bg-danger-soft px-2.5 py-2 text-[11px] text-danger">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
          <span>{turn.error}</span>
        </div>
      )}

      {turn.meta && turn.meta.durationMs > 0 && (
        <div className="text-[10px] text-muted-foreground">
          {(turn.meta.durationMs / 1000).toFixed(1)}s
        </div>
      )}
    </div>
  );
}

function ThinkingCard({ text, live }: { text: string; live: boolean }) {
  const [openBox, setOpenBox] = useState(false);
  if (!text.trim() && !live) return null;
  return (
    <div className="text-[11px]">
      <button
        onClick={() => setOpenBox(o => !o)}
        className="inline-flex items-center gap-1 rounded-sm text-muted-foreground hover:text-foreground transition-colors duration-150 italic"
      >
        {openBox ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {live ? 'Thinking…' : 'Thought about it'}
      </button>
      {openBox && (
        <div className="mt-1 pl-4 border-l-2 border-black/10 dark:border-white/10 text-muted-foreground whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}

function ToolCard({ block }: { block: Extract<Block, { kind: 'tool' }> }) {
  const [openBox, setOpenBox] = useState(false);
  const verb = TOOL_VERB[block.name] || block.name;
  const detail = describeTool(block.name, block.input);
  // The whole file is in the arguments of a write; showing it is what makes
  // "it changed my case" auditable rather than a claim.
  const written = block.name === 'write_case_file' && typeof block.input.content === 'string'
    ? (block.input.content as string)
    : '';

  return (
    <div className={`rounded-lg border overflow-hidden bg-white/60 dark:bg-white/[0.03] ${
      block.status === 'error' ? 'border-danger/40' : 'border-black/10 dark:border-white/10'
    }`}>
      <button
        onClick={() => setOpenBox(o => !o)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-left hover:bg-black/[0.03] dark:hover:bg-white/5 active:bg-black/[0.06] dark:active:bg-white/10 transition-colors duration-150"
      >
        {block.status === 'running'
          ? <Loader2 className="w-3 h-3 animate-spin text-[#D97757] flex-shrink-0" />
          : block.status === 'error'
            ? <AlertCircle className="w-3 h-3 text-danger flex-shrink-0" />
            : <Wrench className="w-3 h-3 text-muted-foreground flex-shrink-0" />}
        <span className="font-medium flex-shrink-0">{verb}</span>
        <span className="font-mono text-muted-foreground truncate">{detail}</span>
        <span className="flex-1" />
        {openBox ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
      </button>
      {openBox && (
        <div className="border-t border-black/5 dark:border-white/10">
          {written && (
            <pre className="p-2.5 text-[11px] font-mono whitespace-pre-wrap max-h-52 overflow-y-auto bg-black/[0.03] dark:bg-black/20">
              {written}
            </pre>
          )}
          <pre className="p-2.5 text-[11px] font-mono whitespace-pre-wrap max-h-52 overflow-y-auto">
            {block.result || (block.status === 'running' ? '…' : '(no output)')}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── The small amount of markdown an agent actually emits ────────────────────

function Markdown({ text }: { text: string }) {
  const [copied, setCopied] = useState<number | null>(null);
  // Held so a second copy cannot be cleared early by the first one's timer, and
  // so nothing is left pending when the block unmounts.
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);
  const parts = text.split(/(```[\s\S]*?```)/g);

  return (
    <>
      {parts.map((part, index) => {
        if (!part) return null;

        if (part.startsWith('```')) {
          const inner = part.slice(3, part.endsWith('```') ? -3 : undefined);
          const newline = inner.indexOf('\n');
          const lang = newline >= 0 ? inner.slice(0, newline).trim() : '';
          const code = newline >= 0 ? inner.slice(newline + 1) : inner;
          return (
            <div key={index} className="my-2 rounded-lg border border-black/10 dark:border-white/10 overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-2.5 py-1 text-[10px] text-muted-foreground bg-black/[0.04] dark:bg-white/5 font-mono">
                <span className="truncate">{lang || 'text'}</span>
                <button
                  className="rounded-sm hover:text-foreground transition-colors duration-150"
                  onClick={async () => {
                    // Awaited, so the tick means the text is actually on the
                    // clipboard. The write can reject (no permission, no
                    // clipboard in the context) and the confirmation used to
                    // appear regardless — the one case where the user needs to
                    // know is the one where it lied.
                    try {
                      await navigator.clipboard.writeText(code);
                    } catch {
                      toast.error('Could not copy to the clipboard');
                      return;
                    }
                    setCopied(index);
                    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
                    copyTimerRef.current = setTimeout(() => setCopied(null), 1800);
                  }}
                  title="Copy"
                  aria-label="Copy this code block"
                >
                  {copied === index ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>
              <pre className="p-2.5 text-[11px] font-mono overflow-x-auto whitespace-pre-wrap">{code}</pre>
            </div>
          );
        }

        const lines = part.split('\n');
        const out: React.ReactNode[] = [];
        let i = 0;
        while (i < lines.length) {
          const line = lines[i];

          const heading = line.match(/^(#{1,3})\s+(.*)/);
          if (heading) {
            out.push(
              <div key={`${index}-${i}`} className="font-semibold mt-2.5 mb-1">
                {inline(heading[2])}
              </div>,
            );
            i++;
            continue;
          }

          if (/^\s*[-*]\s+/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
              items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
              i++;
            }
            out.push(
              <ul key={`${index}-${i}`} className="ml-4 list-disc space-y-0.5 my-1">
                {items.map((item, k) => <li key={k}>{inline(item)}</li>)}
              </ul>,
            );
            continue;
          }

          if (/^\s*\d+\.\s+/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
              items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
              i++;
            }
            out.push(
              <ol key={`${index}-${i}`} className="ml-4 list-decimal space-y-0.5 my-1">
                {items.map((item, k) => <li key={k}>{inline(item)}</li>)}
              </ol>,
            );
            continue;
          }

          out.push(<span key={`${index}-${i}`}>{inline(line)}</span>);
          if (i < lines.length - 1) out.push(<br key={`${index}-${i}-br`} />);
          i++;
        }
        return <React.Fragment key={index}>{out}</React.Fragment>;
      })}
    </>
  );
}

/** Inline code and bold — the two things that actually show up in answers. */
function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const segments = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  segments.forEach((segment, i) => {
    if (!segment) return;
    if (segment.startsWith('`') && segment.endsWith('`') && segment.length > 2) {
      out.push(
        <code key={i} className="px-1 py-0.5 rounded bg-black/[0.06] dark:bg-white/10 text-[0.85em] font-mono">
          {segment.slice(1, -1)}
        </code>,
      );
    } else if (segment.startsWith('**') && segment.endsWith('**') && segment.length > 4) {
      out.push(<strong key={i}>{segment.slice(2, -2)}</strong>);
    } else {
      out.push(<React.Fragment key={i}>{segment}</React.Fragment>);
    }
  });
  return out;
}

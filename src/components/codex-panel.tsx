'use client';

/**
 * Codex, inside the app.
 *
 * FOAMy is a copilot: it answers, proposes a file, and the user clicks Apply.
 * This is an AGENT — it reads the case, writes the files and runs OpenFOAM
 * itself, through the tools in src/lib/agent-policy.ts. So the two panels are
 * deliberately different objects and neither replaces the other: same shape of
 * window (draggable, resizable, floating launcher), different conversation.
 *
 * The layout follows Codex Desktop rather than a chat widget: the assistant's
 * text sits plainly on the page instead of in a bubble, the user's turn is the
 * only thing in a bubble, thinking and tool calls are collapsible rows in the
 * flow, and the model and reasoning controls live INSIDE the composer, where
 * Codex Desktop puts them.
 *
 * It talks to /api/codex over SSE, because one turn is a sequence of events
 * spread over minutes (thinking → tool → result → text), not a single reply.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  X, Send, Trash2, Loader2, GripHorizontal, Check, Copy, ChevronDown, ChevronRight,
  Square, AlertCircle, ExternalLink, LogOut, LogIn, UserRound, Sparkles, Wrench, FolderOpen,
  Shield, ShieldOff,
} from 'lucide-react';
import type { CodexModel } from '@/lib/codex-protocol';
import { Button } from '@/components/ui/button';
import { KnowledgeStatus } from '@/components/knowledge-status';
import { useCaseContext } from '@/lib/case-context';
import { toast } from 'sonner';
import { loadFoamyConfig, patchFoamyConfig } from '@/lib/foamy-store';
import { LAUNCHER_Z, bringToFront, isFront } from '@/lib/floating-order';
import { useAgentLauncher } from '@/components/agent-launcher-provider';
import { applyAgentTranscriptEvent, type AgentTranscriptBlock as Block } from '@/lib/agent-transcript';

// ── ChatGPT mark ───────────────────────────────────────────────────────────

/** The unmodified OpenAI blossom lives in public/openai.svg. Masking lets the
 * official black and white forms stay sharp at each size without duplicating
 * or altering its path data in the component. */
function ChatGPTMark({ className = '', color = 'currentColor' }: { className?: string; color?: string }) {
  return <span aria-hidden="true" className={`inline-block flex-none ${className}`} style={{
    backgroundColor: color,
    WebkitMask: 'url(/openai.svg) center / contain no-repeat',
    mask: 'url(/openai.svg) center / contain no-repeat',
  }} />;
}

// ── Conversation model ──────────────────────────────────────────────────────

interface Turn {
  role: 'user' | 'assistant';
  text?: string;
  blocks?: Block[];
  /** Set on the assistant turn when the run ended badly. */
  error?: string;
  meta?: { durationMs: number; turns: number };
}

interface AgentStatus {
  models: CodexModel[];
  installed: boolean;
  path: string;
  version: string;
  source: string;
  auth: { loggedIn: boolean; email?: string; subscriptionType?: string; authMethod?: string };
  commands: number;
  indexReady: boolean;
  corpusReady: boolean;
  /** Filled only when Codex CLI was NOT found: what was tried, and why each failed. */
  probe?: { path: string; source: string; error: string }[];
}

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

export default function CodexPanel() {
  const { caseName } = useCaseContext();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [sessionId] = useState(() => `codex-${Date.now()}`);

  const [status, setStatus] = useState<AgentStatus | null>(null);
  /**
   * Where Codex CLI is, when the app cannot work it out.
   *
   * Needed because the automatic search only knows the standard locations, and
   * on at least one machine none of them were reachable by an ordinary process
   * — the panel was then a dead end with no way for the user to correct it.
   */
  const [codexPath, setCodexPath] = useState('');
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
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('high');
  const [menu, setMenu] = useState<'model' | 'effort' | 'account' | null>(null);

  // Sign-in
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginUrl, setLoginUrl] = useState('');
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
      if (cfg['codex-agent-model']) setModel(cfg['codex-agent-model']);
      if (cfg['codex-agent-effort']) setEffort(cfg['codex-agent-effort']);
      if (cfg['codex-agent-path']) { setCodexPath(cfg['codex-agent-path']); setPathDraft(cfg['codex-agent-path']); }
      setUnrestricted(cfg['codex-agent-unrestricted'] === 'on');
    })();
    return () => { cancelled = true; };
  }, []);

  const chooseModel = useCallback((id: string) => {
    setModel(id);
    setMenu(null);
    void patchFoamyConfig({ 'codex-agent-model': id });
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
    void patchFoamyConfig({ 'codex-agent-unrestricted': next ? 'on' : 'off' });
    toast.info(next ? 'Unrestricted — Codex can run any command' : 'Back to OpenFOAM commands only');
  }, [unrestricted]);

  const chooseEffort = useCallback((id: string) => {
    setEffort(id);
    setMenu(null);
    void patchFoamyConfig({ 'codex-agent-effort': id });
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
   * Codex CLI was not installed, whatever had actually gone wrong.
   */
  const refreshStatus = useCallback(async (force = false) => {
    setChecking(true);
    try {
      const res = await fetch(
        `/api/codex?action=status${force ? '&refresh=1' : ''}`
        + (codexPath ? `&path=${encodeURIComponent(codexPath)}` : ''),
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
  }, [codexPath]);

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

  const launcher = useAgentLauncher('codex');

  const handleOpen = useCallback(() => {
    launcher.collapse();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(size.w, vw - 40);
    const h = Math.min(size.h, vh - 40);
    setWinPos({ left: vw - w - 24, top: Math.max(12, vh - h - 24) });
    setSize({ w, h });
    setZ(bringToFront());
    setOpen(true);
  }, [launcher, size]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
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
      const blocks = applyAgentTranscriptEvent(last.blocks || [], event);

      if (t === 'error') {
        next[next.length - 1] = { ...last, blocks, error: String(event.message || '') };
        return next;
      } else if (t === 'done') {
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
      const res = await fetch('/api/codex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId, message: text, model, effort,
          caseName: caseName || undefined,
          codexPath: codexPath || undefined,
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
  }, [input, running, sessionId, model, effort, caseName, codexPath, unrestricted, apply, refreshStatus]);

  const stop = useCallback(async () => {
    try {
      await fetch('/api/codex', {
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
      await fetch('/api/codex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'end', sessionId }),
      });
    } catch { /* silent */ }
  }, [sessionId]);

  const savePath = useCallback(async () => {
    const next = pathDraft.trim();
    setCodexPath(next);
    await patchFoamyConfig({ 'codex-agent-path': next });
    // refreshStatus closes over the OLD value, so ask with the new one directly.
    setChecking(true);
    try {
      const res = await fetch(
        `/api/codex?action=status&refresh=1${next ? `&path=${encodeURIComponent(next)}` : ''}`,
      );
      const data = await res.json().catch(() => null);
      if (data && typeof data.installed === 'boolean') {
        setStatus(data);
        setStatusError('');
        if (data.installed) toast.success(`Found Codex CLI ${data.version}`);
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
      const res = await fetch('/api/codex', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'login', codexPath: codexPath || undefined }),
      });
      const data = await res.json();
      if (!data?.started) {
        const message = data?.error || 'Could not start the sign-in.';
        setLoginError(message);
        toast.error(message);
        setLoggingIn(false);
        return;
      }
      if (data.url) {
        setLoginUrl(data.url);
        window.open(data.url, '_blank', 'noopener,noreferrer');
      }
      // Poll: the CLI opens the browser itself and finishes on its own when the
      // browser is already signed in; otherwise it waits for the code.
      for (let i = 0; i < 150; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const state = await fetch('/api/codex?action=login').then(r => r.json()).catch(() => null);
        if (state?.url) setLoginUrl(state.url);
        if (state?.done) {
          if (state.error) { setLoginError(state.error); setLoggingIn(false); return; }
          setLoggingIn(false);
          await refreshStatus(true);
          const fresh = await fetch('/api/codex?action=status').then(r => r.json()).catch(() => null);
          if (fresh?.auth?.loggedIn) {
            toast.success(`Signed in as ${fresh.auth.email || 'your ChatGPT account'}`);
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
  }, [refreshStatus, codexPath]);

  const signOut = useCallback(async () => {
    await fetch('/api/codex', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logout' }),
    }).catch(() => null);
    await refreshStatus();
  }, [refreshStatus]);

  const MODELS = status?.models || [];
  const currentModel = MODELS.find(m => m.id === model) || MODELS.find(m => m.isDefault) || MODELS[0];
  const EFFORTS = currentModel?.efforts || [];
  useEffect(() => {
    if (!currentModel) return;
    if (model !== currentModel?.id) setModel(currentModel?.id);
    if (!currentModel?.efforts.some(e => e.id === effort)) setEffort(currentModel?.defaultEffort);
  }, [currentModel, model, effort]);
  const ready = status?.installed && status?.auth?.loggedIn && Boolean(currentModel);

  return (
    <>
      {!open && (
        <button
          ref={launcher.ref}
          onMouseDown={launcher.onMouseDown}
          onMouseEnter={launcher.onMouseEnter}
          onMouseLeave={launcher.onMouseLeave}
          onClick={(e) => {
            if (launcher.isClick(e)) {
              handleOpen();
            }
          }}
          className="fixed right-[30px] bottom-[30px] w-14 h-14 rounded-full bg-[#0D0D0D] text-white shadow-lg hover:shadow-xl hover:shadow-black/30 flex items-center justify-center cursor-grab active:cursor-grabbing transition-[box-shadow,filter,transform] duration-200 hover:brightness-125"
          style={launcher.style}
          title="Codex — agent for your cases (drag the group)"
        >
          <ChatGPTMark className="w-7 h-7" color="#ffffff" />
        </button>
      )}

      {open && (
        <div
          className="fixed flex flex-col rounded-xl border shadow-2xl overflow-hidden bg-white dark:bg-[#171717] text-foreground"
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
              <ChatGPTMark className="w-5 h-5 flex-shrink-0" color="#0D0D0D" />
              <div className="min-w-0">
                <div className="text-sm font-semibold leading-tight">Codex</div>
                <div className="text-[10px] text-muted-foreground leading-tight flex items-center gap-1.5">
                  {caseName ? (
                    <span className="inline-flex items-center gap-1 truncate max-w-[160px]">
                      <FolderOpen className="w-2.5 h-2.5 flex-shrink-0" />{caseName}
                    </span>
                  ) : (
                    <span>Agent for your OpenFOAM cases</span>
                  )}
                  {status?.auth?.subscriptionType && (
                    <span className="uppercase tracking-wide text-[10px] px-1.5 py-px rounded bg-[#10A37F]/15 text-[#08785F] dark:text-[#74D6C0] flex-shrink-0">
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
                  title={status?.auth?.loggedIn ? `Signed in as ${status.auth.email || 'your ChatGPT account'}` : 'ChatGPT account'}
                >
                  <UserRound className="w-3.5 h-3.5" />
                  {status && !status.auth?.loggedIn && (
                    <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-[#10A37F]" />
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
                          ? `Codex ${status.auth.subscriptionType || 'account'} · no API key, subject to your plan limits`
                          : 'The agent needs your ChatGPT account to work'}
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
                        className="w-full text-left px-3 py-2 text-[11px] hover:bg-accent active:bg-accent/70 transition-colors duration-150 inline-flex items-center gap-1.5 font-medium text-[#10A37F] disabled:opacity-50 disabled:pointer-events-none"
                        onClick={() => { setMenu(null); void signIn(); }}
                        disabled={loggingIn}
                      >
                        {loggingIn
                          ? <><Loader2 className="w-3 h-3 animate-spin" /> Waiting for the browser…</>
                          : <><LogIn className="w-3 h-3" /> Sign in with your ChatGPT account</>}
                      </button>
                    )}
                    <div className="px-3 py-1.5 border-t text-[10px] text-muted-foreground">
                      {status?.installed ? `Codex CLI ${status.version} · ${status.source}` : 'Codex CLI not found on this machine'}
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
                onClick={() => { launcher.collapse(); setOpen(false); }} title="Close"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {ready && (
            <div className="border-b border-black/5 px-3 py-1.5 dark:border-white/10">
              <KnowledgeStatus className="min-w-0 overflow-hidden whitespace-nowrap" />
            </div>
          )}

          {/* Conversation */}
          <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
            {!status && !statusError && (
              <div className="flex items-center justify-center h-full text-muted-foreground text-xs gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Looking for Codex CLI…
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
                <ChatGPTMark className="w-10 h-10 mb-3 opacity-30" color="#0D0D0D" />
                <p className="text-sm font-medium">Codex CLI was not found</p>
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                  This panel runs Codex on your ChatGPT subscription. Install Codex CLI 0.153.1 or newer,
                  or select the executable supplied by the Codex desktop app:
                </p>
                <code className="mt-2 block w-full rounded border bg-muted/50 px-2 py-1.5 text-[11px] font-mono text-left">
                  npm install -g @openai/codex
                </code>
                <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
                  Already have it somewhere else? Give the full path to <code>codex.exe</code> (or
                  <code> codex.cmd</code>) and the panel will use it.
                </p>
                <div className="mt-2 w-full flex gap-1.5">
                  <input
                    value={pathDraft}
                    onChange={e => setPathDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void savePath(); }}
                    placeholder="C:\\…\\codex.exe"
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
                <ChatGPTMark className="w-10 h-10 mb-3" color="#0D0D0D" />
                <p className="text-sm font-medium">Sign in with your ChatGPT account</p>
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                  The agent runs on your ChatGPT subscription — no API key. Your plan limits apply.
                  Signing in opens your browser once.
                </p>
                <Button
                  size="sm"
                  className="mt-3 h-8 text-xs bg-[#10A37F] hover:bg-[#0D8C6D] active:bg-[#08785F] text-white"
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
                      className="text-[11px] text-[#10A37F] hover:underline inline-flex items-center gap-1"
                    >
                      <ExternalLink className="w-3 h-3" /> Open the sign-in page manually
                    </a>

                  </div>
                )}
                <p className="text-[10px] text-muted-foreground mt-3">
                  Codex CLI {status.version} · {status.source}
                </p>
              </div>
            )}

            {ready && turns.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center px-2">
                <ChatGPTMark className="w-10 h-10 mb-3" color="#0D0D0D" />
                <p className="text-sm font-medium">What should we work on?</p>
                <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed max-w-[300px]">
                  I can read and write the files of your cases and run OpenFOAM myself — inside the
                  run directory, with the guarded commands this installation exposes. Existing cleanup
                  scripts may delete generated case data, and every write is validated automatically.
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
                      className="block w-full text-left text-xs px-3 py-2 rounded-lg border border-black/10 dark:border-white/10 hover:bg-black/[0.03] dark:hover:bg-white/5 hover:border-[#10A37F]/40 active:bg-black/[0.06] dark:active:bg-white/10 text-muted-foreground hover:text-foreground transition-colors duration-150"
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

          {/* Composer — model and reasoning live in here, as in Codex Desktop */}
          {ready && (
            <div className="px-3 pb-3 pt-1">
              {/* The composer reads as ONE field, so the app's shared focus ring
                  goes on the box rather than on the textarea inside it — one 2px
                  brand outline around everything the user is composing with, the
                  model and reasoning menus included.
                  The textarea opts out with `no-focus-ring` and NOT with a
                  utility: the shared rule in globals.css is unlayered, so it beat
                  the `focus:outline-none` that used to be here and drew a second,
                  smaller rectangle inside this one. */}
              <div className="rounded-2xl border border-black/10 dark:border-white/15 bg-white dark:bg-[#202020] shadow-sm transition-colors duration-150 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[#10A37F]">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(); }
                  }}
                  placeholder={caseName ? `Ask Codex to work on ${caseName}…` : 'Ask Codex…'}
                  rows={1}
                  disabled={running}
                  className="no-focus-ring w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm min-h-[38px] max-h-[120px] placeholder:text-muted-foreground/70 disabled:opacity-60 disabled:cursor-not-allowed"
                />
                <div className="flex items-center gap-1 px-2 pb-2" onClick={e => e.stopPropagation()}>
                  {/* Model */}
                  <div className="relative">
                    <button
                      onClick={() => setMenu(menu === 'model' ? null : 'model')}
                      className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg transition-colors duration-150 ${menu === 'model' ? 'bg-black/5 dark:bg-white/10 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/10'}`}
                    >
                      {currentModel?.label}
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
                              {model === m.id && <Check className="w-3 h-3 text-[#10A37F]" />}
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
                      disabled={!currentModel?.effort}
                      className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none ${menu === 'effort' ? 'bg-black/5 dark:bg-white/10 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/10'}`}
                      title={currentModel?.effort ? 'How hard Codex thinks before acting' : 'This model has no reasoning control'}
                    >
                      <Sparkles className="w-3 h-3" />
                      {currentModel?.effort ? (EFFORTS.find(e => e.id === effort)?.label || 'High') : 'No reasoning'}
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
                              {effort === e.id && <Check className="w-3 h-3 text-[#10A37F]" />}
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
                        ? 'bg-[#10A37F]/15 ring-1 ring-[#10A37F]/45 text-[#08785F] dark:text-[#74D6C0] font-medium hover:bg-[#10A37F]/25'
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
                      className="w-8 h-8 rounded-lg flex items-center justify-center bg-[#10A37F] text-white hover:bg-[#0D8C6D] active:bg-[#08785F] disabled:opacity-30 disabled:pointer-events-none transition-colors duration-150"
                      title="Send"
                    >
                      <Send className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-1.5 px-1">
                <span className="text-[10px] text-muted-foreground">
                  Runs on your ChatGPT subscription · confined to the run directory
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
            {block.live && <span className="inline-block w-1.5 h-3.5 ml-0.5 align-middle bg-[#10A37F] animate-pulse" />}
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
          ? <Loader2 className="w-3 h-3 animate-spin text-[#10A37F] flex-shrink-0" />
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

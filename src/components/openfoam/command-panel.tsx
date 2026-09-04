'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import { confirmDialog } from '@/components/ui/confirm-host';
import {
  Terminal as TerminalIcon, Play, Send, Search, ChevronDown, ChevronRight,
  Grid3x3, Layers, Zap, Trash2, Loader2, Tag
} from 'lucide-react';
import { getCommandsForVersion, parseMajorVersion } from '@/lib/openfoam-data';

/**
 * One entry of the command list, as /api/commands?action=catalog returns it.
 *
 * Declared here rather than imported from src/lib/foam-commands.ts: that module
 * reads the filesystem and shells out to WSL, and must not be pulled into the
 * client bundle even for its types.
 */
interface CatalogCommand {
  name: string;
  category: string;
  description: string;
  kind: 'application' | 'script' | 'solverModule';
  /** What clicking the row puts in the terminal — not always the name: a
   *  solver module is run as `foamRun -solver <name>`. */
  insert: string;
  superseded?: boolean;
}

/**
 * The order categories are shown in: the order you meet them in a case, from
 * building a mesh to looking at the result. Anything the installation reports
 * that is not named here is appended alphabetically, so a new category in a
 * future version appears rather than disappearing.
 */
const CATEGORY_ORDER = [
  'Execution', 'Solver Modules',
  'Mesh Generation', 'Mesh Conversion', 'Mesh Manipulation', 'Mesh Advanced', 'Mesh Utilities',
  'Pre-processing', 'Post-processing', 'Parallel Processing',
  'Surface Utilities', 'Thermophysical', 'Case Management', 'Miscellaneous',
  'Legacy Solvers', 'Superseded', 'Deprecated',
];

function orderCategories(present: string[]): string[] {
  const known = CATEGORY_ORDER.filter(c => present.includes(c));
  const rest = present.filter(c => !CATEGORY_ORDER.includes(c)).sort();
  return [...known, ...rest];
}

/**
 * Colour one line of OpenFOAM output.
 *
 * The old rendering painted the WHOLE block red when the exit code was
 * non-zero, which is worse than no colour at all: the three lines that say
 * what went wrong end up exactly as red as the two hundred lines of banner and
 * progress around them. Measured on a failing blockMesh: 23 lines on stdout,
 * all of them innocuous, and 10 on stderr carrying the actual error — and the
 * two streams are merged into one by the time they reach here.
 *
 * So the block stays neutral and the LINES carry the meaning. Everything below
 * is a shape OpenFOAM's own output takes, in the order it is worth noticing.
 */
function lineClass(line: string): string {
  if (/^\s*-->\s*FOAM FATAL/.test(line)) return 'text-red-400 font-semibold';
  if (/^\s*-->\s*FOAM Warning/.test(line)) return 'text-amber-500';
  if (/^\s*FOAM exiting/.test(line)) return 'text-red-400/80';
  // The solver's own clock: the line you look for when scrolling a long log.
  if (/^Time = /.test(line)) return 'text-cyan-500 font-semibold';
  if (/^(Courant Number|deltaT|ExecutionTime)/.test(line)) return 'text-muted-foreground';
  // Convergence, and the end of a run.
  if (/(solution singularity|Final residual = |converged in)/.test(line)) return 'text-foreground/60';
  if (/^\s*End\s*$/.test(line)) return 'text-green-500';
  // The banner every OpenFOAM binary prints before doing anything.
  if (/^(Build\s*:|Exec\s*:|Date\s*:|Time\s*:|Host\s*:|PID\s*:|Case\s*:|nProcs\s*:|I\/O\s*:|fileModificationChecking|allowSystemOperations|Create time|\/\*|\\\*|\| |=====)/.test(line)) {
    return 'text-muted-foreground/50';
  }
  return '';
}

/**
 * Above this many lines the per-line spans stop paying for themselves and the
 * block is rendered as plain text. A 5 MiB log is 100k lines; React does not
 * need to make 100k elements to tell you a run finished.
 */
const MAX_COLOURED_LINES = 3000;

/**
 * How much of the session the terminal keeps.
 *
 * Nothing used to bound either dimension. `lines` grew by one entry per command
 * for as long as the panel was mounted, and each entry's `output` grew with
 * everything that command streamed — the server stops a single command at 5 MiB,
 * so a working session of twenty meshing and solving runs could hold well over
 * a hundred megabytes of text in React state, all of it retained because the
 * user had scrolled past it rather than because anyone would read it again.
 * The symptom is not a crash but a slow slide: every keystroke in the input
 * re-renders a component holding all of it.
 *
 * Both caps keep the END, which is the part that matters — a solver's last
 * lines say why it stopped. Dropping is announced in the transcript rather than
 * done silently, because output disappearing without explanation is worse than
 * output that is admittedly incomplete.
 */
const MAX_TRANSCRIPT_ENTRIES = 100;
const MAX_ENTRY_OUTPUT_CHARS = 2_000_000;
const TRUNCATION_NOTICE = '\n[… earlier output dropped to keep the terminal responsive …]\n';

/** Keep the tail of a single command's output, with a visible marker. */
function capOutput(text: string): string {
  if (text.length <= MAX_ENTRY_OUTPUT_CHARS) return text;
  return TRUNCATION_NOTICE + text.slice(text.length - MAX_ENTRY_OUTPUT_CHARS);
}

/** Keep the most recent commands. */
function capEntries<T>(entries: T[]): T[] {
  return entries.length <= MAX_TRANSCRIPT_ENTRIES
    ? entries
    : entries.slice(entries.length - MAX_TRANSCRIPT_ENTRIES);
}

function OutputBlock({ text }: { text: string }) {
  const lines = React.useMemo(() => text.split('\n'), [text]);
  if (lines.length > MAX_COLOURED_LINES) {
    return <>{text}</>;
  }
  return (
    <>
      {lines.map((line, i) => {
        const cls = lineClass(line);
        return (
          <span key={i} className={cls || undefined}>
            {line}
            {i < lines.length - 1 ? '\n' : ''}
          </span>
        );
      })}
    </>
  );
}

interface CommandOutput {
  success: boolean;
  exitCode: number;
  output: string;
  message: string;
}

interface HistoryEntry {
  command: string;
  output: string;
  success: boolean;
  timestamp: string;
  /** Undefined while the command is still running. */
  exitCode?: number;
}

interface TermState {
  lines: HistoryEntry[];
  input: string;
  history: string[];
  historyIdx: number;
  running: boolean;
}

export default function CommandPanel({ caseName, onScriptStarted }: {
  caseName: string;
  /** Called when a case script was launched in the background, so the shell
   *  can hand the user over to the Monitor tab. */
  onScriptStarted?: () => void;
}) {
  const [term, setTerm] = useState<TermState>({
    lines: [], input: '', history: [], historyIdx: -1, running: false,
  });
  const [termHeight, setTermHeight] = useState(380);
  const resizing = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  // ── Following a running command ──
  //
  // Chunks arrive as fast as the process writes, so they are buffered in a ref
  // and flushed on a timer: one re-render every 80 ms instead of one per write,
  // which is the difference between a readable stream of text and a stuttering
  // page.
  //
  // A TIMER and not requestAnimationFrame, which was the first attempt and was
  // wrong. rAF does not run while a window is hidden or occluded — the same
  // property the mesh viewer documents — so a minimised app, or one behind
  // another window, would buffer the whole run and paint it in one go at the
  // end. Which is exactly the behaviour this change exists to remove. Measured:
  // with rAF the transcript stayed empty for all eight seconds of a
  // once-a-second command and filled in at the end; with the timer it grows as
  // the output arrives.
  const pendingRef = useRef('');
  const flushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const FLUSH_MS = 80;
  // Whether to keep the view pinned to the newest line. Set false the moment
  // the user scrolls up — following the output must never fight someone
  // reading it — and back to true when they return to the bottom.
  const stickRef = useRef(true);
  const [stuck, setStuck] = useState(true);

  // ── Sidebar state ──
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

  // ── Active OpenFOAM version (for dynamic command filtering) ──
  // null  = unknown / WSL offline  → show ALL commands (fallback)
  // number = major version (e.g. 14) → filter commands by minVersion
  const [foamMajorVersion, setFoamMajorVersion] = useState<number | null>(null);
  const [foamVersionRaw, setFoamVersionRaw] = useState<string>('');
  const [versionLoading, setVersionLoading] = useState<boolean>(true);

  // Fetch the active OpenFOAM version once on mount, and again whenever the
  // caseName changes (switching case can imply a different setup). We also
  // listen for the custom 'foam-version-changed' event dispatched by the
  // Dashboard after setOpenFOAMVersion() so the sidebar updates immediately.
  useEffect(() => {
    let cancelled = false;
    const fetchVersion = async () => {
      try {
        const res = await fetch('/api/wsl?action=version');
        if (!res.ok) throw new Error('version endpoint failed');
        const data = await res.json();
        const raw = typeof data.version === 'string' ? data.version : '';
        if (cancelled) return;
        setFoamVersionRaw(raw);
        setFoamMajorVersion(parseMajorVersion(raw));
      } catch {
        if (cancelled) return;
        setFoamVersionRaw('');
        setFoamMajorVersion(null);
      } finally {
        if (!cancelled) setVersionLoading(false);
      }
    };
    fetchVersion();

    const onVersionChanged = () => {
      setVersionLoading(true);
      fetchVersion();
    };
    window.addEventListener('foam-version-changed', onVersionChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('foam-version-changed', onVersionChanged);
    };
  }, []);

  // ── The command list, read from the installation ──────────────────────
  //
  // The sidebar used to render a hand-written table filtered by a hand-written
  // minVersion. Measured against the two installations on this machine, 56 of
  // its 103 entries did not exist there and 108 installed executables were
  // missing from it — so the list now comes from $FOAM_APPBIN, the shell
  // utilities beside it and foamToC, with the descriptions and categories the
  // installation carries in its own sources. See src/lib/foam-commands.ts.
  //
  // The static table survives as the fallback for the ~2 s the first build
  // takes, and for a machine where WSL cannot be reached at all.
  const [catalog, setCatalog] = useState<CatalogCommand[] | null>(null);
  const [catalogVersion, setCatalogVersion] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (attempt: number) => {
      try {
        const res = await fetch('/api/commands?action=catalog');
        const data = await res.json();
        if (cancelled) return;
        if (data?.ready && Array.isArray(data.commands) && data.commands.length) {
          setCatalog(data.commands as CatalogCommand[]);
          setCatalogVersion(typeof data.version === 'string' ? data.version : '');
          return;
        }
        // Still building. It is one WSL call, so this is seconds, not minutes —
        // but give up rather than poll forever if WSL never answers.
        if (attempt < 15) timer = setTimeout(() => void poll(attempt + 1), 2000);
      } catch {
        if (!cancelled && attempt < 3) timer = setTimeout(() => void poll(attempt + 1), 3000);
      }
    };
    void poll(0);

    // Switching the selected OpenFOAM version changes the whole list.
    const onVersionChanged = () => { setCatalog(null); void poll(0); };
    window.addEventListener('foam-version-changed', onVersionChanged);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('foam-version-changed', onVersionChanged);
    };
  }, []);

  // ── Allrun / Allclean existence ──
  const [hasAllrun, setHasAllrun] = useState(false);
  const [hasAllclean, setHasAllclean] = useState(false);

  useEffect(() => {
    if (!caseName) return;
    const checkScripts = async () => {
      try {
        const res = await fetch(`/api/cases?action=info&name=${encodeURIComponent(caseName)}`);
        const data = await res.json();
        const rootFiles: string[] = (data.files?._root || []).map((f: any) => f.name);
        setHasAllrun(rootFiles.includes('Allrun'));
        setHasAllclean(rootFiles.includes('Allclean'));
      } catch { /* silent */ }
    };
    checkScripts();
  }, [caseName]);

  // Scroll to page top on mount — never jump down
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, []);

  /** Pin to the bottom, unless the user has scrolled away from it. */
  const scrollToEnd = useCallback(() => {
    const el = containerRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  // A new command always scrolls into view; the first render does not.
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    stickRef.current = true;
    setStuck(true);
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [term.lines.length]);

  // 24 px of slack: a scrollbar that is one or two pixels off the end still
  // counts as "at the bottom", which is what a wheel click leaves behind.
  const onTranscriptScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== stickRef.current) {
      stickRef.current = atBottom;
      setStuck(atBottom);
    }
  }, []);

  const jumpToEnd = useCallback(() => {
    stickRef.current = true;
    setStuck(true);
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Nothing half-flushed survives an unmount.
  useEffect(() => () => {
    if (flushRef.current !== null) clearTimeout(flushRef.current);
  }, []);

  // Keep the newest text in view as it arrives. An effect, not a call inside
  // the flush: this runs after React has committed the new text to the DOM, so
  // scrollHeight is the height that includes it.
  const lastOutputLength = term.lines.length ? term.lines[term.lines.length - 1].output.length : 0;
  useEffect(() => {
    scrollToEnd();
  }, [lastOutputLength, scrollToEnd]);

  // ── Sidebar logic ──
  // The installation's own list when it has answered; the static table,
  // filtered by major version, until then.
  const versionedCommands = useMemo<CatalogCommand[]>(() => {
    if (catalog) return catalog;
    return getCommandsForVersion(foamMajorVersion).map(c => ({
      name: c.name,
      category: c.category,
      description: c.description,
      kind: 'application' as const,
      insert: c.name,
    }));
  }, [catalog, foamMajorVersion]);

  const filteredCommands = useMemo(() => {
    let cmds = versionedCommands;
    if (selectedCategory !== 'all') cmds = cmds.filter(c => c.category === selectedCategory);
    if (searchTerm) {
      const lower = searchTerm.toLowerCase();
      cmds = cmds.filter(c =>
        c.name.toLowerCase().includes(lower) ||
        c.description.toLowerCase().includes(lower) ||
        c.category.toLowerCase().includes(lower)
      );
    }
    return cmds;
  }, [searchTerm, selectedCategory, versionedCommands]);

  // Categories actually present in the versioned subset (so the dropdown
  // doesn't show empty categories like 'Units & Dimensions' on v13).
  const visibleCategories = useMemo(
    () => orderCategories([...new Set(versionedCommands.map(c => c.category))]),
    [versionedCommands]
  );

  const commandsByCategory = useMemo(() => {
    const map: Record<string, CatalogCommand[]> = {};
    for (const cmd of filteredCommands) {
      if (!map[cmd.category]) map[cmd.category] = [];
      map[cmd.category].push(cmd);
    }
    // Rebuilt in display order: Object.entries walks insertion order, which is
    // whatever order the commands happened to arrive in.
    const ordered: Record<string, CatalogCommand[]> = {};
    for (const cat of orderCategories(Object.keys(map))) ordered[cat] = map[cat];
    return ordered;
  }, [filteredCommands]);

  const toggleCategory = (cat: string) => {
    const next = new Set(expandedCategories);
    if (next.has(cat)) next.delete(cat); else next.add(cat);
    setExpandedCategories(next);
  };

  // ── Execute command ──
  const executeCommand = useCallback(async (command: string) => {
    if (!caseName) { toast.error('Select a case first'); return; }
    const trimmed = command.trim();
    if (!trimmed) return;

    setTerm(prev => ({
      ...prev,
      history: [trimmed, ...prev.history.slice(0, 99)],
      historyIdx: -1,
      input: '',
      running: true,
      lines: capEntries([...prev.lines, { command: trimmed, output: '', success: false, timestamp: new Date().toLocaleTimeString() }]),
    }));

    // Append whatever has arrived since the last frame to the entry being
    // written. One re-render per frame, not one per chunk.
    const flush = () => {
      flushRef.current = null;
      const chunk = pendingRef.current;
      if (!chunk) return;
      pendingRef.current = '';
      setTerm(prev => {
        const updated = [...prev.lines];
        const i = updated.length - 1;
        if (i < 0) return prev;
        updated[i] = { ...updated[i], output: capOutput(updated[i].output + chunk) };
        return { ...prev, lines: updated };
      });
      // Scrolling is handled by the effect above, which runs after the text is
      // actually in the DOM.
    };
    const queue = (chunk: string) => {
      pendingRef.current += chunk;
      if (flushRef.current === null) flushRef.current = setTimeout(flush, FLUSH_MS);
    };

    try {
      const res = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName, command: trimmed, parallel: false, nProcs: 1, background: false, stream: true }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`the server refused the command (HTTP ${res.status})`);
      }

      // Newline-delimited JSON. A chunk from the network can split a line in
      // half, so the tail is carried over to the next read.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamed = false;
      let exitCode = 0;
      let finalOutput = '';
      let failure: string | null = null;

      const handle = (raw: string) => {
        const line = raw.trim();
        if (!line) return;
        let msg: { t?: string; d?: string; exitCode?: number; output?: string; message?: string };
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.t === 'out' && typeof msg.d === 'string') {
          streamed = true;
          queue(msg.d);
        } else if (msg.t === 'end') {
          exitCode = typeof msg.exitCode === 'number' ? msg.exitCode : 0;
          finalOutput = typeof msg.output === 'string' ? msg.output : '';
        } else if (msg.t === 'error') {
          failure = msg.message || 'the command could not be started';
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          handle(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      }
      if (buffer) handle(buffer);

      // Land whatever the last timer would have flushed, before closing the entry.
      if (flushRef.current !== null) { clearTimeout(flushRef.current); flushRef.current = null; }
      const tail = pendingRef.current;
      pendingRef.current = '';

      if (failure) throw new Error(failure);

      const success = exitCode === 0;
      setTerm(prev => {
        const updated = [...prev.lines];
        const i = updated.length - 1;
        if (i >= 0) {
          // A background command streams nothing and reports one line, which
          // arrives on the end event instead.
          // Capped here too: `finalOutput` arrives whole on the end event and
          // has not been through the streaming path's cap.
          const body = capOutput(streamed ? updated[i].output + tail : finalOutput);
          updated[i] = { ...updated[i], output: body, success, exitCode };
        }
        return { ...prev, lines: updated, running: false };
      });
      if (success) toast.success('Command completed');
      else toast.error(`Error (exit ${exitCode})`);
      return success;
    } catch (e: any) {
      setTerm(prev => {
        const updated = [...prev.lines];
        const last = updated[updated.length - 1];
        updated[updated.length - 1] = { ...last, output: `Error: ${e.message}`, success: false };
        return { ...prev, lines: updated, running: false };
      });
      toast.error('Error communicating with WSL');
      return false;
    }
  }, [caseName]);

  // ── Case scripts ──────────────────────────────────────────────────────
  // Allrun is launched in the BACKGROUND with its output redirected to
  // log.Allrun, then we hand the user straight to the Monitor tab.
  //
  // Why not stream it into this terminal: an OpenFOAM Allrun drives
  // runApplication/runParallel, which already redirect each application's
  // real output into its own log.<app>. Allrun's own stdout is just a
  // handful of `Running blockMesh on <case>` progress lines, so the useful
  // live view is the Monitor's log tail (1 Hz) over log.Allrun plus the
  // per-application logs that appear there as the run proceeds.
  //
  // The redirect still names the log explicitly even though nothing
  // preselects it: the user picks it from the Monitor's dropdown, and it
  // must not end up called log.bash (see below).
  //
  // The redirect is written out explicitly rather than relying on the
  // server's `background: true` auto-redirect: normalizeCommand() rewrites
  // `./Allrun` to `bash ./Allrun` before the log name is derived, so the
  // automatic name would come out as log.bash.
  //
  // We deliberately do NOT await the request. Confirming that a background
  // process is alive takes ~8s server-side, and the user should land on the
  // Monitor immediately. Success/failure still surfaces as a toast.
  const runAllrun = useCallback(() => {
    if (!caseName) { toast.error('Select a case first'); return; }
    void executeCommand('./Allrun > log.Allrun 2>&1 &');
    onScriptStarted?.();
  }, [caseName, executeCommand, onScriptStarted]);

  // Allclean deletes every generated result in the case, so it keeps a
  // confirmation step — previously the user had to press Enter, which acted
  // as one by accident.
  const runAllclean = useCallback(async () => {
    if (!caseName) { toast.error('Select a case first'); return; }
    const ok = await confirmDialog(
      `Run Allclean on "${caseName}"? This deletes the generated results of the case.`,
      { title: 'Run Allclean', confirmLabel: 'Run Allclean', destructive: true }
    );
    if (!ok) return;
    void executeCommand('./Allclean');
  }, [caseName, executeCommand]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      executeCommand(term.input);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (term.history.length > 0) {
        const i = term.historyIdx < term.history.length - 1 ? term.historyIdx + 1 : term.historyIdx;
        setTerm(prev => ({ ...prev, historyIdx: i, input: prev.history[i] }));
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (term.historyIdx > 0) setTerm(prev => ({ ...prev, historyIdx: term.historyIdx - 1, input: prev.history[term.historyIdx - 1] }));
      else setTerm(prev => ({ ...prev, historyIdx: -1, input: '' }));
    }
  };

  const insertCommand = (cmd: string) => setTerm(prev => ({ ...prev, input: cmd }));

  const quickCommands = [
    { label: 'foamRun', cmd: 'foamRun', icon: <Play className="w-3 h-3" /> },
    { label: 'foamRun > log &', cmd: 'foamRun > log.foamRun 2>&1 &', icon: <Play className="w-3 h-3" /> },
    { label: 'blockMesh', cmd: 'blockMesh', icon: <Grid3x3 className="w-3 h-3" /> },
    // Plain snappyHexMesh: -overwrite is a deprecated no-op on both 13 and 14
    // ("Deprecated option, this is now default behaviour" in its own -help),
    // and overwriting IS the default now — -noOverwrite is the opt-out.
    { label: 'snappyHexMesh', cmd: 'snappyHexMesh', icon: <Grid3x3 className="w-3 h-3" /> },
    { label: 'checkMesh', cmd: 'checkMesh', icon: <Zap className="w-3 h-3" /> },
    { label: 'decomposePar', cmd: 'decomposePar', icon: <Layers className="w-3 h-3" /> },
    { label: 'reconstructPar', cmd: 'reconstructPar', icon: <Layers className="w-3 h-3" /> },
    { label: 'paraFoam', cmd: 'paraFoam', icon: <Grid3x3 className="w-3 h-3" /> },
  ];

  if (!caseName) {
    return (
      <Card className="p-8 text-center text-muted-foreground">
        <TerminalIcon className="w-16 h-16 mx-auto mb-3 opacity-30" />
        <p className="text-sm">Select a case from the Dashboard to run commands</p>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      {/* ═══ Left: Command Browser ═══ */}
      <Card className="flex flex-col lg:col-span-1">
        <CardHeader className="pb-2 pt-3 px-3">
          <CardTitle className="text-sm flex items-center gap-1">
            <TerminalIcon className="w-4 h-4" /> OpenFOAM Commands
            <Badge variant="secondary" className="ml-auto text-[10px] gap-1">
              {versionLoading ? (
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
              ) : (
                <Tag className="w-2.5 h-2.5" />
              )}
              {foamVersionRaw
                ? `v${foamVersionRaw}`
                : (versionLoading ? '…' : 'all')}
            </Badge>
          </CardTitle>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {catalog
              ? `${versionedCommands.length} commands read from the OpenFOAM ${catalogVersion || foamMajorVersion || ''} installation`
              : foamMajorVersion !== null
                ? `Built-in list for OpenFOAM v${foamMajorVersion} (${versionedCommands.length}) — reading the installation…`
                : versionLoading
                  ? 'Detecting version…'
                  : 'Version not detected — showing the built-in list'}
          </p>
          <div className="flex gap-1 mt-2">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
              <Input value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} placeholder="Search command..." className="pl-7 h-7 text-xs" />
            </div>
          </div>
          <Select value={selectedCategory} onValueChange={setSelectedCategory}>
            <SelectTrigger className="h-7 text-xs mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {visibleCategories.map(c => (<SelectItem key={c} value={c}>{c}</SelectItem>))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="p-0 flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="px-2 pb-2">
              {Object.entries(commandsByCategory).map(([cat, cmds]) => (
                <div key={cat} className="mb-1">
                  <button className="w-full flex items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground rounded hover:bg-accent" onClick={() => toggleCategory(cat)}>
                    {expandedCategories.has(cat) ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    {cat} ({cmds.length})
                  </button>
                  {expandedCategories.has(cat) && (
                    <div className="ml-3 space-y-0.5">
                      {cmds.map(cmd => (
                        <button
                          key={cmd.name}
                          className="w-full text-left px-2 py-1 rounded text-xs hover:bg-accent transition-colors"
                          onClick={() => insertCommand(cmd.insert)}
                          title={cmd.description}
                        >
                          <div className="font-mono font-medium flex items-center gap-1">
                            <span className={cmd.superseded ? 'line-through opacity-70' : undefined}>{cmd.name}</span>
                            {cmd.kind === 'solverModule' && (
                              <span className="text-[9px] font-sans font-normal text-muted-foreground">module</span>
                            )}
                          </div>
                          <div className="text-muted-foreground text-[10px] truncate mt-0.5">{cmd.description}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* ═══ Right: Terminal + Quick Commands ═══ */}
      <div className="lg:col-span-2 flex flex-col gap-3">

        {/* ═══ Terminal ═══ */}
        <Card className="flex flex-col relative" style={{ height: `${termHeight}px` }}>
          {/* Drag handle */}
          <div
            className="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize z-10 flex items-center justify-center group"
            onMouseDown={(e) => {
              e.preventDefault();
              resizing.current = true;
              startY.current = e.clientY;
              startH.current = termHeight;
              document.body.style.cursor = 'ns-resize';
              document.body.style.userSelect = 'none';
              const onMove = (ev: MouseEvent) => {
                if (!resizing.current) return;
                const delta = ev.clientY - startY.current;
                const newH = Math.max(160, Math.min(800, startH.current + delta));
                setTermHeight(newH);
              };
              const onUp = () => {
                resizing.current = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
              };
              document.addEventListener('mousemove', onMove);
              document.addEventListener('mouseup', onUp);
            }}
          >
            <div className="w-10 h-0.5 rounded-full bg-muted-foreground/30 group-hover:bg-muted-foreground/60 transition-colors" />
          </div>
          <CardHeader className="pb-1 pt-2 px-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xs flex items-center gap-1.5">
                <TerminalIcon className="w-3.5 h-3.5 text-green-500" /> Terminal
                <Badge variant="secondary" className="text-[9px] font-mono">{caseName}</Badge>
                {term.running && <Badge variant="default" className="bg-amber-600 text-[9px] animate-pulse">RUNNING</Badge>}
              </CardTitle>
              {term.lines.length > 0 && (
                <Button size="sm" variant="ghost" className="h-5 text-[10px] px-1.5" onClick={() => setTerm(prev => ({ ...prev, lines: [] }))}>
                  <Trash2 className="w-2.5 h-2.5 mr-0.5" /> Clear
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-0 flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 relative overflow-hidden">
            <div
              ref={containerRef}
              onScroll={onTranscriptScroll}
              className="absolute inset-0 overflow-y-auto bg-black/5 dark:bg-black/30 font-mono text-xs p-2 space-y-1.5"
            >
              {term.lines.length === 0 && (
                <div className="text-muted-foreground/50">
                  <span className="text-green-500">$</span> <span className="opacity-60">OpenFOAM Commands: {caseName}</span>
                </div>
              )}
              {term.lines.map((entry, i) => {
                const streaming = i === term.lines.length - 1 && term.running;
                // The block itself is NEUTRAL and the lines carry the colour
                // (see lineClass). The left border is the only thing that
                // reflects the exit status — a summary of the command, rather
                // than a claim about any line in particular.
                //
                // It is also left UNCAPPED while it streams: a second scroll
                // area scrolling on its own inside the first is what makes
                // following output unpleasant. The 300 px cap goes back on once
                // the command has finished and the block is something you read
                // rather than watch.
                const border = streaming ? 'border-amber-500/40'
                  : entry.success ? 'border-green-500/30' : 'border-red-500/40';
                const cap = streaming ? '' : 'max-h-[300px] overflow-y-auto';
                return (
                  <div key={i}>
                    <div className="flex items-center gap-1.5">
                      <span className="text-green-500 select-none">$</span>
                      <span className="text-foreground">{entry.command}</span>
                      <span className="text-muted-foreground/40 ml-auto text-[10px] flex-shrink-0">{entry.timestamp}</span>
                      {streaming ? (
                        <span className="text-[10px] flex-shrink-0 text-amber-500 flex items-center gap-1">
                          <Loader2 className="w-2.5 h-2.5 animate-spin" /> running
                        </span>
                      ) : entry.exitCode !== undefined ? (
                        <span className={`text-[10px] flex-shrink-0 font-mono ${entry.success ? 'text-green-500' : 'text-red-400'}`}>
                          {entry.success ? 'OK' : `exit ${entry.exitCode}`}
                        </span>
                      ) : null}
                    </div>
                    {(entry.output || streaming) && (
                      <pre className={`mt-0.5 ml-3 whitespace-pre-wrap break-words text-[11px] border-l-2 pl-2 text-foreground/80 ${border} ${cap}`}>
                        <OutputBlock text={entry.output} />
                        {streaming && (
                          <span className="inline-block w-1.5 h-3 align-middle bg-amber-500/70 animate-pulse" />
                        )}
                      </pre>
                    )}
                  </div>
                );
              })}
              <div ref={endRef} />
            </div>

            {/* Shown only while something is running AND the user has scrolled
                away from the end — anywhere else it is a button that does
                nothing, sitting on top of the output. */}
            {!stuck && term.running && (
              <button
                onClick={jumpToEnd}
                className="absolute bottom-2 right-3 z-10 rounded-full border bg-card/95 px-2 py-1 text-[10px] shadow-sm hover:bg-accent"
              >
                ↓ follow output
              </button>
            )}
            </div>
            <div className="border-t bg-card">
              <div className="flex items-center gap-2 p-1.5">
                <span className="text-green-500 font-mono text-xs font-bold select-none">$</span>
                <input value={term.input} onChange={(e) => setTerm(prev => ({ ...prev, input: e.target.value }))} onKeyDown={handleKeyDown} placeholder={`${caseName} $`} className="flex-1 font-mono text-xs bg-transparent focus:outline-none placeholder:text-muted-foreground/40" disabled={term.running} spellCheck={false} />
                <Button size="sm" className="h-6 px-2" disabled={term.running || !term.input.trim()} onClick={() => executeCommand(term.input)}><Send className="w-3 h-3" /></Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ═══ Quick Commands ═══ */}
        <Card className="p-2.5">
          <Label className="text-[10px] font-medium mb-1.5 block text-muted-foreground">Quick Commands (click to insert)</Label>
          <div className="flex flex-wrap gap-1">
            {quickCommands.map(qc => (
              <Button key={qc.cmd} size="sm" variant="outline" className="h-5 text-[10px] px-1.5" onClick={() => insertCommand(qc.cmd)}>{qc.icon} {qc.label}</Button>
            ))}
          </div>
          {/* Allrun / Allclean — only shown if the script file exists */}
          {(hasAllrun || hasAllclean) && (
            <div className="mt-1.5 pt-1.5 border-t">
              <Label className="text-[10px] font-medium mb-1 block text-muted-foreground">Case scripts</Label>
              <div className="flex flex-wrap gap-1">
                {hasAllrun && (
                  <Button size="sm" variant="default" className="h-5 text-[10px] px-1.5 bg-green-600 hover:bg-green-700"
                    onClick={runAllrun} disabled={term.running}
                    title="Run Allrun in the background and follow it in the Monitor tab">
                    <Play className="w-3 h-3 mr-0.5" /> Allrun
                  </Button>
                )}
                {hasAllclean && (
                  <Button size="sm" variant="default" className="h-5 text-[10px] px-1.5 bg-red-600 hover:bg-red-700"
                    onClick={runAllclean} disabled={term.running}
                    title="Delete the generated results of this case">
                    <Trash2 className="w-3 h-3 mr-0.5" /> Allclean
                  </Button>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

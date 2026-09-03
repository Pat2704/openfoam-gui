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
import { COMMAND_CATEGORIES, getCommandsForVersion, parseMajorVersion, type OpenFOAMCommand } from '@/lib/openfoam-data';

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

  // Auto-scroll only inside the terminal container, skip first render
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [term.lines]);

  // ── Sidebar logic ──
  // Filter the master list by active OpenFOAM version first, then by the
  // user's search/category selection.
  const versionedCommands = useMemo(
    () => getCommandsForVersion(foamMajorVersion),
    [foamMajorVersion]
  );

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
  const visibleCategories = useMemo(() => {
    const present = new Set(versionedCommands.map(c => c.category));
    return COMMAND_CATEGORIES.filter(c => present.has(c));
  }, [versionedCommands]);

  const commandsByCategory = useMemo(() => {
    const map: Record<string, OpenFOAMCommand[]> = {};
    for (const cmd of filteredCommands) {
      if (!map[cmd.category]) map[cmd.category] = [];
      map[cmd.category].push(cmd);
    }
    return map;
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
      lines: [...prev.lines, { command: trimmed, output: '', success: false, timestamp: new Date().toLocaleTimeString() }],
    }));

    try {
      const res = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName, command: trimmed, parallel: false, nProcs: 1, background: false }),
      });
      const data: CommandOutput = await res.json();
      setTerm(prev => {
        const updated = [...prev.lines];
        const last = updated[updated.length - 1];
        updated[updated.length - 1] = { ...last, output: data.output || data.message, success: data.success };
        return { ...prev, lines: updated, running: false };
      });
      if (data.success) toast.success(data.message);
      else toast.error(`Error (exit ${data.exitCode})`);
      return data.success;
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
            {foamMajorVersion !== null
              ? `List filtered for OpenFOAM v${foamMajorVersion} (${versionedCommands.length} commands)`
              : versionLoading
                ? 'Detecting version…'
                : 'Version not detected — showing all commands'}
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
                        <button key={cmd.name} className="w-full text-left px-2 py-1 rounded text-xs hover:bg-accent transition-colors" onClick={() => insertCommand(cmd.name)}>
                          <div className="font-mono font-medium">{cmd.name}</div>
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
            <div ref={containerRef} className="flex-1 overflow-y-auto bg-black/5 dark:bg-black/30 font-mono text-xs p-2 space-y-1.5">
              {term.lines.length === 0 && (
                <div className="text-muted-foreground/50">
                  <span className="text-green-500">$</span> <span className="opacity-60">OpenFOAM Commands: {caseName}</span>
                </div>
              )}
              {term.lines.map((entry, i) => (
                <div key={i}>
                  <div className="flex items-center gap-1.5">
                    <span className="text-green-500 select-none">$</span>
                    <span className="text-foreground">{entry.command}</span>
                    <span className="text-muted-foreground/40 ml-auto text-[10px] flex-shrink-0">{entry.timestamp}</span>
                    {entry.output && <span className={`text-[10px] flex-shrink-0 ${entry.success ? 'text-green-500' : 'text-red-400'}`}>{entry.success ? 'OK' : 'ERR'}</span>}
                  </div>
                  {entry.output && (
                    <pre className={`mt-0.5 ml-3 whitespace-pre-wrap break-words text-[11px] max-h-[300px] overflow-y-auto border-l-2 pl-2 ${entry.success ? 'border-green-500/30 text-foreground/70' : 'border-red-500/30 text-red-300'}`}>{entry.output}</pre>
                  )}
                </div>
              ))}
              <div ref={endRef} />
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

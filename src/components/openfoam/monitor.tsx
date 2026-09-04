'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import {
  Activity, RefreshCw, Monitor as MonitorIcon, Clock,
  Terminal, Skull, Search, XCircle, StopCircle, Cpu,
  LineChart as LineChartIcon, AlertTriangle, CheckCircle2, XCircle as XCircleIcon, Loader2, Timer, Trash2,
  Shield
} from 'lucide-react';
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine
} from 'recharts';
import { confirmDialog } from '@/components/ui/confirm-host';

interface ProcessRow {
  pid: string; user: string; cpu: string; mem: string;
  vsz: string; rss: string; stat: string; start: string; time: string;
  etimes: string; // elapsed seconds from process start
  startDatetime: string; // DD/MM HH:mm
  command: string;
  cwd?: string; // working directory of the process — used to tell which case it belongs to
}

// A process belongs to the active case when its working directory is the case
// directory (runDir/caseName). We match on the path tail so we don't need to
// know runDir on the client. Falls back to "unknown" when cwd is unavailable
// (older backend or readlink denied) — those processes are kept in the list but
// never counted as running for the active case, avoiding false "RUNNING" badges.
function isProcessForCase(p: ProcessRow, caseName: string): boolean {
  if (!p.cwd || !caseName) return false;
  const cwd = p.cwd.replace(/\/+$/, '');
  // Match the case dir itself, anything ending in /<caseName> (e.g. run/cavity),
  // or anything UNDER the case dir (e.g. run/cavity/processor0 for decomposed
  // parallel runs where each rank keeps its cwd in a processor subdir).
  return cwd === caseName
    || cwd.endsWith('/' + caseName)
    || cwd.includes('/' + caseName + '/');
}

// Derive a short case label from a process cwd (last path segment).
function caseFromCwd(cwd?: string): string {
  if (!cwd) return '';
  const trimmed = cwd.replace(/\/+$/, '');
  const seg = trimmed.split('/').pop() || '';
  return seg;
}

// Parse residuals from log content (last timestep only — used for inline display)
function parseResiduals(log: string): { time: string; values: { field: string; iters: string; residual: string }[] } | null {
  const lines = log.split('\n');
  let lastTimeIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].match(/Time\s*=\s*/)) {
      lastTimeIdx = i;
      break;
    }
  }
  if (lastTimeIdx < 0) return null;

  const timeMatch = lines[lastTimeIdx].match(/Time\s*=\s*([^\s\n]+)/);
  const time = timeMatch ? timeMatch[1] : '';

  const values: { field: string; iters: string; residual: string }[] = [];
  for (let i = lastTimeIdx + 1; i < lines.length && i < lastTimeIdx + 30; i++) {
    const line = lines[i];
    // Format 1 (most common): "solverName:  Solving for FIELD, Initial residual = X, ... No Iterations N"
    const m0 = line.match(/\bSolving\s+for\s+(\S+),\s+Initial\s+residual\s*=\s*(\S+),.*No\s+Iterations\s+(\d+)/i);
    if (m0) {
      values.push({ field: m0[1], iters: m0[3], residual: m0[2] });
      continue;
    }
    // Format 2: "field: iter = N residual = VALUE"
    const m = line.match(/^(\S+)\s*:\s*iter\s*=\s*(\d+)\s*residual\s*=\s*(\S+)/);
    if (m) {
      values.push({ field: m[1], iters: m[2], residual: m[3] });
      continue;
    }
    // Format 3: "field  iters  residual" (legacy tabular)
    const m2 = line.match(/^([A-Za-z_][\w.]*)\s+(\d+)\s+([\d.eE+\-]+)/);
    if (m2 && !line.includes('Time') && !line.includes('PIMPLE') && !line.includes('SIMPLE')) {
      values.push({ field: m2[1], iters: m2[2], residual: m2[3] });
    }
  }

  if (values.length === 0) return null;
  return { time, values };
}

// ── Residual Chart: parse ALL timesteps from full log ──
interface ResidualPoint {
  time: number;
  [field: string]: number | undefined;
}

const RESIDUAL_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#6366f1',
];

function parseAllResiduals(log: string): { data: ResidualPoint[]; fields: string[] } {
  const lines = log.split('\n');
  const fieldSet = new Set<string>();
  const dataMap = new Map<number, ResidualPoint>();

  let currentTime = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const timeMatch = line.match(/^Time\s*=\s*([\d.eE+\-]+)/);
    if (timeMatch) {
      currentTime = parseFloat(timeMatch[1]);
      if (!isNaN(currentTime) && !dataMap.has(currentTime)) {
        dataMap.set(currentTime, { time: currentTime });
      }
      continue;
    }
    if (currentTime < 0) continue;

    // ── Format 1 (MOST COMMON): "solverName:  Solving for FIELD, Initial residual = X, ..." ──
    // e.g. "smoothSolver:  Solving for Ux, Initial residual = 0.01, Final residual = 1e-05, No Iterations 3"
    // e.g. "GAMG:  Solving for p, Initial residual = 1, Final residual = 0.001, No Iterations 5"
    const m0 = line.match(/\bSolving\s+for\s+(\S+),\s+Initial\s+residual\s*=\s*([\d.eE+\-]+)/i);
    if (m0) {
      const pt = dataMap.get(currentTime);
      if (pt) { pt[m0[1]] = parseFloat(m0[2]); fieldSet.add(m0[1]); }
      continue;
    }

    // ── Format 2: "field: iter = N residual = VALUE" (some foamRun output) ──
    const m1 = line.match(/^(\S+)\s*:\s*iter\s*=\s*\d+\s*residual\s*=\s*([\d.eE+\-]+)/);
    if (m1) {
      const pt = dataMap.get(currentTime);
      if (pt) { pt[m1[1]] = parseFloat(m1[2]); fieldSet.add(m1[1]); }
      continue;
    }

    // ── Format 3: "field  iters  residual" (legacy tabular solver output) ──
    const m2 = line.match(/^([A-Za-z_][\w.]*)\s+\d+\s+([\d.eE+\-]+)/);
    if (m2 && !line.includes('Time') && !line.includes('PIMPLE') && !line.includes('SIMPLE')) {
      const pt = dataMap.get(currentTime);
      if (pt) { pt[m2[1]] = parseFloat(m2[2]); fieldSet.add(m2[1]); }
    }
  }

  const data = Array.from(dataMap.values()).sort((a, b) => a.time - b.time);
  return { data, fields: Array.from(fieldSet) };
}

function getLastSimTime(log: string): string {
  const matches = log.match(/Time\s*=\s*([^\s\n]+)/g);
  if (!matches || matches.length === 0) return '';
  const last = matches[matches.length - 1];
  const m = last.match(/Time\s*=\s*([^\s\n]+)/);
  return m ? m[1] : '';
}

function getLastResidualLine(log: string): string {
  const lines = log.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.match(/^(Ux|Uy|Uz|p|k|epsilon|omega|nuTilda|p_rgh|alpha\.water|T)\s/) && !l.includes('Time =')) {
      return l.trim();
    }
    if (l.match(/^\S+\s*:\s*iter\s*=/) && !l.includes('Time')) {
      return l.trim();
    }
  }
  return '';
}

function formatElapsed(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function Monitor({ caseName, active = true }: {
  caseName: string;
  /** False while another tab is on screen. The component stays mounted so
   *  switching back is instant, but all polling stops — otherwise four
   *  timers would keep spawning wsl.exe in the background forever. */
  active?: boolean;
}) {
  const [selectedLog, setSelectedLog] = useState<string | null>(null);
  const [availableLogs, setAvailableLogs] = useState<string[]>([]);
  const [logContent, setLogContent] = useState('');
  const [tailLines, setTailLines] = useState('200');
  const [processes, setProcesses] = useState<ProcessRow[]>([]);
  const [timeSteps, setTimeSteps] = useState<string[]>([]);
  const [killingPid, setKillingPid] = useState<string | null>(null);
  const [killingAll, setKillingAll] = useState(false);
  // Tracks which case is currently being killed (by case name) so the per-case
  // "Kill case" button can show a spinner and disable itself while in flight.
  const [killingCase, setKillingCase] = useState<string | null>(null);
  const [logSearch, setLogSearch] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const fastIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const slowIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const logListIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // ── Request deduplication: prevent overlapping fetches ──
  const fetchingLogsRef = useRef(false);
  const fetchingProcsRef = useRef(false);
  const fetchingTsRef = useRef(false);
  const fetchingLogListRef = useRef(false);
  // ── Visibility tracking: pause polling when tab is hidden ──
  const [documentVisible, setDocumentVisible] = useState(true);
  // Poll only when the window is visible AND this tab is the active one.
  const isVisible = documentVisible && active;

  // ── Residual Chart state ──
  const [showResidualChart, setShowResidualChart] = useState(false);
  const [residualChartLoading, setResidualChartLoading] = useState(false);
  const [residualData, setResidualData] = useState<{ data: ResidualPoint[]; fields: string[] }>({ data: [], fields: [] });
  const [residualLog, setResidualLog] = useState<string>(''); // log file used for chart


  // ── Delete timesteps ──
  const [deletingTimesteps, setDeletingTimesteps] = useState(false);
  const handleDeleteTimesteps = async () => {
    if (timeSteps.length <= 1) { toast.info('No timesteps to delete'); return; }
    if (!(await confirmDialog(`Delete ${timeSteps.length - 1} timestep folders (all except 0/)?`, { title: 'Delete timesteps', confirmLabel: 'Delete', destructive: true }))) return;
    setDeletingTimesteps(true);
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deleteTimesteps' }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(data.message);
        fetchTimeSteps();
      } else toast.error('Error');
    } catch { toast.error('Error'); }
    setDeletingTimesteps(false);
  };

  const simStartTimeRef = useRef<number | null>(null);
  const lastSyncRef = useRef<number>(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Derive real start time from process etimes (actual wall-clock from ps)
  // Only syncs on first detection or every 30s to avoid jitter from network delay
  const syncElapsedFromProcesses = useCallback((procs: ProcessRow[]) => {
    if (procs.length === 0) return;
    const et = parseInt(procs[0].etimes);
    if (isNaN(et)) return;
    const now = Date.now();
    const shouldSync = simStartTimeRef.current === null || (now - lastSyncRef.current) > 30000;
    if (shouldSync) {
      // Compensate for ~200ms average round-trip delay
      simStartTimeRef.current = now - et * 1000 - 200;
      lastSyncRef.current = now;
      setElapsedSeconds(et);
    }
  }, []);

  // ── Fetch full log for residual chart ──
  const fetchResidualChart = useCallback(async (logOverride?: string) => {
    if (!caseName) return;
    // Priority: explicit override > dropdown selectedLog > first available log > abort
    const logFile = logOverride || selectedLog || availableLogs[0] || '';
    if (!logFile) {
      toast.error('No log file available for this case');
      return;
    }
    setResidualLog(logFile);
    setResidualChartLoading(true);
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}?action=residuals&log=${encodeURIComponent(logFile)}&maxLines=50000`);
      const data = await res.json();
      const content = data.content || '';
      if (content.startsWith('Log not found')) {
        setResidualData({ data: [], fields: [] });
        toast.error(`Log not found: ${logFile}`);
      } else {
        const parsed = parseAllResiduals(content);
        setResidualData(parsed);
      }
    } catch {
      setResidualData({ data: [], fields: [] });
    }
    setResidualChartLoading(false);
  }, [caseName, selectedLog, availableLogs]);

  // Keep the residual chart on the log the user is actually looking at.
  // Opening a different log used to leave the chart showing the previous
  // one's data (or nothing at all), because the chart was only fetched by
  // its own dropdown / the Show Chart button.
  //
  // Depends only on the selection, NOT on fetchResidualChart: that callback
  // depends on availableLogs, which the 2s log-list poll can replace — and
  // this effect would then refetch and reparse a 50k-line log every tick.
  const residualFetchRef = useRef(fetchResidualChart);
  // Declared before the effect below so it runs first: effects fire in
  // declaration order, so the ref is always up to date when the refetch fires.
  useEffect(() => { residualFetchRef.current = fetchResidualChart; }, [fetchResidualChart]);
  useEffect(() => {
    if (!showResidualChart || !selectedLog) return;
    residualFetchRef.current(selectedLog);
  }, [selectedLog, showResidualChart, caseName]);

  const fetchLogs = useCallback(async () => {
    if (!caseName || !selectedLog || fetchingLogsRef.current) return;
    fetchingLogsRef.current = true;
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}?action=logs&log=${encodeURIComponent(selectedLog)}&tail=${tailLines}`);
      const data = await res.json();
      setLogContent(data.content || '');
      const logs: string[] = data.availableLogs || [];
      setAvailableLogs(logs);
    } catch { /* silent */ }
    fetchingLogsRef.current = false;
  }, [caseName, selectedLog, tailLines]);

  // Fetch available log file list (without content).
  // Keeps the previous array when the contents are unchanged: this runs on a
  // timer, and handing back a new array every tick would change the identity
  // of every callback that depends on availableLogs, re-firing their effects
  // for nothing.
  const fetchLogList = useCallback(async () => {
    if (!caseName || fetchingLogListRef.current) return;
    fetchingLogListRef.current = true;
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}?action=listLogs`);
      const data = await res.json();
      const logs: string[] = data.availableLogs || [];
      setAvailableLogs(prev =>
        prev.length === logs.length && prev.every((l, i) => l === logs[i]) ? prev : logs
      );
    } catch { /* silent */ }
    fetchingLogListRef.current = false;
  }, [caseName]);

  const fetchProcesses = useCallback(async () => {
    if (!caseName || fetchingProcsRef.current) return;
    fetchingProcsRef.current = true;
    try {
      const res = await fetch('/api/wsl?action=processes');
      const data = await res.json();
      setProcesses(data.processes || []);
    } catch { /* silent */ }
    fetchingProcsRef.current = false;
  }, [caseName]);

  const fetchTimeSteps = useCallback(async () => {
    if (!caseName || fetchingTsRef.current) return;
    fetchingTsRef.current = true;
    try {
      const res = await fetch(`/api/cases?action=timesteps&name=${encodeURIComponent(caseName)}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTimeSteps(data.timeSteps || []);
    } catch { /* silent */ }
    fetchingTsRef.current = false;
  }, [caseName]);

  const killProcess = async (pid: string) => {
    setKillingPid(pid);
    setProcesses(prev => prev.filter(p => p.pid !== pid));
    try {
      const res = await fetch(`/api/wsl?action=kill&pid=${pid}`);
      const data = await res.json();
      if (data.killed) {
        toast.success(`PID ${pid} stopped (SIGKILL)`);
      } else {
        toast.error(`PID ${pid}: ${data.result}`);
        fetchProcesses();
      }
    } catch {
      toast.error(`Unable to kill ${pid}`);
      fetchProcesses();
    }
    setKillingPid(null);
  };

  const killAll = async () => {
    if (!(await confirmDialog(`Kill all ${processes.length} OpenFOAM processes?`, { title: 'Kill all processes', confirmLabel: 'Kill all', destructive: true }))) return;
    setKillingAll(true);
    try {
      const res = await fetch('/api/wsl?action=killAll');
      const data = await res.json();
      if (data.killed > 0) {
        toast.success(`${data.killed} processes killed`);
        setProcesses([]);
      } else {
        toast.info('No processes killed');
        fetchProcesses();
      }
    } catch {
      toast.error('Error during kill all');
      fetchProcesses();
    }
    setKillingAll(false);
  };

  // Kill every OpenFOAM process whose working directory belongs to `targetCase`.
  // Uses the per-case kill endpoint (resolves /proc/<pid>/cwd server-side), so
  // other cases keep running untouched.
  const killCase = async (targetCase: string) => {
    if (!targetCase) return;
    if (!(await confirmDialog(`Kill all processes of case "${targetCase}"? Other cases will not be interrupted.`, { title: 'Kill case processes', confirmLabel: 'Kill', destructive: true }))) return;
    setKillingCase(targetCase);
    try {
      const res = await fetch(`/api/wsl?action=killCase&name=${encodeURIComponent(targetCase)}`);
      const data = await res.json();
      if (data.killed > 0) {
        toast.success(`${data.killed} processes of "${targetCase}" killed`);
      } else {
        toast.info(`No active processes for "${targetCase}"`);
      }
      fetchProcesses();
    } catch {
      toast.error(`Error during kill of "${targetCase}"`);
      fetchProcesses();
    }
    setKillingCase(null);
  };

  // Initial load — fetch log list + processes + timesteps, but NOT log content
  useEffect(() => {
    const load = async () => {
      await fetchLogList();
      await fetchProcesses();
      await fetchTimeSteps();
    };
    load();
  }, [fetchLogList, fetchProcesses, fetchTimeSteps]);

  // Split processes three ways for accurate status:
  //  - caseProcesses: cwd resolved AND matches the active case → green RUNNING.
  //  - otherProcesses: cwd resolved but belongs to a different case → amber "other cases".
  //  - unknownProcesses: cwd could NOT be resolved (readlink denied/failed) → amber
  //    "unknown case". Without this bucket, a total readlink failure would
  //    make the Monitor look Idle even while a solver is running — the exact
  //    regression the user reported ("cases start but I don't see anything active").
  const caseProcesses = processes.filter(p => isProcessForCase(p, caseName));
  const otherProcesses = processes.filter(p => !!p.cwd && !isProcessForCase(p, caseName));
  const unknownProcesses = processes.filter(p => !p.cwd);
  const isRunning = caseProcesses.length > 0;
  const hasOtherRunning = otherProcesses.length > 0;
  const hasUnknownActive = unknownProcesses.length > 0 && !isRunning;

  // Sync real elapsed from ps etimes when process list changes
  useEffect(() => {
    if (isRunning) {
      syncElapsedFromProcesses(caseProcesses);
    } else {
      // Reset when no longer running
      simStartTimeRef.current = null;
      lastSyncRef.current = 0;
    }
  }, [isRunning, caseProcesses, syncElapsedFromProcesses]);

  // Timer tick: 250ms for smooth display, only when running
  useEffect(() => {
    if (!isRunning) {
      if (timerIntervalRef.current) { clearInterval(timerIntervalRef.current); timerIntervalRef.current = null; }
      setElapsedSeconds(0);
      return;
    }
    // Only start client-side interpolation if we have a reference point
    if (simStartTimeRef.current === null) return;
    timerIntervalRef.current = setInterval(() => {
      if (simStartTimeRef.current !== null) {
        setElapsedSeconds((Date.now() - simStartTimeRef.current) / 1000);
      }
    }, 1000);
    return () => { if (timerIntervalRef.current) { clearInterval(timerIntervalRef.current); timerIntervalRef.current = null; } };
  }, [isRunning]);

  // ── Visibility handler: pause all intervals when tab is hidden ──
  useEffect(() => {
    const onVisChange = () => setDocumentVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisChange);
    return () => document.removeEventListener('visibilitychange', onVisChange);
  }, []);

  // Auto-refresh: processes every 1s (always running when case is selected + visible)
  // SEPARATED from log refresh — processes should update even without a selected log.
  // This fixes the bug where the monitor didn't auto-update when a process started
  // (the old code required selectedLog to be set before starting the interval).
  useEffect(() => {
    if (!caseName) return;
    const procInterval = setInterval(() => {
      if (!isVisible) return;
      fetchProcesses();
    }, 1000);
    return () => clearInterval(procInterval);
  }, [fetchProcesses, caseName, isVisible]);

  // Auto-refresh: log content every 1s (only when a log is selected + visible)
  useEffect(() => {
    if (!caseName || !selectedLog) return;
    fastIntervalRef.current = setInterval(() => {
      if (!isVisible) return;
      fetchLogs();
    }, 1000);
    return () => { if (fastIntervalRef.current) { clearInterval(fastIntervalRef.current); fastIntervalRef.current = null; } };
  }, [fetchLogs, isRunning, caseName, selectedLog, isVisible]);

  // Auto-refresh: the list of log files every 2s.
  // A run creates log files as it reaches each application (log.Allrun, then
  // log.blockMesh, log.foamRun, ...). Without this the dropdown only picked
  // them up on mount, so new logs appeared only after leaving the tab and
  // coming back. Cheaper than the log content poll — it is a single find.
  useEffect(() => {
    if (!caseName) return;
    logListIntervalRef.current = setInterval(() => {
      if (!isVisible) return;
      fetchLogList();
    }, 2000);
    return () => { if (logListIntervalRef.current) { clearInterval(logListIntervalRef.current); logListIntervalRef.current = null; } };
  }, [caseName, fetchLogList, isVisible]);

  // Timestep folders are the most direct indication of solver progress.
  // Poll below one second so newly written times appear almost immediately.
  useEffect(() => {
    if (!caseName) return;
    slowIntervalRef.current = setInterval(() => {
      if (!isVisible) return;
      fetchTimeSteps();
    }, 750);
    return () => { if (slowIntervalRef.current) { clearInterval(slowIntervalRef.current); slowIntervalRef.current = null; } };
  }, [caseName, fetchTimeSteps, isVisible]);

  // Refresh immediately when the user returns to the browser tab.
  useEffect(() => {
    if (caseName && isVisible) fetchTimeSteps();
  }, [caseName, isVisible, fetchTimeSteps]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [logContent]);

  // When selectedLog changes, fetch its content
  useEffect(() => {
    if (selectedLog) {
      setLogContent('');
      setLogSearch('');
      setShowSearch(false);
      fetchLogs();
    } else {
      setLogContent('');
    }
  }, [selectedLog]);

  const simTime = useMemo(() => getLastSimTime(logContent), [logContent]);
  const lastTimestepResidual = useMemo(() => parseResiduals(logContent), [logContent]);
  const lastResLine = useMemo(() => getLastResidualLine(logContent), [logContent]);

  const getFilteredLog = () => {
    if (!logSearch.trim()) return logContent;
    const lines = logContent.split('\n');
    const term = logSearch.toLowerCase();
    const matched = lines.filter(l => l.toLowerCase().includes(term));
    if (matched.length === 0) return `// No matches for "${logSearch}"\n// Original log has ${lines.length} lines`;
    return `// Found ${matched.length}/${lines.length} lines matching "${logSearch}"\n${'─'.repeat(60)}\n${matched.join('\n')}`;
  };

  if (!caseName) {
    return (
      <div className="flex items-center justify-center py-12 px-4">
        <div className="bg-muted/20 rounded-2xl p-8 sm:p-10 max-w-lg w-full text-center space-y-6 border border-border/30">
          <MonitorIcon className="w-16 h-16 mx-auto text-primary/30" />
          <div className="space-y-2">
            <h2 className="text-xl font-semibold tracking-tight">Simulation Monitor</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Monitor residual convergence, running processes and OpenFOAM simulation logs — all in real time.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-background/60 rounded-lg p-4 border border-border/40 hover:border-blue-500/30 transition-colors">
              <LineChartIcon className="w-8 h-8 mx-auto mb-2 text-blue-500/50" />
              <p className="text-xs font-semibold">Residuals</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Real-time convergence chart</p>
            </div>
            <div className="bg-background/60 rounded-lg p-4 border border-border/40 hover:border-orange-500/30 transition-colors">
              <Cpu className="w-8 h-8 mx-auto mb-2 text-orange-500/50" />
              <p className="text-xs font-semibold">Processes</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">CPU, memory and solver status</p>
            </div>
            <div className="bg-background/60 rounded-lg p-4 border border-border/40 hover:border-green-500/30 transition-colors">
              <Terminal className="w-8 h-8 mx-auto mb-2 text-green-500/50" />
              <p className="text-xs font-semibold">Log</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Log viewing and search</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground/50">
            Select a case from the Dashboard to begin
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3" style={{ minHeight: '600px' }}>
      {/* ═══ Status bar ═══ */}
      {/* Same green as the Dashboard's environment strip, and correct in both
          themes — this was the other place still using a dark-only value. */}
      <Card className={`p-3 ${isRunning ? 'border-success/40 bg-success-soft' : 'border-muted'}`}>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3 flex-wrap">
            <div className={`w-2.5 h-2.5 rounded-full ${isRunning ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground'}`} />
            <span className="font-semibold text-sm">{caseName}</span>
            {isRunning ? (
              <Badge variant="default" className="bg-green-600 text-[10px]">RUNNING</Badge>
            ) : (
              <Badge variant="secondary" className="text-[10px]">Idle</Badge>
            )}
            {isRunning && caseProcesses.length > 0 && (
              <Badge variant="outline" className="text-[10px] border-green-500/40 text-green-500">
                {caseProcesses.length} proc {caseProcesses.length === 1 ? 'of case' : 'of case'}
              </Badge>
            )}
            {/* Heads-up: other cases are running, but this one is idle. */}
            {hasOtherRunning && !isRunning && (
              <Badge variant="outline" className="text-[10px] border-amber-500/50 text-amber-500 bg-amber-500/10">
                <Activity className="w-2.5 h-2.5 mr-1" />{otherProcesses.length} proc in other cases
              </Badge>
            )}
            {/* Fallback: processes exist but their cwd couldn't be resolved, so we
                can't tell which case they belong to. Show them as "active (unknown
                case)" in amber rather than a misleading Idle — so the user always
                sees that something IS running. This is the safety net for when
                readlink /proc/<pid>/cwd is denied or unavailable. */}
            {hasUnknownActive && (
              <Badge variant="outline" className="text-[10px] border-amber-500/50 text-amber-500 bg-amber-500/10">
                <Activity className="w-2.5 h-2.5 mr-1 animate-pulse" />{unknownProcesses.length} proc active (case ?)
              </Badge>
            )}
            {/* Kill ONLY the active case's processes — leaves other cases running. */}
            {isRunning && (
              <Button size="sm" variant="destructive" className="h-7 text-[11px] px-2.5"
                disabled={killingCase === caseName} onClick={() => killCase(caseName)}>
                {killingCase === caseName ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Skull className="w-3 h-3 mr-1" />}
                {killingCase === caseName ? '...' : 'Kill case'}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 font-mono text-sm">
              <StopCircle className={`w-3.5 h-3.5 ${isRunning ? 'text-green-500' : 'text-muted-foreground'}`} />
              <span className={isRunning ? 'text-green-400 font-bold' : 'text-muted-foreground'}>
                {isRunning ? formatElapsed(elapsedSeconds) : '0:00'}
              </span>
            </div>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { fetchLogs(); fetchProcesses(); fetchTimeSteps(); fetchLogList(); }}>
              <RefreshCw className="w-3 h-3 mr-1" /> Refresh
            </Button>
          </div>
        </div>
      </Card>

      {/* ═══ Live timestep progress ═══ */}
      <Card className="p-3 border-info/25">
          <div className="flex items-center justify-between mb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-info" /> Generated timesteps
              <Badge variant="secondary" className="text-[9px]">{timeSteps.length}</Badge>
              {/* LIVE means live. This badge was rendered unconditionally, with
                  its dot pulsing, whether or not anything was running — so it
                  said "LIVE" at an idle case and the one piece of motion on the
                  screen carried no information. It now appears only while a
                  solver of this case is actually writing timesteps, which is the
                  moment it is worth looking at. */}
              {isRunning && (
                <span className="flex items-center gap-1 text-[9px] font-medium text-success">
                  <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse motion-reduce:animate-none" /> LIVE
                </span>
              )}
            </CardTitle>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">
              {timeSteps.length > 0 ? `${timeSteps[0]} → ${timeSteps[timeSteps.length - 1]}` : 'Waiting for first timestep'}
              </span>
              <Button size="sm" variant="destructive" className="h-7 text-[10px] px-2"
                onClick={handleDeleteTimesteps} disabled={deletingTimesteps || isRunning || timeSteps.length <= 1}
                title="Delete all timestep folders except 0/">
                <Trash2 className="w-3 h-3 mr-0.5" />{deletingTimesteps ? '...' : 'Clean TS'}
              </Button>
            </div>
          </div>
          {timeSteps.length > 0 ? <div className="overflow-x-auto">
            <div className="flex gap-1 pb-2 w-max min-w-full">
              {timeSteps.map((ts, i) => {
                const isFirst = i === 0;
                const isLast = i === timeSteps.length - 1;
                return (
                  <Badge key={`ts-${i}-${ts}`}
                    variant={isLast ? 'default' : 'outline'}
                    /* Same meaning as before — blue marks the first time
                       written, green the latest — from the tokens, so both are
                       legible in dark mode. `border-blue-300` is a light-mode
                       border that all but vanished on the dark ground, which is
                       why the row read as one lone green square with nothing
                       before it. */
                    className={`text-[10px] font-mono flex-shrink-0 ${isFirst ? 'border-info/40 text-info' : ''} ${isLast ? 'bg-success text-white border-success' : ''}`}>
                    {ts}
                  </Badge>
                );
              })}
            </div>
          </div> : (
            <div className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
              The case's time folders (0, 0.1, 1, …) will appear here automatically.
            </div>
          )}
          {simTime && timeSteps.length > 0 && simTime !== timeSteps[timeSteps.length - 1] && (
            <p className="mt-1 text-[10px] text-amber-500">Solver log at time {simTime}; last timestep written to disk: {timeSteps[timeSteps.length - 1]}.</p>
          )}
        </Card>

      {/* ═══ Process Table ═══ */}
      <Card>
        <CardHeader className="pb-2 pt-3 px-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <Activity className="w-4 h-4" /> Processes
              {processes.length > 0 && (
                <Badge variant="secondary" className="text-[9px]">{processes.length} total</Badge>
              )}
              {caseProcesses.length > 0 && (
                <Badge variant="default" className="bg-green-600 text-[9px]">{caseProcesses.length} {caseName}</Badge>
              )}
              {otherProcesses.length > 0 && (
                <Badge variant="outline" className="text-[9px] border-amber-500/50 text-amber-600 bg-amber-500/10">{otherProcesses.length} others</Badge>
              )}
            </CardTitle>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={fetchProcesses}>
                <RefreshCw className="w-3 h-3" />
              </Button>
              {processes.length > 0 && (
                <Button size="sm" variant="destructive" className="h-6 text-[10px] px-2"
                  disabled={killingAll} onClick={killAll}>
                  <Skull className="w-3 h-3 mr-0.5" />{killingAll ? '...' : `Kill All (${processes.length})`}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-3 pb-3">
          {processes.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-muted-foreground text-[10px]">
                    <th className="text-left py-1 pr-2 font-medium">PID</th>
                    <th className="text-left py-1 pr-2 font-medium">CASE</th>
                    <th className="text-left py-1 pr-2 font-medium">START</th>
                    <th className="text-right py-1 pr-2 font-medium">CPU%</th>
                    <th className="text-right py-1 pr-2 font-medium">MEM%</th>
                    <th className="text-left py-1 pr-2 font-medium">STAT</th>
                    <th className="text-left py-1 pr-2 font-medium">TIME</th>
                    <th className="text-left py-1 font-medium">COMMAND</th>
                    <th className="text-right py-1 font-medium"> </th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    // Render the per-case "Kill case" button only on the first
                    // row of each case, so the button appears once per case
                    // right next to its name (the user asked for it "next to
                    // the case"). Processes are pre-sorted so the active case
                    // comes first, putting its kill button at the top.
                    const seen = new Set<string>();
                    const sorted = [...processes].sort((a, b) => {
                      const am = isProcessForCase(a, caseName) ? 0 : 1;
                      const bm = isProcessForCase(b, caseName) ? 0 : 1;
                      if (am !== bm) return am - bm;
                      return parseInt(a.pid) - parseInt(b.pid);
                    });
                    return sorted.map(p => {
                    const isMine = isProcessForCase(p, caseName);
                    const pCase = caseFromCwd(p.cwd);
                    const isFirstOfCase = !!pCase && !seen.has(pCase);
                    if (pCase) seen.add(pCase);
                    return (
                    <tr key={p.pid} className={`border-b border-muted/30 hover:bg-muted/20 ${isMine ? 'bg-green-500/5' : ''}`}>
                      <td className="py-1.5 pr-2 font-mono font-bold text-orange-500">{p.pid}</td>
                      <td className="py-1.5 pr-2 font-mono text-[10px]">
                        {pCase ? (
                          <div className="flex items-center gap-1">
                            <span className={isMine ? 'text-green-600 font-semibold' : 'text-amber-600'} title={p.cwd}>{pCase}</span>
                            {isFirstOfCase && (
                              <button
                                className="inline-flex items-center justify-center text-destructive hover:text-red-700 disabled:opacity-40"
                                title={`Kill all processes of ${pCase}`}
                                disabled={killingCase === pCase}
                                onClick={() => killCase(pCase)}
                              >
                                {killingCase === pCase
                                  ? <Loader2 className="w-3 h-3 animate-spin" />
                                  : <Skull className="w-3 h-3" />}
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground italic">?</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-xs text-muted-foreground whitespace-nowrap">{p.startDatetime}</td>
                      <td className="py-1.5 pr-2 text-right font-mono">
                        <span className={parseFloat(p.cpu) > 50 ? 'text-red-400 font-bold' : ''}>{p.cpu}%</span>
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono">
                        <span className={parseFloat(p.mem) > 30 ? 'text-yellow-400 font-bold' : ''}>{p.mem}%</span>
                      </td>
                      <td className="py-1.5 pr-2">
                        <Badge variant="outline" className="text-[9px] h-5 px-1.5">{p.stat}</Badge>
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-muted-foreground">{p.time}</td>
                      <td className="py-1.5 pr-2 font-mono max-w-[300px] truncate" title={p.command}>{p.command}</td>
                      <td className="py-1.5 text-right">
                        <Button size="sm" variant="destructive" className="h-6 text-[10px] px-2"
                          disabled={killingPid === p.pid} onClick={() => killProcess(p.pid)}>
                          <Skull className="w-3 h-3 mr-0.5" />{killingPid === p.pid ? '...' : 'Kill'}
                        </Button>
                      </td>
                    </tr>
                    );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-6">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-muted/30 mb-3">
                <Activity className="w-6 h-6 text-muted-foreground/40" />
              </div>
              <p className="text-sm text-muted-foreground font-medium">No active OpenFOAM processes</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Start a simulation to see its processes here</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ═══ Residual Plot ═══ */}
      <Card>
        <CardHeader className="pb-2 pt-3 px-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <LineChartIcon className="w-4 h-4" /> Residual Plot
            </CardTitle>
            <div className="flex items-center gap-2">
              {/* residualLog is the log the plotted data came from, so it leads:
                  showing selectedLog while another log's curves are on screen is
                  what made the chart look broken. */}
              {showResidualChart && availableLogs.length > 0 && (
                <Select value={residualLog || selectedLog || availableLogs[0]} onValueChange={(v) => fetchResidualChart(v)}>
                  <SelectTrigger className="w-36 h-7 text-xs font-mono">
                    <SelectValue placeholder="Log..." />
                  </SelectTrigger>
                  <SelectContent>
                    {availableLogs.map((l: string) => (
                      <SelectItem key={l} value={l}>{l === 'foamRun' ? 'foamRun (v13)' : l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button size="sm" variant={showResidualChart ? 'default' : 'outline'} className="h-7 text-xs"
                onClick={() => { if (!showResidualChart) { setShowResidualChart(true); fetchResidualChart(); } else { setShowResidualChart(false); } }}>
                {showResidualChart ? 'Hide' : 'Show'} Chart
              </Button>
              {showResidualChart && (
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => fetchResidualChart()} disabled={residualChartLoading}>
                  <RefreshCw className={`w-3 h-3 mr-1 ${residualChartLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        {showResidualChart && (
          <CardContent className="px-3 pb-3">
            {residualChartLoading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
                <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Loading residuals from <span className="font-mono mx-1">{residualLog || '...'}</span>...
              </div>
            ) : residualData.fields.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                <LineChartIcon className="w-10 h-10 mx-auto mb-2 opacity-20" />
                <p>No residuals found in log</p>
                <p className="text-xs mt-1">Select a simulation log from the dropdown above and press Refresh</p>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>{residualData.data.length} timestep</span>
                  <span>|</span>
                  <span>{residualData.fields.length} fields</span>
                  <span>|</span>
                  <span>Log Y scale</span>
                </div>
                <div className="rounded-lg border border-border/40 p-2 bg-muted/5 min-h-[250px]">
                  <ResponsiveContainer width="100%" height={380}>
                    {/* ComposedChart, not LineChart: this plots an Area (the
                        gradient fill) together with a Line per field, and
                        LineChart only accepts Line as a graphical child — the
                        Area/Line pairs were silently dropped, which is why the
                        chart drew axes and grid but no curves. */}
                    <ComposedChart data={residualData.data} margin={{ top: 10, right: 10, left: 10, bottom: 45 }}>
                      <defs>
                        {residualData.fields.map((field, i) => (
                          <linearGradient key={field} id={`fill-${i}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={RESIDUAL_COLORS[i % RESIDUAL_COLORS.length]} stopOpacity={0.15} />
                            <stop offset="95%" stopColor={RESIDUAL_COLORS[i % RESIDUAL_COLORS.length]} stopOpacity={0.01} />
                          </linearGradient>
                        ))}
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                      <XAxis
                        dataKey="time"
                        tick={{ fontSize: 9 }}
                        tickCount={8}
                        label={{ value: 'Time (s)', position: 'insideBottom', offset: -5, fontSize: 10 }}
                        scale="linear"
                        type="number"
                        domain={[0, 'dataMax']}
                        allowDataOverflow
                      />
                      <YAxis
                        scale="log"
                        tick={{ fontSize: 9 }}
                        ticks={[1, 1e-1, 1e-2, 1e-3, 1e-4, 1e-5, 1e-6, 1e-7, 1e-8]}
                        tickFormatter={(v: number) => v.toExponential(0)}
                        label={{ value: 'Residual', angle: -90, position: 'insideLeft', offset: -5, fontSize: 10 }}
                        domain={[1e-8, 1]}
                        allowDataOverflow
                      />
                      <Tooltip
                        // The tokens in globals.css are complete colours —
                        // `--popover: oklch(1 0 0)` — not the bare HSL triplets
                        // the `hsl(var(--x))` idiom expects. Wrapping them
                        // produced `hsl(oklch(1 0 0))`, which is not a valid
                        // colour, so the browser dropped both declarations and
                        // the tooltip had NO background: its text drew straight
                        // over the residual curves and was unreadable exactly
                        // when it was wanted, on a busy part of the chart.
                        contentStyle={{
                          fontSize: 11,
                          backgroundColor: 'var(--popover)',
                          color: 'var(--popover-foreground)',
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                        }}
                        formatter={(value: number) => value.toExponential(3)}
                        labelFormatter={(label: number) => `Time = ${label}`}
                      />
                      <Legend
                        verticalAlign="bottom"
                        align="center"
                        iconSize={10}
                        wrapperStyle={{ fontSize: 10, paddingTop: 8 }}
                      />
                      <ReferenceLine y={1e-6} stroke="#22c55e" strokeDasharray="6 3" label={{ value: '1e-6', fontSize: 9, fill: '#22c55e', position: 'left' }} />
                      {/* Flat array, NOT <React.Fragment> per field: Recharts
                          discovers its graphical children by scanning the chart's
                          direct children, and a Fragment hides them — the chart
                          then drew axes, grid and an empty legend but no curves
                          at all. React flattens arrays, so this is equivalent JSX
                          without the wrapper element. */}
                      {residualData.fields.flatMap((field, i) => [
                        <Area
                          key={`area-${field}`}
                          type="monotone"
                          dataKey={field}
                          stroke="none"
                          fill={`url(#fill-${i})`}
                          connectNulls
                          isAnimationActive={false}
                          /* the Area is only the gradient under the curve; without
                             this it registers a second legend entry per field */
                          legendType="none"
                          tooltipType="none"
                        />,
                        <Line
                          key={`line-${field}`}
                          type="monotone"
                          dataKey={field}
                          stroke={RESIDUAL_COLORS[i % RESIDUAL_COLORS.length]}
                          strokeWidth={1.5}
                          dot={false}
                          connectNulls
                          isAnimationActive={false}
                        />,
                      ])}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* ═══ Log Viewer ═══ */}
      <Card>
        <CardHeader className="pb-2 pt-3 px-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <Terminal className="w-4 h-4" /> Log Viewer
              {selectedLog && showLog && <Badge variant="secondary" className="text-[9px]">log.{selectedLog}</Badge>}
            </CardTitle>
            <div className="flex items-center gap-2">
              {showLog && (
                <Select value={selectedLog || ''} onValueChange={(v) => setSelectedLog(v === '__none__' ? null : v)}>
                  <SelectTrigger className="w-48 h-7 text-xs font-mono">
                    <SelectValue placeholder="Select a log file..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— No log —</SelectItem>
                    {availableLogs.length > 0 ? availableLogs.map((l: string) => (
                      <SelectItem key={l} value={l}>{l === 'foamRun' ? 'foamRun (v13)' : l}</SelectItem>
                    )) : null}
                  </SelectContent>
                </Select>
              )}
              {showLog && selectedLog && (
                <>
                  <Button size="sm" variant={showSearch ? 'default' : 'ghost'} className="h-7 text-xs px-2"
                    onClick={() => setShowSearch(!showSearch)}>
                    <Search className="w-3 h-3 mr-1" /> Search
                  </Button>
                  <div className="flex items-center gap-1">
                    <Label className="text-[10px] text-muted-foreground">Lines:</Label>
                    <Select value={tailLines} onValueChange={setTailLines}>
                      <SelectTrigger className="w-20 h-7 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="50">50</SelectItem>
                        <SelectItem value="100">100</SelectItem>
                        <SelectItem value="200">200</SelectItem>
                        <SelectItem value="500">500</SelectItem>
                        <SelectItem value="1000">1000</SelectItem>
                        <SelectItem value="5000">5000</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
              <Button size="sm" variant={showLog ? 'default' : 'outline'} className="h-7 text-xs"
                onClick={() => setShowLog(!showLog)}>
                {showLog ? 'Hide' : 'Show'} Log
              </Button>
            </div>
          </div>
          {showLog && showSearch && selectedLog && (
            <div className="flex gap-2 mt-2">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
                <input value={logSearch} onChange={(e) => setLogSearch(e.target.value)}
                  placeholder="Filter log lines..."
                  className="w-full pl-7 pr-2 h-7 text-xs font-mono bg-muted/50 border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
                  autoFocus />
              </div>
              {logSearch && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setLogSearch('')}><XCircle className="w-3 h-3" /></Button>}
            </div>
          )}
        </CardHeader>
        {showLog && (
          <CardContent className="p-0 flex-1 overflow-hidden">
            <div className="relative h-full" style={{ minHeight: '300px' }}>
              {selectedLog ? (
                <pre ref={outputRef}
                  className="absolute inset-0 p-3 text-xs font-mono whitespace-pre-wrap break-words text-foreground/80 overflow-y-auto bg-black/5 dark:bg-black/20 rounded-b-lg">
                  {logContent || 'Loading...'}
                </pre>
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
                  <div className="text-center">
                    <Terminal className="w-12 h-12 mx-auto mb-2 opacity-20" />
                    <p>Select a log file from the dropdown to view its content</p>
                    {availableLogs.length === 0 && <p className="text-xs mt-1 text-muted-foreground">No logs available for this case</p>}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        )}
      </Card>

    </div>
  );
}

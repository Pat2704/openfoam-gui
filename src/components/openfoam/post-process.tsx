'use client';

/**
 * The Post-Process tab: the numbers a solved case produced.
 *
 * WHERE IT SITS between the tabs that already exist, because the overlap is
 * easy to assume and there is none:
 *
 *   Monitor   reads the solver LOG — residuals, iteration counts. Numerics, and
 *             a live run being supervised.
 *   ParaView  shows the FIELDS in 3D. Qualitative, and needs ParaView installed.
 *   Commands  launches a binary and shows its output. It does not know the
 *             function-object catalogue and does not read back what it wrote.
 *   here      reads `postProcessing/` — drag, flow rate, pressure drop, y+,
 *             probe histories, sampled profiles — and can produce those over
 *             times already on disk. Physics, quantitative, ParaView-free.
 *
 * Function objects that write surfaces or VTK are deliberately not charted
 * here; they belong to the ParaView tab, which can already open files from
 * inside the case.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  BarChart3, RefreshCw, Loader2, Play, Search, Table2, LineChart as LineChartIcon,
  Copy, AlertTriangle, Sigma, FolderOpen, X, Info, Radio, ScrollText, Activity, Download,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  describeDatasetName, summarizeColumn, downsampleRows, buildCallTemplate, buildFunctionsEntry,
  buildCommandTemplate, parsePostProcessCommand, POST_PROCESS_NAMES,
} from '@/lib/postprocess';
import { residualsToTable } from '@/lib/residuals';
import ChartExportDialog, { type ChartExportSource } from '@/components/openfoam/chart-export';

interface FileRef { name: string; times: string[]; bytes: number }
interface Dataset { name: string; files: FileRef[] }

/**
 * What is currently on the chart.
 *
 * A function-object file and a solver log are different things on disk and the
 * same thing on screen, so they are named by kind and then handled identically:
 * one chart, one table, one CSV, one export. Adding residuals as a second
 * rendering path would have meant maintaining two of each.
 */
type Selection =
  | { kind: 'dataset'; dataset: string; file: string }
  | { kind: 'log'; log: string };

interface ColumnStats {
  name: string;
  last: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  tailMean: number | null;
  drift: number | null;
  samples: number;
}

interface TableData {
  /** `series` accumulates across time directories; `profile` has one curve in each. */
  mode: 'series' | 'profile';
  columns: string[];
  rows: (number | null)[][];
  totalRows: number;
  stats: ColumnStats[];
  notes: string[];
  /** Every time directory this file appears in. */
  times: string[];
  /** For a profile, the one being shown. */
  shownTime: string | null;
  startTimes: string[];
  incompatible: string[];
  overwritten: number;
  synthesizedColumns: boolean;
  truncated: boolean;
}

interface CatalogArg {
  name: string;
  kind: 'number' | 'point' | 'fieldList' | 'patchList' | 'pointList' | 'text';
  listWrapped: boolean;
  placeholder: string;
  help: string;
  required: boolean;
}

interface CatalogEntry {
  name: string;
  category: string;
  description: string;
  args: CatalogArg[];
}

/** Series colours, matching the palette the Monitor's residual plot uses. */
const SERIES_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#6366f1',
];

/** How many series are turned on when a dataset is first opened. */
const INITIAL_SERIES = 6;

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e5 || magnitude < 1e-3) return value.toExponential(3);
  return value.toPrecision(6).replace(/\.?0+$/, '');
}

/**
 * Axis ticks, at fewer digits than the tooltip.
 *
 * Sampled distances read `0.00201126`, and ten of those along the bottom of the
 * chart collide into an unreadable band. Three significant figures identify a
 * tick; the exact value is one hover away.
 */
function formatTick(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e4 || magnitude < 1e-2) return value.toExponential(1);
  return String(Number(value.toPrecision(3)));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * How settled a quantity is, from the relative change between the last two
 * fifths of the series. The thresholds are a reading aid, not a convergence
 * criterion, and the tooltip says so — a real criterion belongs to the case.
 */
function driftBadge(drift: number | null): { label: string; className: string; title: string } {
  if (drift === null || !Number.isFinite(drift)) {
    return { label: 'n/a', className: 'text-muted-foreground', title: 'Not enough samples to compare two windows' };
  }
  const percent = `${(drift * 100).toPrecision(2)}%`;
  if (drift < 1e-3) return { label: 'settled', className: 'text-success', title: `Last two fifths differ by ${percent}` };
  if (drift < 1e-2) return { label: 'settling', className: 'text-warning', title: `Last two fifths differ by ${percent}` };
  return { label: 'drifting', className: 'text-danger', title: `Last two fifths differ by ${percent}` };
}

/**
 * Read a solver log and present its residuals in the dataset shape.
 *
 * The log endpoint and the residual parser both already exist — the Monitor
 * uses them to watch a run — so this only reshapes, and the chart, the table,
 * the CSV and the image export then treat a log like any other dataset.
 */
async function readResiduals(caseName: string, log: string): Promise<TableData> {
  const response = await fetch(
    `/api/cases/${encodeURIComponent(caseName)}?action=residuals&log=${encodeURIComponent(log)}&maxLines=50000`,
  );
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Could not read the log');

  const { columns, rows } = residualsToTable(payload.content || '');
  // JSON has no NaN, so the API's statistics arrive with nulls where a value
  // could not be computed. Matching that here keeps ONE shape on the client
  // instead of two that differ only in how "no value" is spelled.
  const nullable = (value: number) => (Number.isFinite(value) ? value : null);
  const stats: ColumnStats[] = columns.slice(1).map((name, offset) => {
    const summary = summarizeColumn(rows, offset + 1);
    return {
      name,
      last: nullable(summary.last),
      min: nullable(summary.min),
      max: nullable(summary.max),
      mean: nullable(summary.mean),
      tailMean: nullable(summary.tailMean),
      drift: nullable(summary.drift),
      samples: summary.samples,
    };
  });

  return {
    mode: 'series',
    columns,
    rows: downsampleRows(rows, 4000),
    totalRows: rows.length,
    stats,
    notes: columns.length
      ? [`Initial residuals parsed from log.${log === 'log' ? '' : log}`]
      : ['No residuals found in this log'],
    times: [],
    shownTime: null,
    startTimes: [],
    incompatible: [],
    overwritten: 0,
    synthesizedColumns: false,
    truncated: false,
  };
}

export default function PostProcess({ caseName, active = true }: { caseName: string; active?: boolean }) {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [data, setData] = useState<TableData | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [logScale, setLogScale] = useState(false);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [follow, setFollow] = useState(false);

  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [chosen, setChosen] = useState<CatalogEntry | null>(null);
  /**
   * The two texts the panel is made of, both editable.
   *
   * The command is the whole line, flags included, because the alternative was
   * a pair of input boxes for `-time` and `-fields` sitting beside a call they
   * were not part of. The entry is the controlDict form of the same thing, to
   * copy.
   */
  const [commandText, setCommandText] = useState('');
  const [entryText, setEntryText] = useState('');
  /** The case's own patch names, so an example uses one that exists. */
  const [patches, setPatches] = useState<string[]>([]);
  /** Which spelling of the utility this OpenFOAM has. */
  const [utility, setUtility] = useState<string>(POST_PROCESS_NAMES[0]);
  const [running, setRunning] = useState(false);
  const [runOutput, setRunOutput] = useState<string | null>(null);

  // An in-flight guard per request kind. Without it the follow timer stacks
  // requests on a slow WSL call and the last answer to arrive wins, which is
  // not necessarily the newest one.
  const listInFlight = useRef<Promise<void> | null>(null);
  const dataInFlight = useRef<Promise<void> | null>(null);

  const loadDatasets = useCallback(async (): Promise<void> => {
    if (!caseName) return;
    if (listInFlight.current) return listInFlight.current;
    const request = (async () => {
      setLoadingList(true);
      try {
        // Both lists in one pass: the function-object output and the solver
        // logs, which are the other place a case keeps a plottable history.
        const [datasetsResponse, logsResponse] = await Promise.all([
          fetch(`/api/postprocess?action=list&case=${encodeURIComponent(caseName)}`),
          fetch(`/api/cases/${encodeURIComponent(caseName)}?action=listLogs`),
        ]);
        const payload = await datasetsResponse.json();
        if (!datasetsResponse.ok) throw new Error(payload.error || 'Could not list postProcessing');
        setDatasets(payload.datasets ?? []);
        if (logsResponse.ok) {
          const logPayload = await logsResponse.json();
          setLogs(Array.isArray(logPayload.availableLogs) ? logPayload.availableLogs : []);
        }
        setError(null);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Could not list postProcessing');
      } finally {
        setLoadingList(false);
        listInFlight.current = null;
      }
    })();
    listInFlight.current = request;
    return request;
  }, [caseName]);

  const loadData = useCallback(async (target: Selection, time?: string): Promise<void> => {
    if (!caseName) return;
    if (dataInFlight.current) await dataInFlight.current;
    const request = (async () => {
      setLoadingData(true);
      try {
        if (target.kind === 'log') {
          setData(await readResiduals(caseName, target.log));
        } else {
          const query = new URLSearchParams({
            action: 'data', case: caseName, dataset: target.dataset, file: target.file,
          });
          if (time) query.set('time', time);
          const response = await fetch(`/api/postprocess?${query}`);
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || 'Could not read the dataset');
          setData(payload);
        }
        setError(null);
      } catch (e: unknown) {
        setData(null);
        setError(e instanceof Error ? e.message : 'Could not read the data');
      } finally {
        setLoadingData(false);
        dataInFlight.current = null;
      }
    })();
    dataInFlight.current = request;
    return request;
  }, [caseName]);

  useEffect(() => {
    if (active) void loadDatasets();
  }, [active, loadDatasets]);

  // A new dataset selection starts with the first few series on. Turning all of
  // them on would draw twenty overlapping curves on a probes file and read as
  // noise; the rail on the right makes the rest one click away.
  useEffect(() => {
    if (!selected) return;
    setData(null);
    setHidden(new Set());
    void loadData(selected);
  }, [selected, loadData]);

  useEffect(() => {
    if (!data) return;
    setHidden(previous => (previous.size ? previous : new Set(
      data.columns.map((_, index) => index).filter(index => index > INITIAL_SERIES),
    )));
  }, [data]);

  // Following a running solve. Deliberately a slow poll: function objects write
  // at write time, not every iteration, so a faster one would mostly re-read
  // identical files while a solve is competing for the same WSL pipe.
  useEffect(() => {
    if (!follow || !active) return;
    const timer = setInterval(() => {
      void loadDatasets();
      if (selected) void loadData(selected);
    }, 5000);
    return () => clearInterval(timer);
  }, [follow, active, selected, loadDatasets, loadData]);

  const openCatalog = useCallback(async () => {
    setCatalogOpen(true);
    // The case's own patch names, so an example for a `<patchNames>` argument
    // names a patch that exists instead of the word "patchName".
    if (!patches.length && caseName) {
      void fetch(`/api/cases/${encodeURIComponent(caseName)}?action=caseSummary`)
        .then(response => (response.ok ? response.json() : null))
        .then(summary => { if (Array.isArray(summary?.patches)) setPatches(summary.patches); })
        .catch(() => { /* an example falls back to a placeholder */ });
    }
    if (catalog.length) return;
    try {
      const response = await fetch('/api/postprocess?action=catalog');
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not read the function catalogue');
      setCatalog(payload.entries ?? []);
      // Which spelling this OpenFOAM has, so the command shown is the one that
      // would actually run: v12 renamed postProcess to foamPostProcess.
      if (typeof payload.utility === 'string') setUtility(payload.utility);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not read the function catalogue');
    }
  }, [catalog.length, caseName, patches.length]);

  const chooseFunction = (entry: CatalogEntry) => {
    setChosen(entry);
    setRunOutput(null);
    // Both texts start from what the installation declares: the real argument
    // names, examples taken from each template's own `e.g.` note, and a patch
    // this case actually has. The user edits the text, not a set of invented
    // controls.
    const call = buildCallTemplate(entry.name, entry.args, patches);
    setCommandText(buildCommandTemplate(utility, call));
    setEntryText(buildFunctionsEntry(call));
  };

  const runFunction = async () => {
    if (!caseName || !commandText.trim()) return;
    setRunning(true);
    setRunOutput(null);
    try {
      // Parsed here so a mistake is reported against the line the user is
      // looking at. The server checks every piece again regardless.
      const parsed = parsePostProcessCommand(commandText, catalog.map(entry => entry.name));
      const response = await fetch('/api/postprocess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run', case: caseName, ...parsed }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'The function object could not be run');
      setRunOutput(payload.output || '');
      if (payload.exitCode === 0) {
        toast.success(`${payload.command} finished`);
        await loadDatasets();
      } else {
        toast.error('OpenFOAM reported an error — see the output below');
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'The function object could not be run';
      setRunOutput(message);
      toast.error(message);
    } finally {
      setRunning(false);
    }
  };

  // Recharts resolves a string dataKey through a path lookup, so a `.` or a `[`
  // inside a column name would be read as a nested property. Probe columns are
  // named after their coordinates — `0 (0.005 0.005 0.005)_x` — and every one of
  // them contains dots. The series are therefore keyed by position and the real
  // name is carried separately for the legend and the tooltip.
  const chartRows = useMemo(() => {
    if (!data) return [];
    return data.rows.map(row => {
      const point: Record<string, number | undefined> = { x: row[0] ?? undefined };
      for (let index = 1; index < row.length; index += 1) {
        const value = row[index];
        point[`c${index}`] = value === null || !Number.isFinite(value) ? undefined : value;
      }
      return point;
    });
  }, [data]);

  const visibleSeries = useMemo(() => {
    if (!data) return [];
    return data.columns
      .map((name, index) => ({ name, index }))
      .filter(series => series.index > 0 && !hidden.has(series.index));
  }, [data, hidden]);

  // A log axis cannot show a value that is zero or negative, and recharts draws
  // an empty chart rather than saying so. The control is disabled with the
  // reason on it instead of silently producing a blank plot.
  const logUsable = useMemo(() => {
    if (!data || !visibleSeries.length) return false;
    return data.rows.every(row => visibleSeries.every(series => {
      const value = row[series.index];
      return value === null || !Number.isFinite(value) || value > 0;
    }));
  }, [data, visibleSeries]);

  useEffect(() => {
    if (logScale && !logUsable) setLogScale(false);
  }, [logScale, logUsable]);

  const toggleSeries = (index: number) => {
    setHidden(previous => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const copyCsv = async () => {
    if (!data) return;
    const header = data.columns.join(',');
    const body = data.rows.map(row => row.map(value => (value === null ? '' : value)).join(',')).join('\n');
    try {
      await navigator.clipboard.writeText(`${header}\n${body}\n`);
      toast.success(`${data.rows.length} rows copied as CSV`);
    } catch {
      toast.error('The clipboard is not available');
    }
  };

  const independent = data?.columns[0] ?? 'Time';

  /**
   * What the export dialog draws — the series that are actually on screen, in
   * their on-screen colours. Exporting the hidden ones too would produce a
   * picture the user never chose to look at.
   */
  const exportSource: ChartExportSource | null = useMemo(() => {
    if (!data || !visibleSeries.length || !selected) return null;
    const label = selected.kind === 'log'
      ? `${caseName}-residuals-${selected.log}`
      : `${caseName}-${describeDatasetName(selected.dataset).base}`;
    return {
      columns: data.columns,
      rows: data.rows,
      series: visibleSeries.map(series => ({
        index: series.index,
        name: series.name,
        color: SERIES_COLORS[(series.index - 1) % SERIES_COLORS.length],
      })),
      xLabel: independent,
      // A y axis always gets a name. Leaving it blank whenever more than one
      // series was plotted is what made the exported figure look unlabelled;
      // the dialog lets it be edited, but it starts from something true.
      yLabel: visibleSeries.length === 1
        ? visibleSeries[0].name
        : selected.kind === 'log'
          ? 'Initial residual'
          : describeDatasetName(selected.dataset).base,
      // Residuals are the case where a log axis is almost always wanted, so it
      // starts on for them and otherwise follows the chart on screen.
      logScale: selected.kind === 'log' ? true : logScale,
      fileName: label.replace(/[^A-Za-z0-9._-]+/g, '-'),
      title: selected.kind === 'log'
        ? `${caseName} — initial residuals`
        : `${caseName} — ${describeDatasetName(selected.dataset).base}`,
    };
  }, [data, visibleSeries, selected, caseName, independent, logScale]);
  // What the chart header calls the thing on screen.
  const heading = !selected
    ? null
    : selected.kind === 'log'
      ? { base: `log.${selected.log === 'log' ? '' : selected.log}`.replace(/\.$/, ''), detail: 'initial residuals' }
      : { ...describeDatasetName(selected.dataset), detail: selected.file };

  const filteredCatalog = useMemo(() => {
    const query = catalogQuery.trim().toLowerCase();
    const matching = query
      ? catalog.filter(entry =>
        entry.name.toLowerCase().includes(query)
        || entry.category.toLowerCase().includes(query)
        || entry.description.toLowerCase().includes(query))
      : catalog;
    const groups = new Map<string, CatalogEntry[]>();
    for (const entry of matching) {
      const list = groups.get(entry.category) ?? [];
      list.push(entry);
      groups.set(entry.category, list);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [catalog, catalogQuery]);

  if (!caseName) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <div className="text-center">
          <BarChart3 className="mx-auto mb-2 h-12 w-12 opacity-30" />
          <p>Select a case from the Dashboard to see its post-processing data</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Toolbar ── */}
      <div className="flex h-10 flex-shrink-0 items-center gap-2 border-b bg-muted/20 px-2">
        <BarChart3 className="h-4 w-4 text-brand" />
        <span className="text-sm font-semibold">Post-Process</span>
        <Badge variant="secondary" className="font-mono text-[10px]">{caseName}</Badge>
        <span className="mx-1 h-6 w-px bg-border" />
        <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-xs" onClick={() => void openCatalog()}>
          <Sigma className="h-3.5 w-3.5" /> Compute…
        </Button>
        <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs" disabled={loadingList} onClick={() => void loadDatasets()}>
          <RefreshCw className={`h-3.5 w-3.5 ${loadingList ? 'animate-spin' : ''}`} /> Refresh
        </Button>
        <Button
          size="sm"
          variant={follow ? 'default' : 'ghost'}
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => setFollow(value => !value)}
          title="Re-read every five seconds, to watch a running solve"
        >
          <Radio className="h-3.5 w-3.5" /> Follow
        </Button>
        <div className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
          {loadingData && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {data && <span className="font-mono">{data.totalRows} samples</span>}
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="m-2 mb-0 py-2">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[240px_minmax(320px,1fr)_290px]">
        {/* ── Results ── */}
        <aside className="flex min-h-0 flex-col border-r bg-muted/15">
          <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b px-2 text-xs font-semibold">
            <FolderOpen className="h-3.5 w-3.5" /> Results
            <Badge variant="outline" className="ml-auto text-[9px]">{datasets.length}</Badge>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-1.5">
              {datasets.length === 0 && !loadingList && (
                <p className="px-2 py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
                  Nothing written yet.<br />
                  Use <span className="font-medium text-foreground">Compute…</span> to run a function
                  object over the times this case has already saved.
                </p>
              )}
              {datasets.map(dataset => {
                const described = describeDatasetName(dataset.name);
                return (
                  <div key={dataset.name} className="mb-1.5">
                    <div className="px-1 py-0.5">
                      <div className="truncate text-[11px] font-semibold" title={dataset.name}>{described.base}</div>
                      {described.arguments && (
                        <div className="truncate font-mono text-[9px] text-muted-foreground" title={described.arguments}>
                          {described.arguments}
                        </div>
                      )}
                    </div>
                    {dataset.files.map(file => {
                      const isSelected = selected?.kind === 'dataset'
                        && selected.dataset === dataset.name && selected.file === file.name;
                      return (
                        <button
                          key={file.name}
                          className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] ${isSelected ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                          onClick={() => setSelected({ kind: 'dataset', dataset: dataset.name, file: file.name })}
                        >
                          <LineChartIcon className="h-3 w-3 flex-shrink-0 opacity-70" />
                          <span className="min-w-0 flex-1 truncate" title={file.name}>{file.name}</span>
                          <span className={`text-[8px] ${isSelected ? 'opacity-80' : 'text-muted-foreground'}`}>
                            {file.times.length > 1 ? `${file.times.length} runs` : formatBytes(file.bytes)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}

              {/* ── Solver logs ──
                  The other place a case keeps a plottable history. Kept in the
                  same tree rather than in a tab of its own, because from here a
                  residual history is just another curve to read, compare and
                  export — the live view of the same numbers is the Monitor's. */}
              {logs.length > 0 && (
                <div className="mt-3 border-t pt-2">
                  <div className="flex items-center gap-1.5 px-1 pb-1">
                    <ScrollText className="h-3 w-3 text-muted-foreground" />
                    <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Residuals from logs
                    </span>
                    <Badge variant="outline" className="ml-auto text-[9px]">{logs.length}</Badge>
                  </div>
                  {logs.map(log => {
                    const isSelected = selected?.kind === 'log' && selected.log === log;
                    return (
                      <button
                        key={log}
                        className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] ${isSelected ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                        onClick={() => setSelected({ kind: 'log', log })}
                      >
                        <Activity className="h-3 w-3 flex-shrink-0 opacity-70" />
                        <span className="min-w-0 flex-1 truncate" title={`log.${log}`}>
                          {log === 'log' ? 'log' : `log.${log}`}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </ScrollArea>
        </aside>

        {/* ── Chart ── */}
        <main className="flex min-h-0 flex-col">
          <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b px-2">
            {heading ? (
              <>
                <span className="truncate text-xs font-semibold" title={heading.base}>{heading.base}</span>
                <span className="truncate font-mono text-[10px] text-muted-foreground">{heading.detail}</span>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">No dataset selected</span>
            )}
            {/* A profile has one complete curve per written time, so the time is
                a choice the user makes. A time series has time on its own axis
                and needs no selector at all. */}
            {data?.mode === 'profile' && data.times.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">at</span>
                <Select
                  value={data.shownTime ?? undefined}
                  onValueChange={time => selected && void loadData(selected, time)}
                >
                  <SelectTrigger size="sm" className="h-7 w-28 font-mono text-[10px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {data.times.map(time => (
                      <SelectItem key={time} value={time} className="font-mono text-xs">{time}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-[10px] text-muted-foreground">of {data.times.length}</span>
              </div>
            )}
            <div className="ml-auto flex items-center gap-1">
              <Button
                size="sm"
                variant={logScale ? 'default' : 'ghost'}
                className="h-7 px-2 text-[10px]"
                disabled={!logUsable}
                title={logUsable ? 'Logarithmic Y axis' : 'A log axis needs every visible value to be positive'}
                onClick={() => setLogScale(value => !value)}
              >
                log Y
              </Button>
              <span className="mx-0.5 h-5 w-px bg-border" />
              <Button size="sm" variant={view === 'chart' ? 'default' : 'ghost'} className="h-7 px-2 text-[10px]" onClick={() => setView('chart')}>
                <LineChartIcon className="mr-1 h-3 w-3" /> Chart
              </Button>
              <Button size="sm" variant={view === 'table' ? 'default' : 'ghost'} className="h-7 px-2 text-[10px]" onClick={() => setView('table')}>
                <Table2 className="mr-1 h-3 w-3" /> Table
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px]" disabled={!data} onClick={() => void copyCsv()}>
                <Copy className="mr-1 h-3 w-3" /> CSV
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[10px]"
                disabled={!exportSource}
                title="Save the chart as a picture, after adjusting how it should look"
                onClick={() => setExportOpen(true)}
              >
                <Download className="mr-1 h-3 w-3" /> Save chart
              </Button>
            </div>
          </div>

          {data && (data.incompatible.length > 0 || data.synthesizedColumns || data.truncated || data.startTimes.length > 1) && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-b bg-info-soft/40 px-3 py-1.5 text-[10px] text-muted-foreground">
              {data.startTimes.length > 1 && (
                <span className="inline-flex items-center gap-1">
                  <Info className="h-3 w-3" />
                  Stitched from {data.startTimes.length} runs ({data.startTimes.join(', ')})
                  {data.overwritten > 0 && ` — ${data.overwritten} recomputed ${data.overwritten === 1 ? 'row' : 'rows'} taken from the later run`}
                </span>
              )}
              {data.incompatible.length > 0 && (
                <span className="text-warning">Runs {data.incompatible.join(', ')} left out: their columns differ</span>
              )}
              {data.synthesizedColumns && <span className="text-warning">Column names were not in the file and have been numbered</span>}
              {data.truncated && <span className="text-warning">The file was too large to read in full</span>}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-hidden p-2">
            {!selected ? (
              <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
                <div>
                  <LineChartIcon className="mx-auto mb-2 h-10 w-10 opacity-20" />
                  <p className="text-xs">Pick a result on the left, or compute one</p>
                </div>
              </div>
            ) : !data ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {loadingData ? <Loader2 className="h-5 w-5 animate-spin" /> : 'No readable data in this file'}
              </div>
            ) : view === 'chart' ? (
              <ResponsiveContainer width="100%" height="100%">
                {/* ComposedChart for the same reason the Monitor uses one: it
                    accepts a mixed set of graphical children without silently
                    dropping them. */}
                <ComposedChart data={chartRows} margin={{ top: 8, right: 16, left: 8, bottom: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis
                    dataKey="x"
                    type="number"
                    scale="linear"
                    domain={['dataMin', 'dataMax']}
                    tick={{ fontSize: 9 }}
                    tickCount={7}
                    // tickCount alone is only a hint on a numeric axis: recharts
                    // thins labels by minTickGap, whose default of 5px let a
                    // 2000-sample residual log print forty overlapping times
                    // along the bottom.
                    minTickGap={45}
                    tickFormatter={formatTick}
                    label={{ value: independent, position: 'insideBottom', offset: -12, fontSize: 10 }}
                  />
                  <YAxis
                    scale={logScale ? 'log' : 'linear'}
                    domain={['auto', 'auto']}
                    tick={{ fontSize: 9 }}
                    width={64}
                    tickFormatter={formatTick}
                    allowDataOverflow={false}
                  />
                  <Tooltip
                    // `--popover` is a complete colour, not the bare triplet the
                    // `hsl(var(--x))` idiom expects; wrapping it produces an
                    // invalid colour and the tooltip loses its background, over
                    // the curves, exactly where it is needed. Documented in the
                    // Monitor for the same reason.
                    contentStyle={{
                      fontSize: 11,
                      backgroundColor: 'var(--popover)',
                      color: 'var(--popover-foreground)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                    }}
                    formatter={(value: number, key: string) => {
                      const index = Number(key.slice(1));
                      return [formatNumber(value), data.columns[index] ?? key];
                    }}
                    labelFormatter={(label: number) => `${independent} = ${formatNumber(label)}`}
                  />
                  {visibleSeries.map(series => (
                    <Line
                      key={series.index}
                      type="monotone"
                      dataKey={`c${series.index}`}
                      name={series.name}
                      stroke={SERIES_COLORS[(series.index - 1) % SERIES_COLORS.length]}
                      strokeWidth={1.6}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <ScrollArea className="h-full rounded border">
                <table className="w-full border-collapse text-[10px]">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      {data.columns.map((column, index) => (
                        <th key={index} className="border-b px-2 py-1 text-left font-mono font-medium" title={column}>{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.slice(0, 1000).map((row, rowIndex) => (
                      <tr key={rowIndex} className="hover:bg-muted/50">
                        {row.map((value, columnIndex) => (
                          <td key={columnIndex} className="border-b border-border/40 px-2 py-0.5 font-mono">{formatNumber(value)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {data.rows.length > 1000 && (
                  <p className="px-2 py-1.5 text-[10px] text-muted-foreground">
                    Showing the first 1000 of {data.rows.length} plotted samples — use CSV for all of them.
                  </p>
                )}
              </ScrollArea>
            )}
          </div>
        </main>

        {/* ── Series and their numbers ── */}
        <aside className="flex min-h-0 flex-col border-l bg-muted/15">
          <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b px-2 text-xs font-semibold">
            <Sigma className="h-3.5 w-3.5" /> Series
            {data && <Badge variant="outline" className="ml-auto text-[9px]">{visibleSeries.length}/{data.columns.length - 1}</Badge>}
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-1.5 p-2">
              {!data && <p className="px-1 py-4 text-center text-[10px] text-muted-foreground">Nothing selected</p>}
              {data?.stats.map((stat, position) => {
                const index = position + 1;
                const isHidden = hidden.has(index);
                const colour = SERIES_COLORS[(index - 1) % SERIES_COLORS.length];
                const badge = driftBadge(stat.drift);
                return (
                  <div key={stat.name} className={`rounded border px-2 py-1.5 ${isHidden ? 'opacity-50' : 'bg-background/60'}`}>
                    <div className="flex items-center gap-1.5">
                      <Checkbox
                        id={`series-${index}`}
                        checked={!isHidden}
                        onCheckedChange={() => toggleSeries(index)}
                      />
                      <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ backgroundColor: colour }} />
                      <Label htmlFor={`series-${index}`} className="min-w-0 flex-1 cursor-pointer truncate font-mono text-[10px]" title={stat.name}>
                        {stat.name}
                      </Label>
                    </div>
                    <dl className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 pl-6 text-[9px]">
                      <dt className="text-muted-foreground">last</dt>
                      <dd className="text-right font-mono">{formatNumber(stat.last)}</dd>
                      <dt className="text-muted-foreground" title="Mean over the final fifth of the series">tail mean</dt>
                      <dd className="text-right font-mono">{formatNumber(stat.tailMean)}</dd>
                      <dt className="text-muted-foreground">min / max</dt>
                      <dd className="truncate text-right font-mono">{formatNumber(stat.min)} / {formatNumber(stat.max)}</dd>
                      <dt className="text-muted-foreground">drift</dt>
                      <dd className={`text-right font-medium ${badge.className}`} title={badge.title}>{badge.label}</dd>
                    </dl>
                  </div>
                );
              })}
              {data?.notes.length ? (
                <div className="mt-2 rounded border border-dashed px-2 py-1.5">
                  <div className="mb-1 text-[9px] font-semibold uppercase text-muted-foreground">From the file</div>
                  {data.notes.map((note, index) => (
                    <div key={index} className="truncate font-mono text-[9px] text-muted-foreground" title={note}>{note}</div>
                  ))}
                </div>
              ) : null}
            </div>
          </ScrollArea>
        </aside>
      </div>

      {/* ── The function-object catalogue ── */}
      <Dialog open={catalogOpen} onOpenChange={setCatalogOpen}>
        {/* `sm:max-w-5xl`, not `max-w-5xl`: DialogContent's own base class is
            `sm:max-w-lg`, and tailwind-merge keeps a breakpoint variant and a
            bare utility as separate declarations — so a plain `max-w-5xl` loses
            to it at every width above 640px and the catalogue opened into a
            narrow column. Overriding the SAME variant is what replaces it. */}
        <DialogContent className="flex h-[80vh] sm:max-w-5xl flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="flex-shrink-0 border-b px-4 py-3">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Sigma className="h-4 w-4 text-brand" />
              Compute a quantity
              <Badge variant="secondary" className="ml-1 text-[10px]">{catalog.length} available</Badge>
            </DialogTitle>
          </DialogHeader>

          <div className="grid min-h-0 flex-1 grid-cols-[260px_1fr] overflow-hidden">
            <div className="flex min-h-0 flex-col border-r">
              <div className="flex-shrink-0 p-2">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={catalogQuery}
                    onChange={event => setCatalogQuery(event.target.value)}
                    placeholder="Search — forces, probes, yPlus…"
                    className="h-8 pl-7 text-xs"
                  />
                </div>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="p-1.5">
                  {filteredCatalog.map(([category, entries]) => (
                    <div key={category} className="mb-2">
                      <div className="px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{category}</div>
                      {entries.map(entry => (
                        <button
                          key={`${category}/${entry.name}`}
                          className={`block w-full truncate rounded px-1.5 py-1 text-left text-[11px] ${chosen?.name === entry.name ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                          onClick={() => chooseFunction(entry)}
                          title={entry.description}
                        >
                          {entry.name}
                        </button>
                      ))}
                    </div>
                  ))}
                  {!filteredCatalog.length && (
                    <p className="px-2 py-6 text-center text-[10px] text-muted-foreground">Nothing matches that search</p>
                  )}
                </div>
              </ScrollArea>
            </div>

            <div className="flex min-h-0 flex-col">
              {!chosen ? (
                <div className="flex h-full items-center justify-center px-8 text-center text-xs text-muted-foreground">
                  <div>
                    <Sigma className="mx-auto mb-2 h-8 w-8 opacity-20" />
                    <p>Pick a function object.</p>
                    <p className="mt-1">The list, the descriptions and the example call are read from
                      the OpenFOAM installation itself, so they match the version in use.</p>
                  </div>
                </div>
              ) : (
                <ScrollArea className="min-h-0 flex-1">
                  <div className="space-y-3 p-4">
                    <div>
                      <h3 className="font-mono text-sm font-semibold">{chosen.name}</h3>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{chosen.description || 'No description in the template.'}</p>
                    </div>

                    {/* ── Two editable texts, and nothing else to fill in ──
                        The command is the whole line, flags included: a pair of
                        boxes for -time and -fields used to sit beside a call
                        they were not part of, which is what made them read as
                        noise. Editing the line is editing the run. */}
                    <div>
                      <div className="flex items-center gap-2">
                        <Label htmlFor="pp-command" className="text-[11px]">Run it now, over the times already written</Label>
                        <Button
                          size="sm" variant="ghost" className="ml-auto h-6 px-1.5 text-[10px]"
                          onClick={() => setCommandText(buildCommandTemplate(utility, buildCallTemplate(chosen.name, chosen.args, patches)))}
                        >
                          <RefreshCw className="mr-1 h-3 w-3" /> Reset
                        </Button>
                        <Button
                          size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]"
                          onClick={() => { void navigator.clipboard.writeText(commandText).then(() => toast.success('Copied')); }}
                        >
                          <Copy className="mr-1 h-3 w-3" /> Copy
                        </Button>
                      </div>
                      <Textarea
                        id="pp-command"
                        value={commandText}
                        onChange={event => setCommandText(event.target.value)}
                        spellCheck={false}
                        className="mt-1 h-20 font-mono text-xs"
                      />
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <Label htmlFor="pp-entry" className="text-[11px]">Or run it during the solve</Label>
                        <Button
                          size="sm" variant="ghost" className="ml-auto h-6 px-1.5 text-[10px]"
                          onClick={() => setEntryText(buildFunctionsEntry(buildCallTemplate(chosen.name, chosen.args, patches)))}
                        >
                          <RefreshCw className="mr-1 h-3 w-3" /> Reset
                        </Button>
                        <Button
                          size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]"
                          onClick={() => { void navigator.clipboard.writeText(entryText).then(() => toast.success('Copied')); }}
                        >
                          <Copy className="mr-1 h-3 w-3" /> Copy
                        </Button>
                      </div>
                      <Textarea
                        id="pp-entry"
                        value={entryText}
                        onChange={event => setEntryText(event.target.value)}
                        spellCheck={false}
                        className="mt-1 h-24 font-mono text-[11px]"
                      />
                      <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                        Paste into <code className="font-mono">system/controlDict</code>, or add the
                        <code className="mx-1 font-mono">#includeFunc</code> line to the
                        <code className="mx-1 font-mono">functions</code> block already there. The app never
                        edits your controlDict.
                      </p>
                    </div>

                    {/* ── How to write it ── */}
                    <div className="rounded border">
                      <div className="border-b bg-muted/40 px-2 py-1 text-[9px] font-semibold uppercase text-muted-foreground">
                        Syntax
                      </div>
                      <div className="space-y-2 px-2 py-2 text-[10px] leading-relaxed text-muted-foreground">
                        <p>
                          A function object is written <code className="font-mono">name(arg=value, arg=value)</code>,
                          or just <code className="font-mono">name</code> when it takes none. Vectors and lists
                          go in brackets: <code className="font-mono">start=(0 0 0)</code>,
                          <code className="mx-1 font-mono">fields=(p U)</code>.
                        </p>
                        <p>
                          Fields may also be listed positionally at the end, which is how the tutorials
                          write them: <code className="font-mono">cellMin(name=pMin, p)</code>.
                        </p>
                        <p>
                          <code className="font-mono">name=</code> sets the output directory. Without it the
                          results land in one named after the whole call with its spaces stripped out,
                          which cannot be read back.
                        </p>
                        <p>
                          The command accepts <code className="font-mono">-func</code> plus
                          <code className="mx-1 font-mono">-time 5:</code> (also
                          <code className="mx-1 font-mono">:10</code> or <code className="font-mono">2,4,6</code>),
                          <code className="mx-1 font-mono">-latestTime</code>,
                          <code className="mx-1 font-mono">-noZero</code>,
                          <code className="mx-1 font-mono">-fields &quot;(U p)&quot;</code> to force extra fields to be
                          read, and <code className="mx-1 font-mono">-region</code> for a named mesh region.
                          Nothing else: the run stays inside the case that is open.
                        </p>
                      </div>
                      <div className="border-t bg-muted/40 px-2 py-1 text-[9px] font-semibold uppercase text-muted-foreground">
                        Arguments this installation declares
                      </div>
                      {chosen.args.length === 0 ? (
                        <p className="px-2 py-1.5 text-[10px] leading-snug text-muted-foreground">
                          None: <code className="font-mono">{chosen.name}</code> is called by name alone.
                        </p>
                      ) : (
                        <dl className="divide-y">
                          {chosen.args.map(arg => (
                            <div key={arg.name} className="grid grid-cols-[104px_1fr] gap-2 px-2 py-1">
                              <dt className="font-mono text-[10px]">
                                {arg.name}
                                {arg.required
                                  ? <span className="ml-1 text-danger" title="Required">*</span>
                                  : <span className="ml-1 text-[9px] text-muted-foreground">opt</span>}
                              </dt>
                              <dd className="text-[10px] leading-snug text-muted-foreground">
                                <span className="font-mono">{arg.placeholder}</span>
                                {arg.help ? <> &mdash; {arg.help}</> : null}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </div>

                    {runOutput !== null && (
                      <div className="rounded border">
                        <div className="border-b bg-muted/40 px-2 py-1 text-[9px] font-semibold uppercase text-muted-foreground">OpenFOAM output</div>
                        <pre className="max-h-48 overflow-auto px-2 py-1.5 font-mono text-[10px] leading-relaxed">{runOutput.trim() || '(no output)'}</pre>
                      </div>
                    )}
                  </div>
                </ScrollArea>
              )}

              <div className="flex flex-shrink-0 items-center gap-2 border-t px-4 py-2.5">
                {commandText.includes('<') && (
                  <span className="text-[10px] text-warning">
                    The command still has a placeholder in it
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setCatalogOpen(false)}>
                    <X className="mr-1 h-3.5 w-3.5" /> Close
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 gap-1.5 text-xs"
                    disabled={!chosen || running || !commandText.trim()}
                    onClick={() => void runFunction()}
                  >
                    {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    Run over written times
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ChartExportDialog open={exportOpen} onOpenChange={setExportOpen} source={exportSource} />
    </div>
  );
}

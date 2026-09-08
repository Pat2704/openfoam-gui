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
  Copy, AlertTriangle, Sigma, FolderOpen, X, Info, Radio,
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
import { describeDatasetName, wrapFoamValue } from '@/lib/postprocess';

interface FileRef { name: string; times: string[]; bytes: number }
interface Dataset { name: string; files: FileRef[] }

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

export default function PostProcess({ caseName, active = true }: { caseName: string; active?: boolean }) {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selected, setSelected] = useState<{ dataset: string; file: string } | null>(null);
  const [data, setData] = useState<TableData | null>(null);
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
  const [form, setForm] = useState<Record<string, string>>({});
  const [timeRange, setTimeRange] = useState('');
  const [extraFields, setExtraFields] = useState('');
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
        const response = await fetch(`/api/postprocess?action=list&case=${encodeURIComponent(caseName)}`);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Could not list postProcessing');
        setDatasets(payload.datasets ?? []);
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

  const loadData = useCallback(async (dataset: string, file: string, time?: string): Promise<void> => {
    if (!caseName) return;
    if (dataInFlight.current) await dataInFlight.current;
    const request = (async () => {
      setLoadingData(true);
      try {
        const query = new URLSearchParams({ action: 'data', case: caseName, dataset, file });
        if (time) query.set('time', time);
        const response = await fetch(`/api/postprocess?${query}`);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Could not read the dataset');
        setData(payload);
        setError(null);
      } catch (e: unknown) {
        setData(null);
        setError(e instanceof Error ? e.message : 'Could not read the dataset');
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
    void loadData(selected.dataset, selected.file);
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
      if (selected) void loadData(selected.dataset, selected.file);
    }, 5000);
    return () => clearInterval(timer);
  }, [follow, active, selected, loadDatasets, loadData]);

  const openCatalog = useCallback(async () => {
    setCatalogOpen(true);
    if (catalog.length) return;
    try {
      const response = await fetch('/api/postprocess?action=catalog');
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not read the function catalogue');
      setCatalog(payload.entries ?? []);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not read the function catalogue');
    }
  }, [catalog.length]);

  const chooseFunction = (entry: CatalogEntry) => {
    setChosen(entry);
    setRunOutput(null);
    // Optional arguments start at the template's own default, so a form that is
    // left alone reproduces exactly what OpenFOAM would have done.
    setForm(Object.fromEntries(entry.args.filter(arg => !arg.required).map(arg => [arg.name, arg.placeholder])));
  };

  const composedValues = useMemo(() => {
    if (!chosen) return {};
    const values: Record<string, string> = {};
    for (const arg of chosen.args) {
      const raw = (form[arg.name] ?? '').trim();
      if (!raw) continue;
      // Parentheses belong to OpenFOAM's syntax, not to what the user typed, so
      // the form takes `0.01 0.05 0.005` and `wrapFoamValue` decides. See its
      // comment: the template's spelling alone gets points wrong.
      values[arg.name] = wrapFoamValue(raw, arg.listWrapped);
    }
    return values;
  }, [chosen, form]);

  const preview = useMemo(() => {
    if (!chosen) return '';
    const parts = Object.entries(composedValues).map(([key, value]) => `${key}=${value}`);
    return parts.length ? `${chosen.name}(${parts.join(', ')})` : chosen.name;
  }, [chosen, composedValues]);

  const missing = useMemo(
    () => (chosen?.args ?? []).filter(arg => arg.required && !(form[arg.name] ?? '').trim()).map(arg => arg.name),
    [chosen, form],
  );

  const runFunction = async () => {
    if (!chosen || !caseName) return;
    setRunning(true);
    setRunOutput(null);
    try {
      const response = await fetch('/api/postprocess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run',
          case: caseName,
          name: chosen.name,
          args: composedValues,
          time: timeRange.trim() || undefined,
          fields: extraFields.trim() ? extraFields.trim().split(/[\s,]+/) : undefined,
        }),
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
  const describedSelection = selected ? describeDatasetName(selected.dataset) : null;

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
                      const isSelected = selected?.dataset === dataset.name && selected.file === file.name;
                      return (
                        <button
                          key={file.name}
                          className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] ${isSelected ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                          onClick={() => setSelected({ dataset: dataset.name, file: file.name })}
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
            </div>
          </ScrollArea>
        </aside>

        {/* ── Chart ── */}
        <main className="flex min-h-0 flex-col">
          <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b px-2">
            {describedSelection ? (
              <>
                <span className="truncate text-xs font-semibold" title={selected?.dataset}>{describedSelection.base}</span>
                <span className="truncate font-mono text-[10px] text-muted-foreground">{selected?.file}</span>
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
                  onValueChange={time => selected && void loadData(selected.dataset, selected.file, time)}
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
                    <p className="mt-1">The list, the descriptions and every field below are read from
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

                    {chosen.args.length > 0 && (
                      <div className="space-y-2.5">
                        {chosen.args.map(arg => (
                          <div key={arg.name}>
                            <Label htmlFor={`arg-${arg.name}`} className="flex items-baseline gap-1.5 text-[11px]">
                              <span className="font-mono font-medium">{arg.name}</span>
                              {arg.required && <span className="text-danger">*</span>}
                              <span className="font-mono text-[9px] text-muted-foreground">{arg.placeholder}</span>
                            </Label>
                            {arg.kind === 'pointList' ? (
                              <Textarea
                                id={`arg-${arg.name}`}
                                value={form[arg.name] ?? ''}
                                onChange={event => setForm(current => ({ ...current, [arg.name]: event.target.value }))}
                                placeholder="(0.005 0.005 0.005) (0.007 0.007 0.005)"
                                className="mt-1 h-16 font-mono text-xs"
                              />
                            ) : (
                              <Input
                                id={`arg-${arg.name}`}
                                value={form[arg.name] ?? ''}
                                onChange={event => setForm(current => ({ ...current, [arg.name]: event.target.value }))}
                                placeholder={
                                  arg.kind === 'point' ? '0 0 0'
                                    : arg.kind === 'fieldList' ? 'p U'
                                      : arg.kind === 'patchList' ? 'inlet outlet'
                                        : arg.kind === 'number' ? '20'
                                          : arg.placeholder
                                }
                                className="mt-1 h-8 font-mono text-xs"
                              />
                            )}
                            {arg.help && <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{arg.help}</p>}
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-3 border-t pt-3">
                      <div>
                        <Label htmlFor="pp-time" className="text-[11px]">Time range</Label>
                        <Input
                          id="pp-time"
                          value={timeRange}
                          onChange={event => setTimeRange(event.target.value)}
                          placeholder="all times — or 5:, :10, 2,4,6"
                          className="mt-1 h-8 font-mono text-xs"
                        />
                      </div>
                      <div>
                        <Label htmlFor="pp-fields" className="text-[11px]">Extra fields to read</Label>
                        <Input
                          id="pp-fields"
                          value={extraFields}
                          onChange={event => setExtraFields(event.target.value)}
                          placeholder="U p"
                          className="mt-1 h-8 font-mono text-xs"
                        />
                      </div>
                    </div>

                    <div className="rounded border bg-muted/40 px-2 py-1.5">
                      <div className="text-[9px] font-semibold uppercase text-muted-foreground">Will run</div>
                      <code className="block break-all font-mono text-[10px]">{preview}</code>
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
                {missing.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    Required: <span className="font-mono">{missing.join(', ')}</span>
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setCatalogOpen(false)}>
                    <X className="mr-1 h-3.5 w-3.5" /> Close
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 gap-1.5 text-xs"
                    disabled={!chosen || running || missing.length > 0}
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
    </div>
  );
}

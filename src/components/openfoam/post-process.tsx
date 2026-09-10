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
  Copy, AlertTriangle, Sigma, FolderOpen, X, Info, Radio, ScrollText, Activity, Download, Maximize2,
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
  serializeCsv,
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
  timesTruncated: boolean;
  runsTruncated: boolean;
}

interface CatalogArg {
  name: string;
  kind: 'number' | 'point' | 'fieldList' | 'patchList' | 'pointList'
    | 'fieldName' | 'patchName' | 'cellZone' | 'faceZone' | 'text';
  listWrapped: boolean;
  placeholder: string;
  help: string;
  required: boolean;
  commented: boolean;
}

interface CatalogDefault { name: string; value: string; help: string }

interface CatalogEntry {
  name: string;
  category: string;
  description: string;
  descriptionParagraphs: string[];
  args: CatalogArg[];
  /** Entries the template offers commented out: legal, documented, and off. */
  optional: CatalogArg[];
  /** The function object class behind it. */
  type: string;
  /** The libraries the entry loads. */
  libs: string[];
  /** Entries that already have a value and can be overridden in the call. */
  defaults: CatalogDefault[];
  /** How the installed tutorials call it. */
  examples: string[];
  /** Whether this template is the installation's, the site's or the user's. */
  source: 'user' | 'site' | 'installation';
  /** The template's path, so the reference can say where it was read from. */
  file: string;
}

/** One piece of the class documentation, in the shape it should be rendered. */
type DocBlock =
  | { kind: 'text'; text: string }
  | { kind: 'code'; lines: string[] }
  | { kind: 'table'; head: string[] | null; rows: string[][] };

/**
 * The reference OpenFOAM ships for the class behind a configured function.
 *
 * The configured template is short by design — `volAverage` is one sentence —
 * while the class header carries every property, its default, the values each
 * enumeration accepts and a complete dictionary example. It is read from the
 * installed source, so it describes the version in use and nothing here has to
 * be kept in step with OpenFOAM.
 */
interface ClassDoc {
  className: string;
  description: DocBlock[];
  usage: DocBlock[];
  seeAlso: string[];
  file: string;
}

/** What the open case can be asked, for the examples and the command. */
interface CaseContext {
  solver: string;
  times: string[];
  patches: string[];
  fields: string[];
  cellZones: string[];
  faceZones: string[];
  bounds?: [number, number, number, number, number, number];
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
 * One block of class documentation.
 *
 * Three shapes come out of an OpenFOAM header and each wants its own: prose
 * reads as prose, a verbatim dictionary example has to keep its indentation
 * to be copyable, and a property table is a grid — flattened into a
 * paragraph it becomes the wall of text the panel exists to replace.
 */
function DocBlockView({ block }: { block: DocBlock }) {
  if (block.kind === 'text') {
    return <p className="text-[10px] leading-relaxed text-muted-foreground">{block.text}</p>;
  }
  if (block.kind === 'code') {
    // `overflow-x-auto` on the block itself: a long dictionary line must scroll
    // inside its own box rather than widen the dialog, which is the same
    // min-width trap the grid column above documents.
    return (
      <pre className="overflow-x-auto rounded bg-muted/40 px-2 py-1.5 font-mono text-[10px] leading-relaxed">
        {block.lines.join('\n')}
      </pre>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[10px]">
        {block.head && (
          <thead>
            <tr className="border-b">
              {block.head.map((cell, index) => (
                <th key={index} className="px-1 py-0.5 text-left font-semibold text-muted-foreground">{cell}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-border/40 align-top">
              {row.map((cell, index) => (
                <td
                  key={index}
                  className={index === 0
                    ? 'whitespace-nowrap px-1 py-0.5 font-mono text-foreground'
                    : 'px-1 py-0.5 leading-snug text-muted-foreground'}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Read a solver log and present its residuals in the dataset shape.
 *
 * The log endpoint and the residual parser both already exist — the Monitor
 * uses them to watch a run — so this only reshapes, and the chart, the table,
 * the CSV and the image export then treat a log like any other dataset.
 */
async function readResiduals(caseName: string, log: string, maxPoints = 4000): Promise<TableData> {
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
    rows: downsampleRows(rows, maxPoints),
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
    timesTruncated: false,
    runsTruncated: false,
  };
}

async function readSelectionData(
  caseName: string,
  target: Selection,
  time?: string,
  maxPoints = 4000,
): Promise<TableData> {
  if (target.kind === 'log') return readResiduals(caseName, target.log, maxPoints);
  const query = new URLSearchParams({
    action: 'data', case: caseName, dataset: target.dataset, file: target.file,
    maxPoints: String(maxPoints),
  });
  if (time) query.set('time', time);
  const response = await fetch(`/api/postprocess?${query}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Could not read the dataset');
  return payload as TableData;
}

export default function PostProcess({ caseName, active = true }: { caseName: string; active?: boolean }) {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [data, setData] = useState<TableData | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [copyingCsv, setCopyingCsv] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [logScale, setLogScale] = useState(false);
  /**
   * What the chart is looking at, and how big the frame is.
   *
   * `null` means "whatever the data spans" — the state only exists once the
   * user has zoomed or panned, so a new dataset always opens framed on itself.
   * The size is the drawing area in CSS pixels; `null` width means it fills the
   * pane, which is what it did before it could be dragged.
   */
  const [zoom, setZoom] = useState<{ x: [number, number]; y: [number, number] } | null>(null);
  const [frame, setFrame] = useState<{ width: number | null; height: number | null }>({ width: null, height: null });
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
  /**
   * What the case can be asked, so an example names something that exists.
   *
   * Patches, fields, zones, the mesh's bounding box and the solver the case
   * declares. Every example built from it is one that can run; without it the
   * graph functions were offered a line from `(0 0 0)` to `(0 0 0)`.
   */
  const [context, setContext] = useState<CaseContext | null>(null);
  /** Which spelling of the utility this OpenFOAM has, and what it accepts. */
  const [utility, setUtility] = useState<string>(POST_PROCESS_NAMES[0]);
  const [utilityOptions, setUtilityOptions] = useState<string[]>([]);
  /** The class reference for the chosen function, read from the installation. */
  const [classDoc, setClassDoc] = useState<ClassDoc | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [runOutput, setRunOutput] = useState<string | null>(null);

  // An in-flight guard per request kind. Without it the follow timer stacks
  // requests on a slow WSL call and the last answer to arrive wins, which is
  // not necessarily the newest one.
  const listInFlight = useRef<Promise<void> | null>(null);
  const listRequestRef = useRef(0);
  const dataRequestRef = useRef(0);
  const dataQueueRef = useRef<Promise<void>>(Promise.resolve());
  const contextRequestRef = useRef(0);
  const catalogRequestRef = useRef(0);
  const docRequestRef = useRef(0);

  const loadDatasets = useCallback(async (): Promise<void> => {
    if (!caseName) return;
    if (listInFlight.current) return listInFlight.current;
    const requestId = ++listRequestRef.current;
    let request!: Promise<void>;
    request = (async () => {
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
        const logPayload = await logsResponse.json();
        if (!logsResponse.ok) throw new Error(logPayload.error || 'Could not list solver logs');
        if (requestId !== listRequestRef.current) return;
        setDatasets(payload.datasets ?? []);
        setLogs(Array.isArray(logPayload.availableLogs) ? logPayload.availableLogs : []);
        setError(null);
      } catch (e: unknown) {
        if (requestId === listRequestRef.current) {
          setError(e instanceof Error ? e.message : 'Could not list postProcessing');
        }
      } finally {
        if (requestId === listRequestRef.current) setLoadingList(false);
        if (listInFlight.current === request) listInFlight.current = null;
      }
    })();
    listInFlight.current = request;
    return request;
  }, [caseName]);

  const loadData = useCallback((target: Selection, time?: string): Promise<void> => {
    if (!caseName) return Promise.resolve();
    const requestId = ++dataRequestRef.current;
    setLoadingData(true);
    // Keep one WSL read active at a time. Superseded queued reads return before
    // crossing the API boundary, while the newest selection waits its turn.
    const request = dataQueueRef.current.catch(() => undefined).then(async () => {
      if (requestId !== dataRequestRef.current) return;
      try {
        const result = await readSelectionData(caseName, target, time);
        if (requestId !== dataRequestRef.current) return;
        setData(result);
        setError(null);
      } catch (e: unknown) {
        if (requestId !== dataRequestRef.current) return;
        setData(null);
        setError(e instanceof Error ? e.message : 'Could not read the data');
      } finally {
        if (requestId === dataRequestRef.current) setLoadingData(false);
      }
    });
    dataQueueRef.current = request;
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

  /**
   * Read the function catalogue for the OpenFOAM that is selected right now.
   *
   * `force` exists because the catalogue is otherwise fetched once and kept:
   * it is 127 entries and does not change while a version stays put.
   */
  const loadCatalog = useCallback(async (force = false) => {
    // What the case can answer about itself: patch, field and zone names, the
    // mesh's bounding box and the solver it declares. Every example the panel
    // builds is made of these, so a call it offers names things that exist.
    if ((force || !context) && caseName) {
      const contextRequest = ++contextRequestRef.current;
      void fetch(`/api/postprocess?action=context&case=${encodeURIComponent(caseName)}`)
        .then(response => (response.ok ? response.json() : null))
        .then(payload => {
          if (payload && contextRequest === contextRequestRef.current) setContext(payload as CaseContext);
        })
        .catch(() => { /* an example falls back to a placeholder */ });
    }
    if (!force && catalog.length) return;
    const catalogRequest = ++catalogRequestRef.current;
    try {
      const response = await fetch(`/api/postprocess?action=catalog${force ? '&refresh=true' : ''}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not read the function catalogue');
      if (catalogRequest !== catalogRequestRef.current) return;
      setCatalog(payload.entries ?? []);
      // Which spelling this OpenFOAM has, so the command shown is the one that
      // would actually run: v12 renamed postProcess to foamPostProcess. The
      // options come with it, because -solver exists on one line and not the
      // other and an option argList does not know is fatal.
      if (typeof payload.utility === 'string') setUtility(payload.utility);
      if (Array.isArray(payload.options)) setUtilityOptions(payload.options);
    } catch (e: unknown) {
      if (catalogRequest === catalogRequestRef.current) {
        toast.error(e instanceof Error ? e.message : 'Could not read the function catalogue');
      }
    }
  }, [catalog.length, caseName, context]);

  /**
   * The solver to construct during a replay, when there is one to name.
   *
   * This is the difference between a drag coefficient and an abort. Without
   * `-solver` the utility reads the fields off disk and builds no models, so
   * every function that asks the registry for a momentum-transport or
   * thermophysical model — forces, forceCoeffs, yPlus, wallShearStress,
   * turbulenceFields — stops on "No valid model for viscous stress
   * calculation". It is offered whenever this OpenFOAM has the option and the
   * case declares a solver, and it can be deleted from the line like anything
   * else.
   */
  const replaySolver = useMemo(
    () => (utilityOptions.includes('-solver') ? context?.solver || '' : ''),
    [utilityOptions, context],
  );

  const openCatalog = useCallback(async () => {
    setCatalogOpen(true);
    await loadCatalog(false);
  }, [loadCatalog]);

  /**
   * Follow the active OpenFOAM.
   *
   * The catalogue, the utility's name and the case's patch list all belong to
   * the installation that was selected when they were read, and every one of
   * them is kept for the life of this tab. Switching version therefore left the
   * panel describing the previous one — a v14 to v13 switch went on offering
   * 127 function objects where the new installation has 119, with v14's
   * templates and v14's tutorial examples behind them.
   *
   * The Dashboard already announces the change; the Commands tab has listened
   * to it since it was added. This tab simply never subscribed.
   */
  useEffect(() => {
    const onInstallationChanged = () => {
      listRequestRef.current += 1;
      dataRequestRef.current += 1;
      contextRequestRef.current += 1;
      catalogRequestRef.current += 1;
      docRequestRef.current += 1;
      listInFlight.current = null;
      setDatasets([]);
      setLogs([]);
      setSelected(null);
      setData(null);
      setLoadingData(false);
      setChosen(null);
      setCommandText('');
      setEntryText('');
      setRunOutput(null);
      setContext(null);
      setCatalog([]);
      setUtilityOptions([]);
      setClassDoc(null);
      setDocLoading(false);
      // The run directory moves with the version, so what the case holds has to
      // be listed again too.
      void loadDatasets();
      // Only refetch the catalogue right away if it is on screen; otherwise the
      // cleared state makes the next open read it.
      if (catalogOpen) void loadCatalog(true);
    };
    window.addEventListener('foam-version-changed', onInstallationChanged);
    return () => window.removeEventListener('foam-version-changed', onInstallationChanged);
  }, [catalogOpen, loadCatalog, loadDatasets]);

  /**
   * Closing the panel discards whatever was typed in it.
   *
   * The two texts are a scratchpad for one visit: edits apply to the run you
   * are about to make, and reopening offers the installation's own call again
   * rather than yesterday's half-finished edit. Re-seeded on close instead of
   * on open so the panel never flashes the old text as it appears.
   */
  useEffect(() => {
    if (catalogOpen || !chosen) return;
    const call = buildCallTemplate(chosen.name, chosen.args, context ?? {});
    setCommandText(buildCommandTemplate(utility, call, { solver: replaySolver }));
    setEntryText(buildFunctionsEntry(call));
    setRunOutput(null);
  }, [catalogOpen, chosen, context, utility, replaySolver]);

  const chooseFunction = (entry: CatalogEntry) => {
    const docRequest = ++docRequestRef.current;
    setChosen(entry);
    setRunOutput(null);
    // Both texts start from what the installation declares: the real argument
    // names, examples taken from each template's own `e.g.` note, and patches,
    // fields and coordinates this case actually has. The user edits the text,
    // not a set of invented controls.
    const call = buildCallTemplate(entry.name, entry.args, context ?? {});
    setCommandText(buildCommandTemplate(utility, call, { solver: replaySolver }));
    setEntryText(buildFunctionsEntry(call));

    // The class reference behind it, fetched per function rather than with the
    // catalogue: it is one source header each, and only the one on screen is
    // ever read. A function whose class cannot be identified with certainty
    // simply has none, which is the honest outcome — see readFunctionClassDoc.
    setClassDoc(null);
    setDocLoading(Boolean(entry.type));
    if (!entry.type) return;
    void fetch(`/api/postprocess?action=doc&type=${encodeURIComponent(entry.type)}`)
      .then(response => (response.ok ? response.json() : null))
      .then(payload => {
        if (docRequest === docRequestRef.current) setClassDoc(payload?.doc ?? null);
      })
      .catch(() => { /* the template's own reference stands on its own */ })
      .finally(() => {
        if (docRequest === docRequestRef.current) setDocLoading(false);
      });
  };

  const runFunction = async () => {
    if (!caseName || !commandText.trim()) return;
    setRunning(true);
    setRunOutput(null);
    try {
      // Parsed here so a mistake is reported against the line the user is
      // looking at. The server checks every piece again regardless.
      const parsed = parsePostProcessCommand(
        commandText, catalog.map(entry => entry.name), utilityOptions,
      );
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
        const drawable = value !== null && Number.isFinite(value) && (!logScale || value > 0);
        point[`c${index}`] = drawable ? value : undefined;
      }
      return point;
    });
  }, [data, logScale]);

  const visibleSeries = useMemo(() => {
    if (!data) return [];
    return data.columns
      .map((name, index) => ({ name, index }))
      .filter(series => series.index > 0 && !hidden.has(series.index));
  }, [data, hidden]);

  /**
   * A log axis cannot place a zero or a negative value — but requiring EVERY
   * sample to be positive is what made "log Y" look broken. One zero residual
   * at the first timestep, one negative force coefficient anywhere in a long
   * run, and the button greyed out for the whole dataset. It is enabled when
   * there is something to draw logarithmically, and the points it cannot place
   * become gaps, which is what every plotting tool does.
   */
  const logUsable = useMemo(() => {
    if (!data || !visibleSeries.length) return false;
    return data.rows.some(row => visibleSeries.some(series => {
      const value = row[series.index];
      return typeof value === 'number' && Number.isFinite(value) && value > 0;
    }));
  }, [data, visibleSeries]);

  /** How many drawable points a log axis would have to leave out. */
  const logDropped = useMemo(() => {
    if (!data || !visibleSeries.length) return 0;
    let count = 0;
    for (const row of data.rows) {
      for (const series of visibleSeries) {
        const value = row[series.index];
        if (typeof value === 'number' && Number.isFinite(value) && value <= 0) count += 1;
      }
    }
    return count;
  }, [data, visibleSeries]);

  useEffect(() => {
    if (logScale && !logUsable) setLogScale(false);
  }, [logScale, logUsable]);

  /** What the data spans, which is the frame the chart opens on. */
  const chartBounds = useMemo(() => {
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const row of chartRows) {
      const x = row.x;
      if (typeof x === 'number' && Number.isFinite(x)) {
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
      }
      for (const series of visibleSeries) {
        const value = row[`c${series.index}`];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        if (logScale && value <= 0) continue;
        if (value < yMin) yMin = value;
        if (value > yMax) yMax = value;
      }
    }
    if (!Number.isFinite(xMin) || !Number.isFinite(yMin)) return null;
    // A flat series has no span of its own; give it one so it is not a line on
    // the edge of the frame.
    if (xMax === xMin) { xMin -= 0.5; xMax += 0.5; }
    if (yMax === yMin) {
      if (logScale) { yMin /= 2; yMax *= 2; } else { yMin -= 0.5; yMax += 0.5; }
    }
    if (logScale) {
      yMin = Math.pow(10, Math.floor(Math.log10(yMin)));
      yMax = Math.pow(10, Math.ceil(Math.log10(yMax)));
    } else {
      const pad = (yMax - yMin) * 0.05;
      yMin -= pad;
      yMax += pad;
    }
    return { x: [xMin, xMax] as [number, number], y: [yMin, yMax] as [number, number] };
  }, [chartRows, visibleSeries, logScale]);

  // Zooming is relative to the data, so a new dataset, a hidden series or a
  // switch of axis type starts from the whole picture again.
  useEffect(() => { setZoom(null); }, [selected, logScale, visibleSeries.length]);

  const domains = zoom || chartBounds;

  /**
   * Zoom and pan, in data units.
   *
   * The chart is a plain rectangle of the pane minus the axis furniture, so a
   * pixel maps to a value linearly (or to its logarithm on a log axis) and the
   * gesture lands where the pointer is rather than near it.
   */
  const chartAreaRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);

  const plotRect = useCallback(() => {
    const box = chartAreaRef.current?.getBoundingClientRect();
    if (!box) return null;
    // Must match the chart margins and the axis sizes below.
    const left = box.left + 8 + 64;
    const right = box.right - 16;
    const top = box.top + 8;
    const bottom = box.bottom - 24 - 22;
    if (right - left < 40 || bottom - top < 40) return null;
    return { left, right, top, bottom, width: right - left, height: bottom - top };
  }, []);

  const scaleAxis = useCallback((
    range: [number, number], factor: number, anchor: number, logarithmic: boolean,
  ): [number, number] => {
    if (logarithmic) {
      const low = Math.log10(range[0]);
      const high = Math.log10(range[1]);
      const pivot = low + (high - low) * anchor;
      const nextLow = pivot - (pivot - low) * factor;
      const nextHigh = pivot + (high - pivot) * factor;
      // Ten decades in, or a hundredth of one, is as far as either is useful.
      if (nextHigh - nextLow < 0.05 || nextHigh - nextLow > 40) return range;
      return [Math.pow(10, nextLow), Math.pow(10, nextHigh)];
    }
    const pivot = range[0] + (range[1] - range[0]) * anchor;
    const low = pivot - (pivot - range[0]) * factor;
    const high = pivot + (range[1] - pivot) * factor;
    if (!Number.isFinite(low) || !Number.isFinite(high) || high - low <= 0) return range;
    return [low, high];
  }, []);

  const zoomBy = useCallback((factor: number, anchorX: number, anchorY: number, axis: 'x' | 'y' | 'both') => {
    const base = zoom || chartBounds;
    if (!base) return;
    setZoom({
      x: axis === 'y' ? base.x : scaleAxis(base.x, factor, anchorX, false),
      y: axis === 'x' ? base.y : scaleAxis(base.y, factor, anchorY, logScale),
    });
  }, [zoom, chartBounds, logScale, scaleAxis]);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const rect = plotRect();
    if (!rect || !(zoom || chartBounds)) return;
    event.preventDefault();
    const anchorX = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const anchorY = Math.min(1, Math.max(0, (rect.bottom - event.clientY) / rect.height));
    const factor = event.deltaY > 0 ? 1.15 : 1 / 1.15;
    // Shift zooms the time axis alone, Alt the value axis alone.
    const axis = event.shiftKey ? 'x' : event.altKey ? 'y' : 'both';
    zoomBy(factor, anchorX, anchorY, axis);
  }, [plotRect, zoom, chartBounds, zoomBy]);

  const handlePanMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const origin = panRef.current;
    const rect = plotRect();
    const base = zoom || chartBounds;
    if (!origin || !rect || !base) return;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    if (!dx && !dy) return;
    panRef.current = { x: event.clientX, y: event.clientY };
    const shiftX = -(dx / rect.width) * (base.x[1] - base.x[0]);
    const nextX: [number, number] = [base.x[0] + shiftX, base.x[1] + shiftX];
    let nextY: [number, number];
    if (logScale) {
      const low = Math.log10(base.y[0]);
      const high = Math.log10(base.y[1]);
      const shift = (dy / rect.height) * (high - low);
      nextY = [Math.pow(10, low + shift), Math.pow(10, high + shift)];
    } else {
      const shift = (dy / rect.height) * (base.y[1] - base.y[0]);
      nextY = [base.y[0] + shift, base.y[1] + shift];
    }
    setZoom({ x: nextX, y: nextY });
  }, [plotRect, zoom, chartBounds, logScale]);

  /** Drag the corner to give the figure the shape it should be saved in. */
  const resizeRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const handleResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const origin = resizeRef.current;
    if (!origin) return;
    const width = Math.round(origin.width + (event.clientX - origin.x));
    const height = Math.round(origin.height + (event.clientY - origin.y));
    setFrame({
      width: Math.max(320, Math.min(4000, width)),
      height: Math.max(200, Math.min(3000, height)),
    });
  }, []);

  const toggleSeries = (index: number) => {
    setHidden(previous => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const copyCsv = async () => {
    if (!data || !selected || copyingCsv) return;
    setCopyingCsv(true);
    try {
      // The chart is intentionally thinned to 4,000 points. CSV is data, not a
      // picture, so fetch the full parsed table instead of copying that visual
      // sample and calling it complete.
      const complete = data.totalRows > data.rows.length
        ? await readSelectionData(caseName, selected, data.shownTime ?? undefined, 200000)
        : data;
      await navigator.clipboard.writeText(serializeCsv(complete.columns, complete.rows));
      if (complete.truncated || complete.runsTruncated || complete.totalRows > complete.rows.length) {
        toast.warning(`${complete.rows.length} rows copied; the source exceeded the safe read limit`);
      } else {
        toast.success(`${complete.rows.length} rows copied as CSV`);
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'The clipboard is not available');
    } finally {
      setCopyingCsv(false);
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
      // The saved figure shows what the chart shows: the window the user
      // zoomed to, and the shape they dragged it into.
      xDomain: zoom ? zoom.x : undefined,
      yDomain: zoom ? zoom.y : undefined,
      aspect: frame.width && frame.height ? frame.width / frame.height : undefined,
      fileName: label.replace(/[^A-Za-z0-9._-]+/g, '-'),
      title: selected.kind === 'log'
        ? `${caseName} — initial residuals`
        : `${caseName} — ${describeDatasetName(selected.dataset).base}`,
    };
  }, [data, visibleSeries, selected, caseName, independent, logScale, zoom, frame]);
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
              {view === 'chart' && (zoom || frame.width !== null || frame.height !== null) && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[10px]"
                  title="Back to the whole dataset at the pane's own size"
                  onClick={() => { setZoom(null); setFrame({ width: null, height: null }); }}
                >
                  <Maximize2 className="mr-1 h-3 w-3" /> Reset view
                </Button>
              )}
              <Button
                size="sm"
                variant={logScale ? 'default' : 'ghost'}
                className="h-7 px-2 text-[10px]"
                disabled={!logUsable}
                title={!logUsable
                  ? 'A log axis needs at least one positive value'
                  : logDropped
                    ? `Logarithmic Y axis — ${logDropped} non-positive point${logDropped === 1 ? '' : 's'} cannot be drawn on it`
                    : 'Logarithmic Y axis'}
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
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px]" disabled={!data || copyingCsv} onClick={() => void copyCsv()}>
                {copyingCsv ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Copy className="mr-1 h-3 w-3" />} CSV
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

          {data && (data.incompatible.length > 0 || data.synthesizedColumns || data.truncated || data.timesTruncated || data.runsTruncated || data.startTimes.length > 1) && (
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
              {data.timesTruncated && <span className="text-warning">Only the latest 20,000 written times are listed</span>}
              {data.runsTruncated && <span className="text-warning">Only the latest 200 restart files are included in this series</span>}
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
              <div className="flex h-full min-h-0 w-full justify-center overflow-auto">
                <div
                  className="relative flex-shrink-0"
                  style={{ width: frame.width ?? '100%', height: frame.height ?? '100%' }}
                >
                  <div
                    ref={chartAreaRef}
                    className="h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
                    onWheel={handleWheel}
                    onPointerDown={event => {
                      if (event.button !== 0) return;
                      event.currentTarget.setPointerCapture(event.pointerId);
                      panRef.current = { x: event.clientX, y: event.clientY };
                    }}
                    onPointerMove={handlePanMove}
                    onPointerUp={() => { panRef.current = null; }}
                    onPointerCancel={() => { panRef.current = null; }}
                    onDoubleClick={() => setZoom(null)}
                  >
              {/* Keyed on the frame: recharts measures its box once and then
                  waits for a resize event, so returning the chart to the pane's
                  own size left the drawing at the dragged size until something
                  else happened to resize the window. */}
              <ResponsiveContainer key={`${frame.width ?? 'auto'}x${frame.height ?? 'auto'}`} width="100%" height="100%">
                {/* ComposedChart for the same reason the Monitor uses one: it
                    accepts a mixed set of graphical children without silently
                    dropping them. */}
                <ComposedChart data={chartRows} margin={{ top: 8, right: 16, left: 8, bottom: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis
                    dataKey="x"
                    type="number"
                    scale="linear"
                    // The zoomed window when there is one, and otherwise the
                    // span of the data — never a domain the data has to be
                    // clipped into.
                    domain={domains ? domains.x : ['dataMin', 'dataMax']}
                    allowDataOverflow={Boolean(zoom)}
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
                    type="number"
                    domain={domains ? domains.y : ['auto', 'auto']}
                    tick={{ fontSize: 9 }}
                    width={64}
                    tickFormatter={formatTick}
                    allowDataOverflow={Boolean(zoom)}
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
                  </div>
                  {/* Drag the corner to shape the figure. The export dialog
                      opens on this aspect, so what is shaped here is what gets
                      saved. */}
                  <div
                    role="separator"
                    aria-label="Resize the chart"
                    title="Drag to resize the chart"
                    className="absolute -bottom-1 -right-1 h-4 w-4 cursor-nwse-resize rounded-sm border-b-2 border-r-2 border-border hover:border-brand"
                    onPointerDown={event => {
                      const box = chartAreaRef.current?.getBoundingClientRect();
                      if (!box) return;
                      event.preventDefault();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      resizeRef.current = { x: event.clientX, y: event.clientY, width: box.width, height: box.height };
                    }}
                    onPointerMove={handleResizeMove}
                    onPointerUp={() => { resizeRef.current = null; }}
                    onPointerCancel={() => { resizeRef.current = null; }}
                  />
                </div>
              </div>
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

          <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] overflow-hidden">
            <div className="flex min-h-0 min-w-0 flex-col border-r">
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

            {/* `min-w-0`, because a grid item defaults to `min-width: auto` and
                will not shrink below its content: one long call in a <code>
                pushed this column wider than its track and carried the whole
                dialog — footer button included — off the right of the window. */}
            <div className="flex min-h-0 min-w-0 flex-col">
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
                  <div className="min-w-0 space-y-3 p-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <h3 className="break-words font-mono text-sm font-semibold">{chosen.name}</h3>
                        <span className="text-[10px] text-muted-foreground">{chosen.category}</span>
                        {chosen.source !== 'installation' && (
                          <Badge variant="outline" className="text-[9px]" title={chosen.file}>
                            {chosen.source === 'user' ? 'your ~/.OpenFOAM' : 'site configuration'}
                          </Badge>
                        )}
                      </div>
                      {/* The Description block with its paragraphs kept apart.
                          `power` writes eleven list items and `flowType` three;
                          run together they read as one unbroken sentence. */}
                      {(chosen.descriptionParagraphs?.length
                        ? chosen.descriptionParagraphs
                        : [chosen.description || 'No description in the template.']
                      ).map((paragraph, index) => (
                        <p key={index} className="mt-1 text-xs leading-relaxed text-muted-foreground">{paragraph}</p>
                      ))}
                      <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
                        {chosen.type ? <span title="The function object class this template configures">{chosen.type}</span> : null}
                        {chosen.libs?.length
                          ? <span title="The libraries the entry loads"> · {chosen.libs.join(' ')}</span>
                          : null}
                      </p>
                    </div>

                    {/* Some function objects act ON a solve rather than
                        measuring it, and those write no dataset to read back.
                        Recognised from the class the template configures —
                        `stopAtFile`, `adjustTimeStepToReaction` and their kind
                        — rather than from a list written here, and
                        deliberately narrow: `writeObjects` and `removeObjects`
                        sit in the same category and replay perfectly well. */}
                    {/^(stopAt|adjustTimeStep)/.test(chosen.type) ? (
                      <Alert className="py-2">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        <AlertDescription className="text-[10px] leading-snug">
                          This one steers a running solve — it stops it or changes its time step. It
                          belongs in <code className="mx-1 font-mono">controlDict</code>; replayed over
                          times already written there is nothing left for it to act on, and nothing for
                          this tab to chart.
                        </AlertDescription>
                      </Alert>
                    ) : (
                      /* Where the numbers land. The directory is the call's own
                         `name=`, which is why the panel insists on keeping it. */
                      <p className="text-[10px] leading-snug text-muted-foreground">
                        Writes under
                        <code className="mx-1 font-mono text-foreground">postProcessing/{chosen.name}/&lt;time&gt;/</code>
                        — the name in the call is the directory, and this tab reads it back.
                      </p>
                    )}

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
                          onClick={() => setCommandText(buildCommandTemplate(
                            utility, buildCallTemplate(chosen.name, chosen.args, context ?? {}), { solver: replaySolver },
                          ))}
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
                      {/* The one option worth explaining, because deleting it
                          silently changes what the run can compute. */}
                      {replaySolver ? (
                        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                          <code className="font-mono">-solver {replaySolver}</code> builds the case's
                          models the way the run did. Without it only the fields on disk are read, and a
                          function that needs a transport or thermophysical model — forces, y+, wall shear
                          stress — stops instead of writing. Replace it with
                          <code className="mx-1 font-mono">-fields &apos;(U p)&apos;</code> to read named fields
                          and build nothing.
                        </p>
                      ) : (
                        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                          Add <code className="font-mono">-fields &apos;(U p)&apos;</code> when the function needs
                          a field its own call does not name; only what is named is read from disk.
                          {utilityOptions.length && !utilityOptions.includes('-solver')
                            ? ' This OpenFOAM has no -solver option, so a function that needs a turbulence or thermophysical model has to be run from the solver itself.'
                            : ''}
                        </p>
                      )}
                      {context?.times.length ? (
                        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                          Times on disk: <span className="font-mono">{context.times.slice(0, 6).join(' ')}</span>
                          {context.times.length > 6 ? ` … ${context.times[context.times.length - 1]}` : ''}
                          . <code className="font-mono">-time</code> takes ranges such as
                          <code className="mx-1 font-mono">:{context.times[Math.min(1, context.times.length - 1)]}</code>
                          or a comma-separated list; <code className="font-mono">-latestTime</code> takes the last one.
                        </p>
                      ) : null}
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <Label htmlFor="pp-entry" className="text-[11px]">Or run it during the solve</Label>
                        <Button
                          size="sm" variant="ghost" className="ml-auto h-6 px-1.5 text-[10px]"
                          onClick={() => setEntryText(buildFunctionsEntry(buildCallTemplate(chosen.name, chosen.args, context ?? {})))}
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

                    {/* What is particular to THIS function.
                        A general syntax note was the same on all 127 and taught
                        nothing after the first read; everything below is read
                        from the installation and differs per function. */}
                    <div className="min-w-0 rounded border">
                      <div className="flex items-center gap-2 border-b bg-muted/40 px-2 py-1">
                        <span className="text-[9px] font-semibold uppercase text-muted-foreground">Arguments</span>
                        {chosen.type && (
                          <span className="ml-auto font-mono text-[9px] text-muted-foreground" title="The function object class behind it">
                            {chosen.type}
                          </span>
                        )}
                      </div>
                      {chosen.args.length === 0 ? (
                        <p className="px-2 py-1.5 text-[10px] leading-snug text-muted-foreground">
                          None to supply: <code className="font-mono">{chosen.name}</code> is called by name alone.
                        </p>
                      ) : (
                        <dl className="divide-y">
                          {chosen.args.map(arg => (
                            <div key={arg.name} className="grid grid-cols-[104px_minmax(0,1fr)] gap-2 px-2 py-1">
                              <dt className="min-w-0 break-words font-mono text-[10px]">
                                {arg.name}
                                {arg.required
                                  ? <span className="ml-1 text-danger" title="Must be given">*</span>
                                  : <span className="ml-1 text-[9px] text-muted-foreground">opt</span>}
                              </dt>
                              <dd className="min-w-0 break-words text-[10px] leading-snug text-muted-foreground">
                                <span className="font-mono">{arg.placeholder}</span>
                                {arg.help ? <> &mdash; {arg.help}</> : null}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}

                      {chosen.optional?.length > 0 && (
                        <>
                          <div className="border-t bg-muted/40 px-2 py-1 text-[9px] font-semibold uppercase text-muted-foreground">
                            Also accepted — the template writes these commented out
                          </div>
                          <dl className="divide-y">
                            {chosen.optional.map(arg => (
                              <div key={arg.name} className="grid grid-cols-[104px_minmax(0,1fr)] gap-2 px-2 py-1">
                                <dt className="min-w-0 break-words font-mono text-[10px]">{arg.name}</dt>
                                <dd className="min-w-0 break-words text-[10px] leading-snug text-muted-foreground">
                                  <span className="font-mono">{arg.listWrapped ? `(${arg.placeholder})` : arg.placeholder}</span>
                                  {arg.help ? <> &mdash; {arg.help}</> : null}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </>
                      )}

                      {chosen.defaults.length > 0 && (
                        <>
                          <div className="border-t bg-muted/40 px-2 py-1 text-[9px] font-semibold uppercase text-muted-foreground">
                            Set already — add any of these to the call to change it
                          </div>
                          <dl className="divide-y">
                            {chosen.defaults.map(entry => (
                              <div key={entry.name} className="grid grid-cols-[104px_minmax(0,1fr)] gap-2 px-2 py-1">
                                <dt className="min-w-0 break-words font-mono text-[10px]">{entry.name}</dt>
                                <dd className="min-w-0 break-words text-[10px] leading-snug text-muted-foreground">
                                  <span className="font-mono">{entry.value}</span>
                                  {entry.help ? <> &mdash; {entry.help}</> : null}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </>
                      )}

                      {chosen.examples.length > 0 && (
                        <>
                          <div className="border-t bg-muted/40 px-2 py-1 text-[9px] font-semibold uppercase text-muted-foreground">
                            How the tutorials call it
                          </div>
                          <div className="space-y-1 px-2 py-1.5">
                            {chosen.examples.map(example => (
                              <button
                                key={example}
                                className="block w-full break-all rounded px-1 py-0.5 text-left font-mono text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                                title="Use this call"
                                onClick={() => {
                                  setCommandText(buildCommandTemplate(utility, example, { solver: replaySolver }));
                                  setEntryText(buildFunctionsEntry(example));
                                }}
                              >
                                {example}
                              </button>
                            ))}
                          </div>
                        </>
                      )}

                      <p className="border-t px-2 py-1.5 text-[10px] leading-snug text-muted-foreground">
                        Every entry above is written <code className="font-mono">key=value</code> inside the
                        brackets, separated by commas; a value that is a list or a vector keeps its own
                        parentheses. Keep <code className="font-mono">name=</code>: without it the results
                        land in a directory named after the whole call with its spaces stripped out, which
                        cannot be read back. A field may also be given on its own, with no keyword —
                        <code className="mx-1 font-mono">mag(U)</code> is
                        <code className="mx-1 font-mono">mag(field=U)</code> — and several become the
                        <code className="mx-1 font-mono">fields</code> list.
                        <span className="mt-1 block">
                          Read from <span className="font-mono break-all">{chosen.file}</span>.
                        </span>
                      </p>
                    </div>

                    {/* ── The class reference, from the installation's source ──
                        The configured template above is deliberately short. The
                        class behind it carries the property table, the values
                        each enumeration accepts and a full dictionary example,
                        and it is the documentation for the version installed —
                        so it is read rather than restated here. */}
                    {docLoading && (
                      <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> Reading the class reference…
                      </p>
                    )}
                    {classDoc && (
                      <div className="min-w-0 rounded border">
                        <div className="flex flex-wrap items-baseline gap-x-2 border-b bg-muted/40 px-2 py-1">
                          <span className="text-[9px] font-semibold uppercase text-muted-foreground">
                            The class, as this OpenFOAM documents it
                          </span>
                          <span className="ml-auto font-mono text-[9px] text-muted-foreground">{classDoc.className}</span>
                        </div>
                        <div className="space-y-2 px-2 py-2">
                          {classDoc.description.map((block, index) => (
                            <DocBlockView key={`d${index}`} block={block} />
                          ))}
                          {classDoc.usage.length > 0 && (
                            <>
                              <div className="pt-1 text-[9px] font-semibold uppercase text-muted-foreground">Every entry it reads</div>
                              {classDoc.usage.map((block, index) => (
                                <DocBlockView key={`u${index}`} block={block} />
                              ))}
                            </>
                          )}
                          <p className="pt-1 text-[9px] leading-snug text-muted-foreground">
                            Read from <span className="font-mono break-all">{classDoc.file}</span>. Entries the
                            configured template does not fill in are set here or take the default shown.
                          </p>
                        </div>
                      </div>
                    )}

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

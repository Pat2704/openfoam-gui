'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { loadFoamyConfig } from '@/lib/foamy-store';
import type {
  ParaViewCaseFile, ParaViewNodeType, ParaViewPipelineNode, ParaViewStartupStage, ParaViewWorkbenchState,
} from '@/lib/paraview';
import {
  AlertTriangle, ArrowUpRight, Box, Calculator, ChevronLeft, ChevronRight, CircleDot,
  Download, Eye, EyeOff, FileBox, Filter, FolderOpen, GitFork, Grid3X3, Info, Layers3, Loader2,
  Maximize2, MousePointer2, Move3D, Network, Pause, Play, Power, RefreshCw,
  Rotate3D, Scissors, Search, Settings, SlidersHorizontal, Sparkles,
  SquareDashedMousePointer, Trash2, Waves,
} from 'lucide-react';
import { toast } from 'sonner';

type Vector3 = [number, number, number];
type FilterType = Exclude<ParaViewNodeType, 'OpenFOAMReader' | 'CaseFileReader'>;
type CameraMode = 'rotate' | 'pan' | 'zoom';
type ManipulatorMode = 'translate' | 'rotate' | 'scale' | 'point1' | 'point2';
type ViewportTool = 'camera' | ManipulatorMode;

interface PropertyDraft {
  origin: Vector3;
  normal: Vector3;
  invert: boolean;
  contourAssociation: 'CELLS' | 'POINTS';
  contourName: string;
  contourValue: number;
  thresholdAssociation: 'CELLS' | 'POINTS';
  thresholdName: string;
  thresholdLower: number;
  thresholdUpper: number;
  streamName: string;
  streamSeedType: 'Point Cloud' | 'Line';
  streamCenter: Vector3;
  streamRadius: number;
  streamPoints: number;
  streamPoint1: Vector3;
  streamPoint2: Vector3;
  streamResolution: number;
  streamDirection: 'FORWARD' | 'BACKWARD' | 'BOTH';
  streamMaximumLength: number;
  tubeRadius: number;
  tubeSides: number;
  calculatorAssociation: 'CELLS' | 'POINTS';
  calculatorExpression: string;
  calculatorResultName: string;
  gradientAssociation: 'CELLS' | 'POINTS';
  gradientName: string;
  gradientResultName: string;
  glyphName: string;
  glyphScaleFactor: number;
  glyphMaxPoints: number;
  warpAssociation: 'CELLS' | 'POINTS';
  warpName: string;
  warpScaleFactor: number;
  warpNormal: Vector3;
  warpUseNormal: boolean;
  transformTranslate: Vector3;
  transformRotate: Vector3;
  transformScale: Vector3;
  reflectOrigin: Vector3;
  reflectNormal: Vector3;
  reflectCopyInput: boolean;
  shrinkFactor: number;
  plotPoint1: Vector3;
  plotPoint2: Vector3;
  plotResolution: number;
}

interface DisplayDraft {
  opacity: number;
  lineWidth: number;
  pointSize: number;
}

const REPRESENTATIONS = ['Surface', 'Surface With Edges', 'Wireframe', 'Points', 'Outline'];
const FILTER_GROUPS: { label: string; filters: FilterType[] }[] = [
  { label: 'Common', filters: ['Slice', 'Clip', 'Contour', 'Threshold', 'StreamTracer', 'Glyph'] },
  { label: 'Geometry', filters: ['Transform', 'Reflect', 'WarpByVector', 'WarpByScalar', 'Shrink'] },
  { label: 'Sampling and lines', filters: ['PlotOverLine', 'CellCenters', 'Tube'] },
  { label: 'Data analysis', filters: ['Calculator', 'Gradient', 'TemporalStatistics', 'IntegrateVariables', 'CellDatatoPointData', 'PointDatatoCellData'] },
  { label: 'Extraction and topology', filters: ['ExtractSurface', 'ExtractEdges', 'Connectivity'] },
];
// Reported by the engine itself rather than animated on a timer, so a slow
// start can be told apart from a stuck one. A first ParaView launch loads its
// libraries from disk and takes minutes; every later one takes seconds.
const STARTUP_STEPS: { stage: ParaViewStartupStage; label: string }[] = [
  { stage: 'locating', label: 'Locating the ParaView installation…' },
  { stage: 'launching', label: 'Creating the paraFoam marker and starting pvpython…' },
  { stage: 'interpreter', label: 'Python is up — loading the ParaView libraries…' },
  { stage: 'engine', label: 'ParaView libraries loaded.' },
  { stage: 'reading', label: 'Reading mesh regions, fields and timesteps…' },
  { stage: 'rendering', label: 'Preparing the first offscreen render…' },
];
/** A cold pvpython can take minutes; the ceilings only catch a real hang. */
const START_TIMEOUT_MS = 660_000;
const REQUEST_TIMEOUT_MS = 180_000;

/**
 * Every request the workbench makes is bounded. An unbounded fetch is what
 * turns a session that died quietly into a spinner that never stops.
 */
async function timedFetch(input: string, init: RequestInit, timeout: number): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new Error(`ParaView did not answer within ${Math.round(timeout / 1000)} seconds.`);
    }
    throw cause;
  } finally {
    window.clearTimeout(timer);
  }
}

const EMPTY_DRAFT: PropertyDraft = {
  origin: [0, 0, 0], normal: [1, 0, 0], invert: false,
  contourAssociation: 'POINTS', contourName: '', contourValue: 0,
  thresholdAssociation: 'CELLS', thresholdName: '', thresholdLower: 0, thresholdUpper: 1,
  streamName: '', streamSeedType: 'Point Cloud', streamCenter: [0, 0, 0],
  streamRadius: 1, streamPoints: 50, streamPoint1: [0, 0, 0], streamPoint2: [1, 0, 0],
  streamResolution: 50, streamDirection: 'BOTH', streamMaximumLength: 1,
  tubeRadius: 0.01, tubeSides: 8,
  calculatorAssociation: 'POINTS', calculatorExpression: '', calculatorResultName: 'Result',
  gradientAssociation: 'POINTS', gradientName: '', gradientResultName: 'Gradient',
  glyphName: '', glyphScaleFactor: 1, glyphMaxPoints: 1200,
  warpAssociation: 'POINTS', warpName: '', warpScaleFactor: 1, warpNormal: [0, 0, 1], warpUseNormal: false,
  transformTranslate: [0, 0, 0], transformRotate: [0, 0, 0], transformScale: [1, 1, 1],
  reflectOrigin: [0, 0, 0], reflectNormal: [1, 0, 0], reflectCopyInput: true,
  shrinkFactor: 0.8, plotPoint1: [0, 0, 0], plotPoint2: [1, 1, 1], plotResolution: 200,
};

async function errorFrom(response: Response): Promise<string> {
  try {
    const data = await response.json() as { error?: string };
    return data.error || `Request failed (HTTP ${response.status}).`;
  } catch {
    return `Request failed (HTTP ${response.status}).`;
  }
}

function filterLabel(type: FilterType): string {
  const labels: Partial<Record<FilterType, string>> = {
    CellDatatoPointData: 'Cell Data to Point Data',
    PointDatatoCellData: 'Point Data to Cell Data',
    StreamTracer: 'Stream Tracer',
    ExtractSurface: 'Extract Surface',
    CellCenters: 'Cell Centers',
    WarpByVector: 'Warp By Vector',
    WarpByScalar: 'Warp By Scalar',
    ExtractEdges: 'Extract Edges',
    IntegrateVariables: 'Integrate Variables',
    PlotOverLine: 'Plot Over Line',
    TemporalStatistics: 'Temporal Statistics',
  };
  return labels[type] || type;
}

function filterIcon(type: ParaViewNodeType) {
  if (type === 'CaseFileReader') return <FileBox className="h-3.5 w-3.5" />;
  if (type === 'Slice') return <Scissors className="h-3.5 w-3.5" />;
  if (type === 'Clip') return <SquareDashedMousePointer className="h-3.5 w-3.5" />;
  if (type === 'Contour') return <CircleDot className="h-3.5 w-3.5" />;
  if (type === 'StreamTracer') return <Waves className="h-3.5 w-3.5" />;
  if (type === 'Threshold') return <Filter className="h-3.5 w-3.5" />;
  if (type === 'Tube') return <Network className="h-3.5 w-3.5" />;
  if (type === 'ExtractSurface') return <Box className="h-3.5 w-3.5" />;
  if (type === 'CellDatatoPointData') return <Layers3 className="h-3.5 w-3.5" />;
  if (type === 'Calculator') return <Calculator className="h-3.5 w-3.5" />;
  if (type === 'Glyph') return <Sparkles className="h-3.5 w-3.5" />;
  if (type === 'PlotOverLine' || type === 'ExtractEdges') return <ArrowUpRight className="h-3.5 w-3.5" />;
  if (type === 'Transform' || type === 'WarpByVector' || type === 'WarpByScalar') return <Move3D className="h-3.5 w-3.5" />;
  if (type === 'Gradient' || type === 'TemporalStatistics' || type === 'IntegrateVariables') return <Grid3X3 className="h-3.5 w-3.5" />;
  return <GitFork className="h-3.5 w-3.5" />;
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function VectorInputs({ value, onChange }: { value: Vector3; onChange: (index: number, value: string) => void }) {
  return (
    <div className="grid grid-cols-3 gap-1">
      {value.map((coordinate, index) => (
        <Input
          key={index}
          type="number"
          step="any"
          className="h-7 px-1.5 font-mono text-[10px]"
          value={coordinate}
          onChange={event => onChange(index, event.target.value)}
        />
      ))}
    </div>
  );
}

export default function ParaViewViewer({ caseName, active = true, onConfigure }: {
  caseName: string;
  active?: boolean;
  onConfigure?: () => void;
}) {
  const [workbench, setWorkbench] = useState<ParaViewWorkbenchState | null>(null);
  const [path, setPath] = useState('');
  const [configLoaded, setConfigLoaded] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startupStage, setStartupStage] = useState<ParaViewStartupStage>('locating');
  const [startupSeconds, setStartupSeconds] = useState(0);
  /** The Dashboard's background load was still running when this start began. */
  const [warmupRunning, setWarmupRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [error, setError] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [draft, setDraft] = useState<PropertyDraft>(EMPTY_DRAFT);
  const [displayDraft, setDisplayDraft] = useState<DisplayDraft>({ opacity: 1, lineWidth: 1, pointSize: 3 });
  const [playing, setPlaying] = useState(false);
  /**
  * The filter picker is an action menu, not a stored choice, so its value is
  * cleared after every pick. It must be cleared to '' rather than to undefined:
  * a Radix Select whose `value` becomes undefined turns UNCONTROLLED and keeps
  * showing the item it last displayed, and picking that same item again matches
  * its internal state and fires no change — so after deleting a Clip the menu
  * still read "Clip" and would not add another one until something else had
  * been chosen in between.
  */
  const [filterChoice, setFilterChoice] = useState<FilterType | ''>('');
  const [viewportTool, setViewportTool] = useState<ViewportTool>('camera');
  const [fileDialogOpen, setFileDialogOpen] = useState(false);
  const [caseFiles, setCaseFiles] = useState<ParaViewCaseFile[]>([]);
  const [fileSearch, setFileSearch] = useState('');
  const [selectedFile, setSelectedFile] = useState('');
  const [filesLoading, setFilesLoading] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const imageUrlRef = useRef('');
  const startedCaseRef = useRef('');
  const dragRef = useRef<{ x: number; y: number; action: 'camera' | 'manipulate'; mode: CameraMode | ManipulatorMode } | null>(null);
  const cameraInFlightRef = useRef(false);
  const pendingCameraRef = useRef<{ action: 'camera' | 'manipulate'; mode: CameraMode | ManipulatorMode; dx: number; dy: number } | null>(null);
  const stillRequestedRef = useRef(false);
  const stateSyncRequestedRef = useRef(false);
  const timeInFlightRef = useRef(false);
  const pendingTimeRef = useRef<number | null>(null);
  const wheelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);
  const nextImageSequenceRef = useRef(0);
  const shownImageSequenceRef = useRef(0);
  const lastSizeRef = useRef({ width: 1000, height: 700 });
  const stoppedRef = useRef(false);
  const wasActiveRef = useRef(active);
  const recoveriesRef = useRef(0);
  const imageRecoveryRef = useRef(0);
  const startRequestRef = useRef(0);

  const selected = useMemo(
    () => workbench?.pipeline.find(node => node.id === workbench.selectedId) || null,
    [workbench],
  );
  const visibleCaseFiles = useMemo(() => {
    const query = fileSearch.trim().toLowerCase();
    return query ? caseFiles.filter(file => file.path.toLowerCase().includes(query)) : caseFiles;
  }, [caseFiles, fileSearch]);

  // A hidden pane measures 0x0, so the last real measurement is the honest
  // answer: rendering at the fallback size would change the image's aspect.
  const startupIndex = Math.max(0, STARTUP_STEPS.findIndex(step => step.stage === startupStage));

  const imageSize = useCallback(() => {
    const width = Math.round(viewportRef.current?.clientWidth || 0);
    const height = Math.round(viewportRef.current?.clientHeight || 0);
    if (width > 0 && height > 0) {
      lastSizeRef.current = {
        width: Math.max(320, Math.min(1920, width)),
        height: Math.max(240, Math.min(1200, height)),
      };
    }
    return lastSizeRef.current;
  }, []);

  const showImage = useCallback((blob: Blob, sequence: number) => {
    if (sequence < shownImageSequenceRef.current || disposedRef.current) return;
    shownImageSequenceRef.current = sequence;
    imageRecoveryRef.current = 0;
    const next = URL.createObjectURL(blob);
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = next;
    setImageUrl(next);
  }, []);

  const fetchRender = useCallback(async (interactive = false) => {
    const sequence = ++nextImageSequenceRef.current;
    const size = imageSize();
    const quality = interactive ? 90 : 94;
    const response = await timedFetch(
      `/api/paraview?action=render&width=${size.width}&height=${size.height}&quality=${quality}`,
      { cache: 'no-store' },
      REQUEST_TIMEOUT_MS,
    );
    if (!response.ok) throw new Error(await errorFrom(response));
    showImage(await response.blob(), sequence);
  }, [imageSize, showImage]);

  const command = useCallback(async (
    name: string,
    data: Record<string, unknown> = {},
    options: { render?: boolean; interactive?: boolean; quiet?: boolean; applyState?: boolean } = {},
  ): Promise<ParaViewWorkbenchState | null> => {
    if (!options.quiet) setBusy(true);
    setError('');
    try {
      const response = await timedFetch('/api/paraview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'command', command: name, data }),
      }, REQUEST_TIMEOUT_MS);
      if (!response.ok) throw new Error(await errorFrom(response));
      const result = await response.json() as { state?: ParaViewWorkbenchState };
      if (result.state && options.applyState !== false) setWorkbench(result.state);
      if (options.render !== false) await fetchRender(options.interactive);
      return result.state || null;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'ParaView command failed.';
      setError(message);
      if (!options.quiet) toast.error(message);
      return null;
    } finally {
      if (!options.quiet) setBusy(false);
    }
  }, [fetchRender]);

  const loadCaseFiles = useCallback(async () => {
    setFilesLoading(true);
    setError('');
    try {
      const response = await timedFetch('/api/paraview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'command', command: 'list_case_files', data: {} }),
      }, REQUEST_TIMEOUT_MS);
      if (!response.ok) throw new Error(await errorFrom(response));
      const result = await response.json() as { files?: ParaViewCaseFile[] };
      const files = result.files || [];
      setCaseFiles(files);
      setSelectedFile(current => files.some(file => file.path === current) ? current : '');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Case files could not be listed.';
      setError(message);
      toast.error(message);
    } finally {
      setFilesLoading(false);
    }
  }, []);

  const showFileBrowser = () => {
    setFileDialogOpen(true);
    setFileSearch('');
    void loadCaseFiles();
  };

  const openSelectedFile = async () => {
    if (!selectedFile) return;
    setFilesLoading(true);
    const loaded = await command('open_case_file', { path: selectedFile });
    setFilesLoading(false);
    if (loaded) setFileDialogOpen(false);
  };

  const start = useCallback(async (force = false) => {
    if (!caseName || starting || !configLoaded) return;
    const requestId = ++startRequestRef.current;
    startedCaseRef.current = caseName;
    stoppedRef.current = false;
    imageRecoveryRef.current = 0;
    setStarting(true);
    setStartupStage('locating');
    setStartupSeconds(0);
    setPlaying(false);
    setError('');
    try {
      if (!force) {
        const sessionResponse = await timedFetch(
          '/api/paraview?action=session', { cache: 'no-store' }, REQUEST_TIMEOUT_MS,
        );
        if (sessionResponse.ok) {
          const current = await sessionResponse.json() as { session?: { caseName?: string } | null };
          if (current.session?.caseName === caseName) {
            const existing = await command('state', {}, { render: false, quiet: true, applyState: false });
            if (existing && requestId === startRequestRef.current && !stoppedRef.current) {
              recoveriesRef.current = 0;
              setWorkbench(existing);
              await fetchRender(true);
              window.setTimeout(() => {
                if (requestId === startRequestRef.current && !stoppedRef.current) void fetchRender(false);
              }, 80);
              return;
            }
          }
        }
      }
      const response = await timedFetch('/api/paraview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', case: caseName, path }),
      }, START_TIMEOUT_MS);
      if (!response.ok) throw new Error(await errorFrom(response));
      const result = await response.json() as { state: ParaViewWorkbenchState };
      if (requestId !== startRequestRef.current || stoppedRef.current) return;
      recoveriesRef.current = 0;
      setWorkbench(result.state);
      await fetchRender(true);
      window.setTimeout(() => {
        if (requestId === startRequestRef.current && !stoppedRef.current) void fetchRender(false);
      }, 80);
    } catch (cause) {
      if (requestId !== startRequestRef.current) return;
      const message = cause instanceof Error ? cause.message : 'ParaView could not start.';
      setError(message);
      setWorkbench(null);
    } finally {
      if (requestId === startRequestRef.current) setStarting(false);
    }
  }, [caseName, command, configLoaded, fetchRender, path, starting]);

  const stop = useCallback(async () => {
    startRequestRef.current += 1;
    shownImageSequenceRef.current = ++nextImageSequenceRef.current;
    setPlaying(false);
    setBusy(true);
    stoppedRef.current = true;
    try {
      await timedFetch('/api/paraview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      }, REQUEST_TIMEOUT_MS);
      startedCaseRef.current = caseName;
      setWorkbench(null);
      setImageUrl('');
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = '';
    } finally {
      setBusy(false);
    }
  }, [caseName]);

  useEffect(() => {
    disposedRef.current = false;
    let cancelled = false;
    const reloadConfig = () => void loadFoamyConfig().then(config => {
      if (cancelled) return;
      setPath(config['paraview-path'] || '');
      setConfigLoaded(true);
    });
    reloadConfig();
    // The saved ParaView path is a hint, not a precondition. If the config
    // bridge never answers, open the case with automatic detection rather than
    // leaving the tab waiting for a promise that will not settle.
    const configFallback = window.setTimeout(() => { if (!cancelled) setConfigLoaded(true); }, 8_000);
    window.addEventListener('paraview-config-changed', reloadConfig);
    return () => {
      cancelled = true;
      disposedRef.current = true;
      startRequestRef.current += 1;
      window.clearTimeout(configFallback);
      window.removeEventListener('paraview-config-changed', reloadConfig);
      if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    };
  }, []);

  // Ask the server which phase the engine is in, and count the seconds, so a
  // long first launch reads as progress rather than as a hang.
  useEffect(() => {
    if (!starting) return;
    const startedAt = Date.now();
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await timedFetch('/api/paraview?action=session', { cache: 'no-store' }, 20_000);
        if (!response.ok || cancelled) return;
        const data = await response.json() as {
          startup?: { stage?: ParaViewStartupStage } | null;
          warmup?: { state?: string } | null;
        };
        if (data.startup?.stage && !cancelled) setStartupStage(data.startup.stage);
        if (!cancelled) setWarmupRunning(data.warmup?.state === 'warming');
      } catch { /* the start request itself reports real failures */ }
    };
    const timer = window.setInterval(() => {
      setStartupSeconds(Math.round((Date.now() - startedAt) / 1000));
      void poll();
    }, 1_000);
    void poll();
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [starting]);

  const cancelStart = useCallback(async () => {
    startRequestRef.current += 1;
    shownImageSequenceRef.current = ++nextImageSequenceRef.current;
    stoppedRef.current = true;
    setStarting(false);
    setWorkbench(null);
    setError('ParaView startup was cancelled.');
    try {
      await timedFetch('/api/paraview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      }, REQUEST_TIMEOUT_MS);
    } catch { /* the pending start reports the outcome */ }
  }, []);

  /**
   * Start on first display, and recover on a later one. Switching away and back
   * used to be the only way out of a session that had failed or been dropped
   * while the tab was hidden; doing it here is what makes that unnecessary.
   */
  useEffect(() => {
    const shown = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!active || !caseName || !configLoaded || starting || stoppedRef.current) return;
    const firstStart = startedCaseRef.current !== caseName;
    const recover = shown && !workbench && recoveriesRef.current < 2;
    if (!firstStart && !recover) return;
    if (recover) recoveriesRef.current += 1;
    void start();
  }, [active, caseName, configLoaded, start, starting, workbench]);

  // A workbench without a picture is the other half of the same problem: the
  // state arrived, one render did not, and nothing asked again.
  useEffect(() => {
    if (!active || !workbench || imageUrl || starting || busy) return;
    if (imageRecoveryRef.current >= 3) return;
    imageRecoveryRef.current += 1;
    void fetchRender(false).catch(() => undefined);
  }, [active, busy, fetchRender, imageUrl, starting, workbench]);

  useEffect(() => {
    if (!selected) return;
    const stream = selected.streamTracer;
    setDraft({
      origin: selected.origin || [0, 0, 0],
      normal: selected.normal || [1, 0, 0],
      invert: selected.invert || false,
      contourAssociation: selected.contour?.association || 'POINTS',
      contourName: selected.contour?.name || '',
      contourValue: selected.contour?.value || 0,
      thresholdAssociation: selected.threshold?.association || 'CELLS',
      thresholdName: selected.threshold?.name || '',
      thresholdLower: selected.threshold?.lower || 0,
      thresholdUpper: selected.threshold?.upper || 1,
      streamName: stream?.name || '',
      streamSeedType: stream?.seedType || 'Point Cloud',
      streamCenter: stream?.center || [0, 0, 0],
      streamRadius: stream?.radius || 1,
      streamPoints: stream?.points || 50,
      streamPoint1: stream?.point1 || [0, 0, 0],
      streamPoint2: stream?.point2 || [1, 0, 0],
      streamResolution: stream?.resolution || 50,
      streamDirection: stream?.direction || 'BOTH',
      streamMaximumLength: stream?.maximumLength || 1,
      tubeRadius: selected.tube?.radius || 0.01,
      tubeSides: selected.tube?.sides || 8,
      calculatorAssociation: selected.calculator?.association || 'POINTS',
      calculatorExpression: selected.calculator?.expression || '',
      calculatorResultName: selected.calculator?.resultName || 'Result',
      gradientAssociation: selected.gradient?.association || 'POINTS',
      gradientName: selected.gradient?.name || '',
      gradientResultName: selected.gradient?.resultName || 'Gradient',
      glyphName: selected.glyph?.name || '',
      glyphScaleFactor: selected.glyph?.scaleFactor || 1,
      glyphMaxPoints: selected.glyph?.maxPoints || 1200,
      warpAssociation: selected.warp?.association || 'POINTS',
      warpName: selected.warp?.name || '',
      warpScaleFactor: selected.warp?.scaleFactor ?? 1,
      warpNormal: selected.warp?.normal || [0, 0, 1],
      warpUseNormal: selected.warp?.useNormal || false,
      transformTranslate: selected.transform?.translate || [0, 0, 0],
      transformRotate: selected.transform?.rotate || [0, 0, 0],
      transformScale: selected.transform?.scale || [1, 1, 1],
      reflectOrigin: selected.reflect?.origin || [0, 0, 0],
      reflectNormal: selected.reflect?.normal || [1, 0, 0],
      reflectCopyInput: selected.reflect?.copyInput ?? true,
      shrinkFactor: selected.shrink?.factor ?? 0.8,
      plotPoint1: selected.plotOverLine?.point1 || [0, 0, 0],
      plotPoint2: selected.plotOverLine?.point2 || [1, 1, 1],
      plotResolution: selected.plotOverLine?.resolution || 200,
    });
    setDisplayDraft({ opacity: selected.opacity, lineWidth: selected.lineWidth, pointSize: selected.pointSize });
  }, [selected]);

  useEffect(() => setViewportTool('camera'), [selected?.id]);

  const requestStillRender = useCallback(() => {
    stillRequestedRef.current = true;
    if (!cameraInFlightRef.current) {
      stillRequestedRef.current = false;
      void fetchRender(false);
    }
  }, [fetchRender]);

  const viewportRequest = useCallback(async (action: 'camera' | 'manipulate', mode: CameraMode | ManipulatorMode, dx: number, dy: number) => {
    if (!workbench) return;
    if (cameraInFlightRef.current) {
      const queued = pendingCameraRef.current;
      if (queued && queued.action === action && queued.mode === mode) {
        queued.dx += dx;
        queued.dy += dy;
      } else {
        pendingCameraRef.current = { action, mode, dx, dy };
      }
      return;
    }
    cameraInFlightRef.current = true;
    setCameraBusy(true);
    const sequence = ++nextImageSequenceRef.current;
    try {
      const size = imageSize();
      const response = await timedFetch('/api/paraview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'camera', cameraAction: action, mode, dx, dy,
          quality: 92, ...size,
        }),
      }, REQUEST_TIMEOUT_MS);
      if (!response.ok) throw new Error(await errorFrom(response));
      showImage(await response.blob(), sequence);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Camera command failed.');
    } finally {
      cameraInFlightRef.current = false;
      const queued = pendingCameraRef.current;
      pendingCameraRef.current = null;
      if (queued) {
        void viewportRequest(queued.action, queued.mode, queued.dx, queued.dy);
      } else {
        setCameraBusy(false);
        const needsState = stateSyncRequestedRef.current;
        const needsStill = stillRequestedRef.current;
        stateSyncRequestedRef.current = false;
        stillRequestedRef.current = false;
        if (needsState || needsStill) void (async () => {
          if (needsState) await command('state', {}, { render: false, quiet: true });
          if (needsStill) await fetchRender(false);
        })();
      }
    }
  }, [command, fetchRender, imageSize, showImage, workbench]);

  const cameraRequest = useCallback((mode: CameraMode, dx: number, dy: number) => {
    void viewportRequest('camera', mode, dx, dy);
  }, [viewportRequest]);

  const manipulatorRequest = useCallback((mode: ManipulatorMode, dx: number, dy: number) => {
    void viewportRequest('manipulate', mode, dx, dy);
  }, [viewportRequest]);

  const finishViewportInteraction = useCallback(() => {
    if (dragRef.current?.action === 'manipulate') stateSyncRequestedRef.current = true;
    dragRef.current = null;
    stillRequestedRef.current = true;
    if (!cameraInFlightRef.current) {
      const needsState = stateSyncRequestedRef.current;
      stateSyncRequestedRef.current = false;
      stillRequestedRef.current = false;
      void (async () => {
        if (needsState) await command('state', {}, { render: false, quiet: true });
        await fetchRender(false);
      })();
    }
  }, [command, fetchRender]);

  const cameraAction = useCallback(async (cameraActionName: 'reset_camera' | 'standard_view', view?: string) => {
    if (!workbench) return;
    setCameraBusy(true);
    const sequence = ++nextImageSequenceRef.current;
    try {
      const size = imageSize();
      const response = await timedFetch('/api/paraview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'camera', cameraAction: cameraActionName, view, quality: 94, ...size }),
      }, REQUEST_TIMEOUT_MS);
      if (!response.ok) throw new Error(await errorFrom(response));
      showImage(await response.blob(), sequence);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Camera command failed.');
    } finally {
      setCameraBusy(false);
    }
  }, [imageSize, showImage, workbench]);

  const requestTime = useCallback(async (time: number) => {
    if (timeInFlightRef.current) {
      pendingTimeRef.current = time;
      return;
    }
    timeInFlightRef.current = true;
    try {
      await command('time', { time }, { interactive: true, quiet: true });
    } finally {
      timeInFlightRef.current = false;
      const pending = pendingTimeRef.current;
      pendingTimeRef.current = null;
      if (pending !== null && pending !== time) void requestTime(pending);
    }
  }, [command]);

  useEffect(() => {
    if (!playing || !workbench || workbench.times.length < 2) return;
    const index = Math.max(0, workbench.times.findIndex(value => value === workbench.time));
    const timer = window.setTimeout(() => {
      const next = workbench.times[(index + 1) % workbench.times.length];
      void requestTime(next);
    }, 240);
    return () => window.clearTimeout(timer);
  }, [playing, workbench, requestTime]);

  useEffect(() => {
    if (!playing && workbench) void fetchRender(false).catch(() => undefined);
    // A still frame is useful when playback stops, not on every state update.
  }, [playing]);

  const updateVector = (field: keyof Pick<PropertyDraft, 'origin' | 'normal' | 'streamCenter' | 'streamPoint1' | 'streamPoint2' | 'warpNormal' | 'transformTranslate' | 'transformRotate' | 'transformScale' | 'reflectOrigin' | 'reflectNormal' | 'plotPoint1' | 'plotPoint2'>, index: number, value: string) => {
    const parsed = Number(value);
    setDraft(current => {
      const next = [...current[field]] as Vector3;
      next[index] = Number.isFinite(parsed) ? parsed : 0;
      return { ...current, [field]: next };
    });
  };

  const applyFilterProperties = () => {
    if (!selected) return;
    if (selected.type === 'Slice') void command('update', { origin: draft.origin, normal: draft.normal });
    else if (selected.type === 'Clip') void command('update', { origin: draft.origin, normal: draft.normal, invert: draft.invert });
    else if (selected.type === 'Contour') void command('update', { contour: { association: draft.contourAssociation, name: draft.contourName, value: draft.contourValue } });
    else if (selected.type === 'Threshold') void command('update', { threshold: { association: draft.thresholdAssociation, name: draft.thresholdName, lower: draft.thresholdLower, upper: draft.thresholdUpper } });
    else if (selected.type === 'StreamTracer') void command('update', { streamTracer: {
      name: draft.streamName, seedType: draft.streamSeedType, center: draft.streamCenter,
      radius: draft.streamRadius, points: draft.streamPoints, point1: draft.streamPoint1,
      point2: draft.streamPoint2, resolution: draft.streamResolution,
      direction: draft.streamDirection, maximumLength: draft.streamMaximumLength,
    } });
    else if (selected.type === 'Tube') void command('update', { tube: { radius: draft.tubeRadius, sides: draft.tubeSides } });
    else if (selected.type === 'Calculator') void command('update', { calculator: { association: draft.calculatorAssociation, expression: draft.calculatorExpression, resultName: draft.calculatorResultName } });
    else if (selected.type === 'Gradient') void command('update', { gradient: { association: draft.gradientAssociation, name: draft.gradientName, resultName: draft.gradientResultName } });
    else if (selected.type === 'Glyph') void command('update', { glyph: { name: draft.glyphName, scaleFactor: draft.glyphScaleFactor, maxPoints: draft.glyphMaxPoints } });
    else if (selected.type === 'WarpByVector' || selected.type === 'WarpByScalar') void command('update', { warp: { association: draft.warpAssociation, name: draft.warpName, scaleFactor: draft.warpScaleFactor, normal: draft.warpNormal, useNormal: draft.warpUseNormal } });
    else if (selected.type === 'Transform') void command('update', { transform: { translate: draft.transformTranslate, rotate: draft.transformRotate, scale: draft.transformScale } });
    else if (selected.type === 'Reflect') void command('update', { reflect: { origin: draft.reflectOrigin, normal: draft.reflectNormal, copyInput: draft.reflectCopyInput } });
    else if (selected.type === 'Shrink') void command('update', { shrink: { factor: draft.shrinkFactor } });
    else if (selected.type === 'PlotOverLine') void command('update', { plotOverLine: { point1: draft.plotPoint1, point2: draft.plotPoint2, resolution: draft.plotResolution } });
  };

  const applyDisplay = () => void command('update', { ...displayDraft });

  const setColor = (value: string) => {
    if (!selected) return;
    const [association, ...nameParts] = value.split(':');
    void command('update', { color: {
      association, name: nameParts.join(':'),
      preset: selected.color.preset, legend: selected.color.legend,
    } });
  };

  const updateColor = (changes: Partial<ParaViewPipelineNode['color']>) => {
    if (selected) void command('update', { color: { ...selected.color, ...changes } });
  };

  const addFilter = (filter: FilterType) => {
    setFilterChoice('');
    void command('add_filter', { filter });
  };

  const toggleManipulator = () => {
    if (!selected?.manipulatorAvailable) return;
    const enabled = !selected.manipulatorVisible;
    setViewportTool(enabled ? 'translate' : 'camera');
    void command('set_manipulator', { enabled });
  };

  const updateRegions = (regions: string[]) => {
    void command('update_reader', { regions });
  };

  const toggleRegion = (region: string, enabled: boolean) => {
    if (!workbench) return;
    const next = enabled
      ? [...new Set([...workbench.reader.selectedRegions, region])]
      : workbench.reader.selectedRegions.filter(item => item !== region);
    if (next.length === 0) {
      toast.error('Select at least one mesh region or patch.');
      return;
    }
    updateRegions(next);
  };

  const depthOf = (node: ParaViewPipelineNode): number => {
    let depth = 0;
    let parent = node.parent;
    while (parent) {
      depth += 1;
      parent = workbench?.pipeline.find(item => item.id === parent)?.parent || null;
    }
    return depth;
  };

  const downloadScreenshot = () => {
    if (!imageUrl) return;
    const link = document.createElement('a');
    link.href = imageUrl;
    link.download = `${caseName}-paraview.jpg`;
    link.click();
  };

  if (!caseName) {
    return (
      <div className="flex h-full min-h-[540px] items-center justify-center rounded-lg border bg-card text-center text-sm text-muted-foreground">
        <div><GitFork className="mx-auto mb-3 h-12 w-12 opacity-25" /><p>Select a case from the Dashboard to open it in ParaView.</p></div>
      </div>
    );
  }

  if (!workbench) {
    return (
      <div className="relative flex h-full min-h-[540px] items-center justify-center overflow-hidden rounded-lg border bg-[#252931] p-6 text-white">
        <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(circle_at_center,_hsl(var(--primary))_0,_transparent_60%)]" />
        <div className="relative max-w-lg text-center">
          {starting ? <>
            <div className="relative mx-auto mb-5 h-16 w-16"><div className="absolute inset-0 animate-ping rounded-full border border-cyan-400/40" /><Loader2 className="absolute inset-2 h-12 w-12 animate-spin text-cyan-400" /></div>
            <p className="font-medium">Opening {caseName}<span className="ml-2 font-mono text-xs text-white/50">{startupSeconds}s</span></p>
            <p className="mt-2 min-h-5 text-xs text-white/65">{STARTUP_STEPS[startupIndex].label}</p>
            <div className="mx-auto mt-4 flex w-56 gap-1">{STARTUP_STEPS.map((step, index) => <span key={step.stage} className={`h-1 flex-1 rounded ${index <= startupIndex ? 'bg-cyan-400' : 'bg-white/15'}`} />)}</div>
            {warmupRunning
              ? <p className="mx-auto mt-3 max-w-sm text-[11px] text-white/45">ParaView was already loading in the background; this start carries on from where that got to rather than beginning again.</p>
              : startupSeconds >= 20 && <p className="mx-auto mt-3 max-w-sm text-[11px] text-white/45">The first ParaView launch after a reboot loads its libraries from disk and can take a few minutes. Later ones start in seconds, and the background loading in the Dashboard&apos;s ParaView settings pays for it before you get here.</p>}
            <Button size="sm" variant="outline" className="mt-4 border-white/25 bg-white/5 text-white hover:bg-white/10 hover:text-white" onClick={() => void cancelStart()}>Cancel</Button>
          </> : <>
            <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-amber-400" />
            <p className="font-medium">ParaView workbench is not available</p>
            <p className="mt-2 text-sm text-white/65">{error || 'The background engine is stopped.'}</p>
            <div className="mt-4 flex justify-center gap-2">
              <Button onClick={() => void start(true)}><Play className="h-4 w-4" /> Start ParaView</Button>
              {onConfigure && <Button variant="outline" className="border-white/25 bg-white/5 text-white hover:bg-white/10 hover:text-white" onClick={onConfigure}><Settings className="h-4 w-4" /> Dashboard settings</Button>}
            </div>
          </>}
        </div>
      </div>
    );
  }

  const timeIndex = Math.max(0, workbench.times.findIndex(value => value === workbench.time));
  const scalarArrays = workbench.arrays.filter(array => array.components === 1);
  const pointScalarArrays = scalarArrays.filter(array => array.association === 'POINTS');
  const pointVectorArrays = workbench.arrays.filter(array => array.association === 'POINTS' && array.components >= 2);
  const patchRegions = workbench.reader.regions.filter(region => region.startsWith('patch/'));
  const internalRegion = workbench.reader.regions.find(region => region === 'internalMesh');
  const meshAxes = (['X', 'Y', 'Z'] as const).map((axis, index) => ({
    axis,
    min: workbench.reader.bounds[index * 2],
    max: workbench.reader.bounds[index * 2 + 1],
    length: workbench.reader.bounds[index * 2 + 1] - workbench.reader.bounds[index * 2],
    color: index === 0 ? 'text-red-500' : index === 1 ? 'text-emerald-500' : 'text-blue-500',
  }));
  const meshCenter = meshAxes.map(item => (item.min + item.max) / 2);
  const tubeReady = selected ? ['StreamTracer', 'PlotOverLine', 'ExtractEdges', 'Contour'].includes(selected.type) : false;
  const manipulatorTools: { mode: ManipulatorMode; label: string }[] = selected?.type === 'Slice' || selected?.type === 'Clip'
    ? [{ mode: 'translate', label: 'Move plane' }, { mode: 'rotate', label: 'Rotate plane' }]
    : selected?.type === 'StreamTracer' && selected.streamTracer?.seedType === 'Point Cloud'
      ? [{ mode: 'translate', label: 'Move sphere' }, { mode: 'scale', label: 'Resize sphere' }]
      : selected?.type === 'StreamTracer' || selected?.type === 'PlotOverLine'
        ? [{ mode: 'translate', label: 'Move line' }, { mode: 'point1', label: 'Point 1' }, { mode: 'point2', label: 'Point 2' }]
        : [];

  return (
    <div className="flex h-full min-h-[680px] flex-col overflow-hidden rounded-lg border bg-card shadow-sm">
      <div className="flex min-h-11 flex-wrap items-center gap-1 border-b bg-muted/35 px-2 py-1.5">
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={starting || busy} onClick={() => void start(true)} title="Reload the OpenFOAM case"><RefreshCw className={`h-3.5 w-3.5 ${starting ? 'animate-spin' : ''}`} /> Reload</Button>
        <Button size="icon" variant="ghost" className="h-7 w-7" disabled={busy} onClick={() => void command('refresh')} title="Refresh fields and timesteps" aria-label="Refresh fields and timesteps"><RefreshCw className="h-3.5 w-3.5" /></Button>
        <span className="mx-1 h-6 w-px bg-border" />
        <Select value={filterChoice} onValueChange={value => addFilter(value as FilterType)} disabled={busy}>
          <SelectTrigger size="sm" className="h-7 w-[178px] text-xs"><Search className="h-3.5 w-3.5" /><SelectValue placeholder="Add filter…" /></SelectTrigger>
          <SelectContent className="max-h-[520px] min-w-[260px]">
            {FILTER_GROUPS.map((group, groupIndex) => <React.Fragment key={group.label}>
              {groupIndex > 0 && <SelectSeparator />}
              <SelectGroup><SelectLabel className="font-semibold uppercase tracking-wide">{group.label}</SelectLabel>{group.filters.map(filter => <SelectItem key={filter} value={filter} disabled={!workbench.availableFilters.includes(filter) || (filter === 'Tube' && !tubeReady)}>{filterIcon(filter)}{filterLabel(filter)}</SelectItem>)}</SelectGroup>
            </React.Fragment>)}
          </SelectContent>
        </Select>
        <Button size="icon" variant="ghost" className="h-7 w-7" disabled={busy || selected?.id === 'reader'} onClick={() => void command('delete')} title="Delete selected filter" aria-label="Delete selected filter"><Trash2 className="h-3.5 w-3.5" /></Button>
        <span className="mx-1 h-6 w-px bg-border" />
        {['+X', '-X', '+Y', '-Y', '+Z', '-Z', 'Iso'].map(view => <Button key={view} size="sm" variant="ghost" className="h-7 min-w-7 px-1.5 font-mono text-[10px]" onClick={() => void cameraAction('standard_view', view)}>{view}</Button>)}
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void cameraAction('reset_camera')} title="Reset camera" aria-label="Reset camera"><Maximize2 className="h-3.5 w-3.5" /></Button>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={downloadScreenshot} title="Save screenshot" aria-label="Save screenshot"><Download className="h-3.5 w-3.5" /></Button>
        <div className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
          {(busy || cameraBusy) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {workbench.reader.decomposedAvailable && <Badge variant="outline" className="font-mono text-[10px]">MPI ×{workbench.reader.processorCount}</Badge>}
          <Badge variant="secondary" className="font-mono text-[10px]">ParaView {workbench.version}</Badge>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void stop()} title="Stop ParaView" aria-label="Stop ParaView"><Power className="h-3.5 w-3.5" /></Button>
        </div>
      </div>

      {error && <Alert variant="destructive" className="m-2 mb-0 py-2"><AlertTriangle className="h-4 w-4" /><AlertDescription className="text-xs">{error}</AlertDescription></Alert>}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[250px_minmax(360px,1fr)_310px]">
        <aside className="flex min-h-0 flex-col border-r bg-muted/15">
          <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b px-2 text-xs font-semibold"><Layers3 className="h-3.5 w-3.5" /> Pipeline Browser<Button size="sm" variant="ghost" className="ml-auto h-7 px-1.5 text-[9px]" disabled={busy} onClick={showFileBrowser} title="Open a data file from this case"><FolderOpen className="h-3.5 w-3.5" /> Open file</Button></div>
          <ScrollArea className="min-h-28 flex-1 border-b">
            <div className="p-1.5" role="tree" aria-label="ParaView pipeline">{workbench.pipeline.map(node => (
              <div
                key={node.id}
                role="treeitem"
                aria-selected={node.id === workbench.selectedId}
                tabIndex={0}
                className={`group flex h-8 cursor-default items-center gap-1 rounded px-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${node.id === workbench.selectedId ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                style={{ paddingLeft: `${4 + depthOf(node) * 15}px` }}
                onClick={() => void command('select', { id: node.id }, { render: false })}
                onKeyDown={event => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  void command('select', { id: node.id }, { render: false });
                }}
              >
                {depthOf(node) > 0 && <span className="text-muted-foreground">└</span>}
                <button className="rounded p-0.5 opacity-80 hover:bg-background/20" title={node.visible ? 'Hide' : 'Show'} aria-label={`${node.visible ? 'Hide' : 'Show'} ${node.label}`} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); void command('set_visibility', { id: node.id, visible: !node.visible }); }}>{node.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}</button>
                {filterIcon(node.type)}<span className="truncate" title={node.label}>{node.label}</span>
              </div>
            ))}</div>
          </ScrollArea>

          <div className="flex-shrink-0 border-b px-3 py-2">
            <div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold">OpenFOAM case</span>{workbench.reader.decomposedAvailable && <Badge variant="secondary" className="text-[9px]">{workbench.reader.processorCount} processors</Badge>}</div>
            <Select value={workbench.reader.caseType} onValueChange={caseType => void command('update_reader', { caseType })}>
              <SelectTrigger size="sm" className="w-full text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{workbench.reader.caseTypes.map(caseType => <SelectItem key={caseType} value={caseType} disabled={caseType === 'Decomposed Case' && !workbench.reader.decomposedAvailable}>{caseType}</SelectItem>)}</SelectContent>
            </Select>
          </div>

          <div className="flex min-h-0 flex-[1.1] flex-col">
            <div className="flex items-center justify-between px-3 py-2"><span className="text-xs font-semibold">Mesh regions</span><Badge variant="outline" className="text-[9px]">{workbench.reader.selectedRegions.length}/{workbench.reader.regions.length}</Badge></div>
            <div className="flex gap-1 px-2 pb-2">
              <Button size="sm" variant="outline" className="h-6 flex-1 px-1 text-[9px]" disabled={!internalRegion} onClick={() => internalRegion && updateRegions([internalRegion])}>Volume</Button>
              <Button size="sm" variant="outline" className="h-6 flex-1 px-1 text-[9px]" disabled={patchRegions.length === 0} onClick={() => updateRegions(patchRegions)}>Patches</Button>
              <Button size="sm" variant="outline" className="h-6 flex-1 px-1 text-[9px]" disabled={!internalRegion || patchRegions.length === 0} onClick={() => updateRegions([internalRegion!, ...patchRegions])}>Both</Button>
            </div>
            <ScrollArea className="min-h-0 flex-1"><div className="space-y-1 px-3 pb-3">{workbench.reader.regions.map(region => {
              const id = `pv-region-${region.replace(/[^a-z0-9]/gi, '-')}`;
              const prefix = region.includes('/') ? region.split('/')[0] : 'mesh';
              const label = region.includes('/') ? region.slice(region.indexOf('/') + 1) : region;
              return <div key={region} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-muted"><Checkbox id={id} checked={workbench.reader.selectedRegions.includes(region)} onCheckedChange={value => toggleRegion(region, value === true)} /><Label htmlFor={id} className="min-w-0 flex-1 truncate text-[10px]" title={region}>{label}</Label><span className="text-[8px] uppercase text-muted-foreground">{prefix}</span></div>;
            })}</div></ScrollArea>
          </div>
        </aside>

        <main className="relative min-h-[400px] overflow-hidden bg-[#252931]">
          <div
            ref={viewportRef}
            className="absolute inset-0 cursor-grab select-none overflow-hidden active:cursor-grabbing"
            onContextMenu={event => event.preventDefault()}
            onPointerDown={event => {
              event.currentTarget.setPointerCapture(event.pointerId);
              const editing = selected?.manipulatorVisible && viewportTool !== 'camera';
              dragRef.current = {
                x: event.clientX, y: event.clientY,
                action: editing ? 'manipulate' : 'camera',
                mode: editing ? viewportTool : event.button === 2 || event.shiftKey ? 'pan' : 'rotate',
              };
            }}
            onPointerMove={event => {
              const drag = dragRef.current;
              if (!drag) return;
              const dx = event.clientX - drag.x;
              const dy = event.clientY - drag.y;
              drag.x = event.clientX;
              drag.y = event.clientY;
              if (Math.abs(dx) + Math.abs(dy) <= 1) return;
              if (drag.action === 'manipulate') manipulatorRequest(drag.mode as ManipulatorMode, dx, dy);
              else cameraRequest(drag.mode as CameraMode, dx, dy);
            }}
            onPointerUp={finishViewportInteraction}
            onPointerCancel={finishViewportInteraction}
            onWheel={event => { event.preventDefault(); void cameraRequest('zoom', 0, event.deltaY); if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current); wheelTimerRef.current = setTimeout(requestStillRender, 140); }}
          >
            {imageUrl ? <img src={imageUrl} alt={`ParaView render of ${caseName}`} draggable={false} className="h-full w-full object-contain" /> : <Loader2 className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 animate-spin text-white/70" />}
            {selected?.manipulatorVisible && <div
              role="toolbar"
              aria-label="3D manipulator mode"
              className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 cursor-default items-center gap-1 rounded-lg border border-white/20 bg-black/65 p-1 shadow-lg backdrop-blur-sm"
              onPointerDown={event => event.stopPropagation()}
              onPointerMove={event => event.stopPropagation()}
              onPointerUp={event => event.stopPropagation()}
              onPointerCancel={event => event.stopPropagation()}
              onWheel={event => event.stopPropagation()}
            >
              <Button size="sm" variant="ghost" aria-pressed={viewportTool === 'camera'} className={`h-7 text-[10px] ${viewportTool === 'camera' ? 'bg-cyan-400 text-slate-950 shadow-sm hover:bg-cyan-300 hover:text-slate-950' : 'text-white/85 hover:bg-white/15 hover:text-white'}`} onClick={() => setViewportTool('camera')}><MousePointer2 className="h-3.5 w-3.5" /> Navigate</Button>
              {manipulatorTools.map(tool => <Button key={tool.mode} size="sm" variant="ghost" aria-pressed={viewportTool === tool.mode} className={`h-7 text-[10px] ${viewportTool === tool.mode ? 'bg-cyan-400 text-slate-950 shadow-sm hover:bg-cyan-300 hover:text-slate-950' : 'text-white/85 hover:bg-white/15 hover:text-white'}`} onClick={() => setViewportTool(tool.mode)}>{tool.mode === 'rotate' ? <Rotate3D className="h-3.5 w-3.5" /> : <Move3D className="h-3.5 w-3.5" />}{tool.label}</Button>)}
            </div>}
            <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/45 px-2 py-1 text-[10px] text-white/80">{selected?.manipulatorVisible && viewportTool !== 'camera' ? `Drag to ${manipulatorTools.find(tool => tool.mode === viewportTool)?.label.toLowerCase()}` : 'Left drag: rotate · Shift/right drag: pan · Wheel: zoom'} · full resolution</div>
            <div className="pointer-events-none absolute left-2 top-2 flex gap-1"><Badge className="bg-black/45 text-[9px] text-white hover:bg-black/45">{workbench.reader.caseType}</Badge>{!workbench.reader.hasTimeSteps && <Badge className="bg-amber-500/80 text-[9px] text-black hover:bg-amber-500/80">mesh only · time 0</Badge>}</div>
            {cameraBusy && <div className="pointer-events-none absolute right-2 top-2 rounded bg-black/45 p-1.5"><Rotate3D className="h-4 w-4 animate-pulse text-white" /></div>}
          </div>
        </main>

        <aside className="min-h-0 border-l bg-muted/10">
          <Tabs defaultValue="properties" className="flex h-full min-h-0 flex-col">
            <TabsList className="h-9 w-full flex-shrink-0 rounded-none border-b bg-transparent p-0">
              <TabsTrigger value="properties" className="h-8 flex-1 rounded-none text-[10px]"><SlidersHorizontal className="h-3 w-3" /> Properties</TabsTrigger>
              <TabsTrigger value="information" className="h-8 flex-1 rounded-none text-[10px]"><Info className="h-3 w-3" /> Information</TabsTrigger>
            </TabsList>

            <TabsContent value="properties" className="mt-0 min-h-0 flex-1"><ScrollArea className="h-full">{selected && <div className="space-y-4 p-3 text-xs">
              <div><p className="font-semibold">{selected.label}</p><p className="text-[10px] text-muted-foreground">{selected.type}</p>{selected.filePath && <p className="mt-1 break-all font-mono text-[9px] text-muted-foreground" title={selected.filePath}>{selected.filePath}</p>}</div>
              {selected.manipulatorAvailable && <Button size="sm" variant={selected.manipulatorVisible ? 'default' : 'outline'} className="h-8 w-full text-xs" disabled={busy} onClick={toggleManipulator}><Move3D className="h-4 w-4" />{selected.manipulatorVisible ? 'Hide 3D manipulator' : 'Edit graphically in 3D'}</Button>}

              <section className="space-y-2 border-t pt-3">
                <p className="font-semibold">Display</p>
                <Label className="text-[10px]">Representation</Label>
                <Select value={selected.representation} onValueChange={representation => void command('update', { representation })}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue /></SelectTrigger><SelectContent>{REPRESENTATIONS.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
                <div className="flex items-center justify-between"><Label className="text-[10px]">Opacity</Label><span className="font-mono text-[10px]">{displayDraft.opacity.toFixed(2)}</span></div>
                <input aria-label="Opacity" className="w-full accent-primary" type="range" min="0" max="1" step="0.05" value={displayDraft.opacity} onChange={event => setDisplayDraft(current => ({ ...current, opacity: Number(event.target.value) }))} onPointerUp={applyDisplay} onKeyUp={applyDisplay} />
                {(selected.representation === 'Surface With Edges' || selected.representation === 'Wireframe') && <><div className="flex items-center justify-between"><Label className="text-[10px]">Line width</Label><span className="font-mono text-[10px]">{displayDraft.lineWidth.toFixed(1)}</span></div><input aria-label="Line width" className="w-full accent-primary" type="range" min="1" max="10" step="0.5" value={displayDraft.lineWidth} onChange={event => setDisplayDraft(current => ({ ...current, lineWidth: Number(event.target.value) }))} onPointerUp={applyDisplay} onKeyUp={applyDisplay} /></>}
                {selected.representation === 'Points' && <><div className="flex items-center justify-between"><Label className="text-[10px]">Point size</Label><span className="font-mono text-[10px]">{displayDraft.pointSize.toFixed(1)}</span></div><input aria-label="Point size" className="w-full accent-primary" type="range" min="1" max="20" step="1" value={displayDraft.pointSize} onChange={event => setDisplayDraft(current => ({ ...current, pointSize: Number(event.target.value) }))} onPointerUp={applyDisplay} onKeyUp={applyDisplay} /></>}
              </section>

              <section className="space-y-2 border-t pt-3">
                <p className="font-semibold">Coloring</p>
                <Select value={selected.color.association === 'SOLID' ? 'SOLID:' : selected.color.association === 'BLOCKS' ? 'BLOCKS:vtkBlockColors' : `${selected.color.association}:${selected.color.name}`} onValueChange={setColor}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="SOLID:">Solid Color</SelectItem><SelectItem value="BLOCKS:vtkBlockColors">Patch / block colors</SelectItem>{workbench.arrays.map(array => <SelectItem key={`${array.association}:${array.name}`} value={`${array.association}:${array.name}`}>{array.name} ({array.association === 'CELLS' ? 'cell' : 'point'})</SelectItem>)}</SelectContent></Select>
                {(selected.color.association === 'CELLS' || selected.color.association === 'POINTS') && <><Label className="text-[10px]">Color preset</Label><Select value={selected.color.preset} onValueChange={preset => updateColor({ preset })}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue placeholder="Preset" /></SelectTrigger><SelectContent>{workbench.presets.map(preset => <SelectItem key={preset} value={preset}>{preset}</SelectItem>)}</SelectContent></Select><div className="flex items-center gap-2"><Checkbox id="pv-legend" checked={selected.color.legend} onCheckedChange={value => updateColor({ legend: value === true })} /><Label htmlFor="pv-legend" className="text-xs">Show color legend</Label></div></>}
              </section>

              {(selected.type === 'Slice' || selected.type === 'Clip') && <section className="space-y-2 border-t pt-3"><p className="font-semibold">{selected.type} plane</p><Label className="text-[10px]">Origin (X, Y, Z)</Label><VectorInputs value={draft.origin} onChange={(index, value) => updateVector('origin', index, value)} /><Label className="text-[10px]">Normal (X, Y, Z)</Label><VectorInputs value={draft.normal} onChange={(index, value) => updateVector('normal', index, value)} />{selected.type === 'Clip' && <div className="flex items-center gap-2"><Checkbox id="pv-invert" checked={draft.invert} onCheckedChange={value => setDraft(current => ({ ...current, invert: value === true }))} /><Label htmlFor="pv-invert" className="text-xs">Invert clip</Label></div>}<Button size="sm" className="h-7 w-full text-xs" disabled={busy} onClick={applyFilterProperties}>Apply</Button></section>}

              {selected.type === 'Contour' && <section className="space-y-2 border-t pt-3"><p className="font-semibold">Contour</p><Select value={`${draft.contourAssociation}:${draft.contourName}`} onValueChange={value => { const [association, ...parts] = value.split(':'); setDraft(current => ({ ...current, contourAssociation: association as 'CELLS' | 'POINTS', contourName: parts.join(':') })); }}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue placeholder="Point scalar" /></SelectTrigger><SelectContent>{pointScalarArrays.map(array => <SelectItem key={`${array.association}:${array.name}`} value={`${array.association}:${array.name}`}>{array.name}</SelectItem>)}</SelectContent></Select><Label className="text-[10px]">Isovalue</Label><Input type="number" step="any" className="h-7 font-mono text-xs" value={draft.contourValue} onChange={event => setDraft(current => ({ ...current, contourValue: Number(event.target.value) }))} /><Button size="sm" className="h-7 w-full text-xs" disabled={busy || !draft.contourName} onClick={applyFilterProperties}>Apply</Button></section>}

              {selected.type === 'Threshold' && <section className="space-y-2 border-t pt-3"><p className="font-semibold">Threshold</p><Select value={`${draft.thresholdAssociation}:${draft.thresholdName}`} onValueChange={value => { const [association, ...parts] = value.split(':'); const array = scalarArrays.find(item => item.association === association && item.name === parts.join(':')); setDraft(current => ({ ...current, thresholdAssociation: association as 'CELLS' | 'POINTS', thresholdName: parts.join(':'), thresholdLower: array?.range[0] ?? current.thresholdLower, thresholdUpper: array?.range[1] ?? current.thresholdUpper })); }}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue placeholder="Scalar array" /></SelectTrigger><SelectContent>{scalarArrays.map(array => <SelectItem key={`${array.association}:${array.name}`} value={`${array.association}:${array.name}`}>{array.name} ({array.association.toLowerCase()})</SelectItem>)}</SelectContent></Select><div className="grid grid-cols-2 gap-2"><div><Label className="text-[10px]">Minimum</Label><Input type="number" step="any" className="mt-1 h-7 font-mono text-xs" value={draft.thresholdLower} onChange={event => setDraft(current => ({ ...current, thresholdLower: Number(event.target.value) }))} /></div><div><Label className="text-[10px]">Maximum</Label><Input type="number" step="any" className="mt-1 h-7 font-mono text-xs" value={draft.thresholdUpper} onChange={event => setDraft(current => ({ ...current, thresholdUpper: Number(event.target.value) }))} /></div></div><Button size="sm" className="h-7 w-full text-xs" disabled={busy || !draft.thresholdName} onClick={applyFilterProperties}>Apply</Button></section>}

              {selected.type === 'StreamTracer' && <section className="space-y-2 border-t pt-3"><p className="font-semibold">Stream Tracer</p><Label className="text-[10px]">Vector field</Label><Select value={draft.streamName} onValueChange={streamName => setDraft(current => ({ ...current, streamName }))}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue /></SelectTrigger><SelectContent>{pointVectorArrays.map(array => <SelectItem key={array.name} value={array.name}>{array.name}</SelectItem>)}</SelectContent></Select><Label className="text-[10px]">Seed type</Label><Select value={draft.streamSeedType} onValueChange={streamSeedType => setDraft(current => ({ ...current, streamSeedType: streamSeedType as 'Point Cloud' | 'Line' }))}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Point Cloud">Point Cloud</SelectItem><SelectItem value="Line">Line</SelectItem></SelectContent></Select>{draft.streamSeedType === 'Point Cloud' ? <><Label className="text-[10px]">Center</Label><VectorInputs value={draft.streamCenter} onChange={(index, value) => updateVector('streamCenter', index, value)} /><div className="grid grid-cols-2 gap-2"><div><Label className="text-[10px]">Radius</Label><Input type="number" step="any" className="mt-1 h-7 font-mono text-xs" value={draft.streamRadius} onChange={event => setDraft(current => ({ ...current, streamRadius: Number(event.target.value) }))} /></div><div><Label className="text-[10px]">Seed points</Label><Input type="number" min="1" max="2000" className="mt-1 h-7 font-mono text-xs" value={draft.streamPoints} onChange={event => setDraft(current => ({ ...current, streamPoints: Number(event.target.value) }))} /></div></div></> : <><Label className="text-[10px]">Point 1</Label><VectorInputs value={draft.streamPoint1} onChange={(index, value) => updateVector('streamPoint1', index, value)} /><Label className="text-[10px]">Point 2</Label><VectorInputs value={draft.streamPoint2} onChange={(index, value) => updateVector('streamPoint2', index, value)} /><Label className="text-[10px]">Resolution</Label><Input type="number" min="1" max="2000" className="h-7 font-mono text-xs" value={draft.streamResolution} onChange={event => setDraft(current => ({ ...current, streamResolution: Number(event.target.value) }))} /></>}<Label className="text-[10px]">Integration direction</Label><Select value={draft.streamDirection} onValueChange={streamDirection => setDraft(current => ({ ...current, streamDirection: streamDirection as 'FORWARD' | 'BACKWARD' | 'BOTH' }))}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="FORWARD">Forward</SelectItem><SelectItem value="BACKWARD">Backward</SelectItem><SelectItem value="BOTH">Both</SelectItem></SelectContent></Select><Label className="text-[10px]">Maximum streamline length</Label><Input type="number" step="any" min="0" className="h-7 font-mono text-xs" value={draft.streamMaximumLength} onChange={event => setDraft(current => ({ ...current, streamMaximumLength: Number(event.target.value) }))} /><Button size="sm" className="h-7 w-full text-xs" disabled={busy || !draft.streamName} onClick={applyFilterProperties}>Apply</Button></section>}

              {selected.type === 'Tube' && <section className="space-y-2 border-t pt-3"><p className="font-semibold">Tube</p><Label className="text-[10px]">Radius</Label><Input type="number" step="any" min="0" className="h-7 font-mono text-xs" value={draft.tubeRadius} onChange={event => setDraft(current => ({ ...current, tubeRadius: Number(event.target.value) }))} /><Label className="text-[10px]">Sides</Label><Input type="number" min="3" max="64" className="h-7 font-mono text-xs" value={draft.tubeSides} onChange={event => setDraft(current => ({ ...current, tubeSides: Number(event.target.value) }))} /><Button size="sm" className="h-7 w-full text-xs" disabled={busy} onClick={applyFilterProperties}>Apply</Button></section>}

              {selected.type === 'Calculator' && <section className="space-y-2 border-t pt-3">
                <p className="font-semibold">Calculator</p>
                <Select value={draft.calculatorAssociation} onValueChange={value => setDraft(current => ({ ...current, calculatorAssociation: value as 'CELLS' | 'POINTS' }))}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="POINTS">Point data</SelectItem><SelectItem value="CELLS">Cell data</SelectItem></SelectContent></Select>
                <Label className="text-[10px]">Expression</Label><Input className="h-7 font-mono text-xs" value={draft.calculatorExpression} onChange={event => setDraft(current => ({ ...current, calculatorExpression: event.target.value }))} placeholder="mag(U)" />
                <Label className="text-[10px]">Result array</Label><Input className="h-7 font-mono text-xs" value={draft.calculatorResultName} onChange={event => setDraft(current => ({ ...current, calculatorResultName: event.target.value }))} />
                <Button size="sm" className="h-7 w-full text-xs" disabled={busy || !draft.calculatorExpression.trim()} onClick={applyFilterProperties}>Apply</Button>
              </section>}

              {selected.type === 'Gradient' && <section className="space-y-2 border-t pt-3">
                <p className="font-semibold">Gradient</p>
                <Select value={`${draft.gradientAssociation}:${draft.gradientName}`} onValueChange={value => { const [association, ...parts] = value.split(':'); setDraft(current => ({ ...current, gradientAssociation: association as 'CELLS' | 'POINTS', gradientName: parts.join(':') })); }}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue /></SelectTrigger><SelectContent>{scalarArrays.map(array => <SelectItem key={`${array.association}:${array.name}`} value={`${array.association}:${array.name}`}>{array.name} ({array.association.toLowerCase()})</SelectItem>)}</SelectContent></Select>
                <Label className="text-[10px]">Result array</Label><Input className="h-7 font-mono text-xs" value={draft.gradientResultName} onChange={event => setDraft(current => ({ ...current, gradientResultName: event.target.value }))} />
                <Button size="sm" className="h-7 w-full text-xs" disabled={busy || !draft.gradientName} onClick={applyFilterProperties}>Apply</Button>
              </section>}

              {selected.type === 'Glyph' && <section className="space-y-2 border-t pt-3">
                <p className="font-semibold">Glyph vectors</p>
                <Select value={draft.glyphName} onValueChange={glyphName => setDraft(current => ({ ...current, glyphName }))}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue /></SelectTrigger><SelectContent>{pointVectorArrays.map(array => <SelectItem key={array.name} value={array.name}>{array.name}</SelectItem>)}</SelectContent></Select>
                <div className="grid grid-cols-2 gap-2"><div><Label className="text-[10px]">Scale factor</Label><Input type="number" step="any" className="mt-1 h-7 font-mono text-xs" value={draft.glyphScaleFactor} onChange={event => setDraft(current => ({ ...current, glyphScaleFactor: Number(event.target.value) }))} /></div><div><Label className="text-[10px]">Max glyphs</Label><Input type="number" min="1" max="50000" className="mt-1 h-7 font-mono text-xs" value={draft.glyphMaxPoints} onChange={event => setDraft(current => ({ ...current, glyphMaxPoints: Number(event.target.value) }))} /></div></div>
                <Button size="sm" className="h-7 w-full text-xs" disabled={busy || !draft.glyphName} onClick={applyFilterProperties}>Apply</Button>
              </section>}

              {(selected.type === 'WarpByVector' || selected.type === 'WarpByScalar') && <section className="space-y-2 border-t pt-3">
                <p className="font-semibold">{filterLabel(selected.type)}</p>
                <Select value={`${draft.warpAssociation}:${draft.warpName}`} onValueChange={value => { const [association, ...parts] = value.split(':'); setDraft(current => ({ ...current, warpAssociation: association as 'CELLS' | 'POINTS', warpName: parts.join(':') })); }}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue /></SelectTrigger><SelectContent>{workbench.arrays.filter(array => selected.type === 'WarpByVector' ? array.components >= 2 : array.components === 1).map(array => <SelectItem key={`${array.association}:${array.name}`} value={`${array.association}:${array.name}`}>{array.name}</SelectItem>)}</SelectContent></Select>
                <Label className="text-[10px]">Scale factor</Label><Input type="number" step="any" className="h-7 font-mono text-xs" value={draft.warpScaleFactor} onChange={event => setDraft(current => ({ ...current, warpScaleFactor: Number(event.target.value) }))} />
                {selected.type === 'WarpByScalar' && <><div className="flex items-center gap-2"><Checkbox id="pv-warp-normal" checked={draft.warpUseNormal} onCheckedChange={value => setDraft(current => ({ ...current, warpUseNormal: value === true }))} /><Label htmlFor="pv-warp-normal" className="text-xs">Use explicit normal</Label></div><VectorInputs value={draft.warpNormal} onChange={(index, value) => updateVector('warpNormal', index, value)} /></>}
                <Button size="sm" className="h-7 w-full text-xs" disabled={busy || !draft.warpName} onClick={applyFilterProperties}>Apply</Button>
              </section>}

              {selected.type === 'Transform' && <section className="space-y-2 border-t pt-3">
                <p className="font-semibold">Transform geometry</p>
                <Label className="text-[10px]">Translate X, Y, Z</Label><VectorInputs value={draft.transformTranslate} onChange={(index, value) => updateVector('transformTranslate', index, value)} />
                <Label className="text-[10px]">Rotate X, Y, Z (degrees)</Label><VectorInputs value={draft.transformRotate} onChange={(index, value) => updateVector('transformRotate', index, value)} />
                <Label className="text-[10px]">Scale X, Y, Z</Label><VectorInputs value={draft.transformScale} onChange={(index, value) => updateVector('transformScale', index, value)} />
                <Button size="sm" className="h-7 w-full text-xs" disabled={busy} onClick={applyFilterProperties}>Apply</Button>
              </section>}

              {selected.type === 'Reflect' && <section className="space-y-2 border-t pt-3">
                <p className="font-semibold">Reflection plane</p>
                <Label className="text-[10px]">Origin X, Y, Z</Label><VectorInputs value={draft.reflectOrigin} onChange={(index, value) => updateVector('reflectOrigin', index, value)} />
                <Label className="text-[10px]">Normal X, Y, Z</Label><VectorInputs value={draft.reflectNormal} onChange={(index, value) => updateVector('reflectNormal', index, value)} />
                <div className="flex items-center gap-2"><Checkbox id="pv-reflect-copy" checked={draft.reflectCopyInput} onCheckedChange={value => setDraft(current => ({ ...current, reflectCopyInput: value === true }))} /><Label htmlFor="pv-reflect-copy" className="text-xs">Keep original geometry</Label></div>
                <Button size="sm" className="h-7 w-full text-xs" disabled={busy} onClick={applyFilterProperties}>Apply</Button>
              </section>}

              {selected.type === 'Shrink' && <section className="space-y-2 border-t pt-3"><p className="font-semibold">Shrink cells</p><div className="flex items-center justify-between"><Label className="text-[10px]">Factor</Label><span className="font-mono text-[10px]">{draft.shrinkFactor.toFixed(2)}</span></div><input aria-label="Shrink factor" className="w-full accent-primary" type="range" min="0" max="1" step="0.05" value={draft.shrinkFactor} onChange={event => setDraft(current => ({ ...current, shrinkFactor: Number(event.target.value) }))} /><Button size="sm" className="h-7 w-full text-xs" disabled={busy} onClick={applyFilterProperties}>Apply</Button></section>}

              {selected.type === 'PlotOverLine' && <section className="space-y-2 border-t pt-3">
                <p className="font-semibold">Sampling line</p>
                <Label className="text-[10px]">Point 1</Label><VectorInputs value={draft.plotPoint1} onChange={(index, value) => updateVector('plotPoint1', index, value)} />
                <Label className="text-[10px]">Point 2</Label><VectorInputs value={draft.plotPoint2} onChange={(index, value) => updateVector('plotPoint2', index, value)} />
                <Label className="text-[10px]">Resolution</Label><Input type="number" min="1" max="10000" className="h-7 font-mono text-xs" value={draft.plotResolution} onChange={event => setDraft(current => ({ ...current, plotResolution: Number(event.target.value) }))} />
                <Button size="sm" className="h-7 w-full text-xs" disabled={busy} onClick={applyFilterProperties}>Apply</Button>
              </section>}

              <section className="space-y-2 border-t pt-3"><p className="font-semibold">Render view</p><div className="flex items-center gap-2"><Checkbox id="pv-orientation" checked={workbench.view.orientationAxes} onCheckedChange={value => void command('update_view', { orientationAxes: value === true })} /><Label htmlFor="pv-orientation" className="text-xs">Orientation axes</Label></div><div className="flex items-center gap-2"><Checkbox id="pv-center-axes" checked={workbench.view.centerAxes} onCheckedChange={value => void command('update_view', { centerAxes: value === true })} /><Label htmlFor="pv-center-axes" className="text-xs">Center axes</Label></div><div className="flex items-center gap-2"><Checkbox id="pv-parallel" checked={workbench.view.parallelProjection} onCheckedChange={value => void command('update_view', { parallelProjection: value === true })} /><Label htmlFor="pv-parallel" className="text-xs">Parallel projection</Label></div><Label className="text-[10px]">Background</Label><Select value={workbench.view.background} onValueChange={background => void command('update_view', { background })}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue /></SelectTrigger><SelectContent>{['ParaView Dark', 'Midnight', 'Slate', 'White'].map(background => <SelectItem key={background} value={background}>{background}</SelectItem>)}</SelectContent></Select></section>
            </div>}</ScrollArea></TabsContent>

            <TabsContent value="information" className="mt-0 min-h-0 flex-1"><ScrollArea className="h-full"><div className="space-y-4 p-3 text-xs">
              <div><p className="font-semibold">{selected?.label}</p><p className="text-[10px] text-muted-foreground">Selected pipeline output</p></div>
              <section className="space-y-2 border-t pt-3">
                <div className="flex items-center justify-between"><p className="font-semibold">Case mesh extents</p><span className="text-[9px] text-muted-foreground">case units</span></div>
                <div className="overflow-hidden rounded border bg-background/60">
                  {meshAxes.map(item => <div key={item.axis} className="grid grid-cols-[24px_1fr_auto] items-center gap-2 border-b px-2 py-1.5 last:border-0"><span className={`font-mono text-sm font-bold ${item.color}`}>{item.axis}</span><span className="font-mono text-[9px] text-muted-foreground">{item.min.toPrecision(5)} → {item.max.toPrecision(5)}</span><span className="font-mono text-[10px] font-semibold">Δ {item.length.toPrecision(5)}</span></div>)}
                </div>
                <div className="grid grid-cols-[auto_1fr] gap-x-2 text-[10px]"><span className="text-muted-foreground">Center XYZ</span><span className="text-right font-mono">{meshCenter.map(value => value.toPrecision(5)).join(', ')}</span></div>
                <p className="text-[9px] leading-relaxed text-muted-foreground"><span className="font-semibold text-red-500">X</span> red · <span className="font-semibold text-emerald-500">Y</span> green · <span className="font-semibold text-blue-500">Z</span> blue. Δ is the mesh size along each direction.</p>
              </section>
              <section className="space-y-1 border-t pt-3 text-[10px] text-muted-foreground">
                <div className="flex justify-between"><span>Output points</span><span className="font-mono text-foreground">{workbench.points.toLocaleString()}</span></div>
                <div className="flex justify-between"><span>Output cells</span><span className="font-mono text-foreground">{workbench.cells.toLocaleString()}</span></div>
                <div className="pt-1"><p className="mb-1 font-medium text-foreground">Selected output bounds</p><p className="break-words font-mono">{workbench.bounds.map(value => Number(value).toPrecision(4)).join(', ')}</p></div>
              </section>
              <section className="space-y-2 border-t pt-3"><div className="flex items-center justify-between"><p className="font-semibold">Data arrays</p><Badge variant="outline" className="text-[9px]">{workbench.arrays.length}</Badge></div>{workbench.arrays.length === 0 ? <p className="text-[10px] text-muted-foreground">No result arrays at this pipeline output. Mesh-only representations remain available.</p> : workbench.arrays.map(array => <div key={`${array.association}:${array.name}`} className="rounded border bg-background/60 p-2"><div className="flex items-center justify-between gap-2"><span className="font-mono font-medium">{array.name}</span><Badge variant="secondary" className="text-[8px]">{array.association}</Badge></div><div className="mt-1 flex justify-between text-[9px] text-muted-foreground"><span>{array.components} component{array.components === 1 ? '' : 's'}</span><span className="font-mono">{array.range[0].toPrecision(4)} → {array.range[1].toPrecision(4)}</span></div></div>)}</section>
            </div></ScrollArea></TabsContent>
          </Tabs>
        </aside>
      </div>

      <div className="flex min-h-11 items-center gap-2 border-t bg-muted/25 px-3 py-1.5">
        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Previous timestep" title="Previous timestep" disabled={timeIndex <= 0 || busy || !workbench.reader.hasTimeSteps} onClick={() => void requestTime(workbench.times[timeIndex - 1])}><ChevronLeft className="h-4 w-4" /></Button>
        <Button size="icon" variant="outline" className="h-7 w-7" aria-label={playing ? 'Pause timestep playback' : 'Play timesteps'} title={playing ? 'Pause timestep playback' : 'Play timesteps'} disabled={workbench.times.length < 2 || !workbench.reader.hasTimeSteps} onClick={() => setPlaying(value => !value)}>{playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}</Button>
        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Next timestep" title="Next timestep" disabled={timeIndex >= workbench.times.length - 1 || busy || !workbench.reader.hasTimeSteps} onClick={() => void requestTime(workbench.times[timeIndex + 1])}><ChevronRight className="h-4 w-4" /></Button>
        <span className="text-[10px] text-muted-foreground">Time</span>
        <input aria-label="ParaView timestep" aria-valuetext={String(workbench.time)} className="min-w-24 flex-1 accent-primary" type="range" min="0" max={Math.max(0, workbench.times.length - 1)} step="1" value={timeIndex} disabled={workbench.times.length < 2 || busy || !workbench.reader.hasTimeSteps} onChange={event => void requestTime(workbench.times[Number(event.target.value)])} />
        <Badge variant="outline" className="min-w-20 justify-center font-mono text-[10px]">{workbench.time}</Badge>
        <span className="hidden max-w-44 truncate text-[10px] text-muted-foreground sm:inline" title={caseName}>{caseName}</span>
      </div>

      <Dialog open={fileDialogOpen} onOpenChange={setFileDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Open case data in ParaView</DialogTitle>
            <DialogDescription>Only supported files physically contained in <span className="font-mono">{caseName}</span> are available. The selected file is added as a new pipeline source.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input value={fileSearch} onChange={event => setFileSearch(event.target.value)} placeholder="Filter by folder or file name…" autoFocus />
            <Button size="icon" variant="outline" disabled={filesLoading} onClick={() => void loadCaseFiles()} title="Refresh case files"><RefreshCw className={`h-4 w-4 ${filesLoading ? 'animate-spin' : ''}`} /></Button>
          </div>
          <ScrollArea className="h-[340px] rounded-md border bg-muted/10">
            <div className="space-y-1 p-2">
              {filesLoading && caseFiles.length === 0 && <div className="flex h-28 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Scanning the case…</div>}
              {!filesLoading && visibleCaseFiles.length === 0 && <div className="flex h-28 flex-col items-center justify-center text-center text-sm text-muted-foreground"><FileBox className="mb-2 h-7 w-7 opacity-40" /><span>{caseFiles.length === 0 ? 'No supported ParaView data files were found in this case.' : 'No file matches this search.'}</span></div>}
              {visibleCaseFiles.map(file => <button
                type="button"
                key={file.path}
                className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-2 py-2 text-left transition-colors ${selectedFile === file.path ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-muted'}`}
                onClick={() => setSelectedFile(file.path)}
                onDoubleClick={() => { setSelectedFile(file.path); void command('open_case_file', { path: file.path }).then(loaded => { if (loaded) setFileDialogOpen(false); }); }}
              >
                <Badge variant="secondary" className="min-w-11 justify-center font-mono text-[9px]">{file.extension}</Badge>
                <span className="min-w-0"><span className="block truncate text-xs font-medium" title={file.name}>{file.name}</span><span className="block truncate font-mono text-[9px] text-muted-foreground" title={file.path}>{file.path}</span></span>
                <span className="font-mono text-[9px] text-muted-foreground">{fileSize(file.size)}</span>
              </button>)}
            </div>
          </ScrollArea>
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] text-muted-foreground">STL, OBJ, PLY, VTK/XML, PVD, XDMF, EnSight, Exodus and CSV</p>
            <div className="flex gap-2"><Button variant="outline" onClick={() => setFileDialogOpen(false)}>Cancel</Button><Button disabled={!selectedFile || filesLoading} onClick={() => void openSelectedFile()}><FolderOpen className="h-4 w-4" /> Open in pipeline</Button></div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

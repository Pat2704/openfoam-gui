'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { loadFoamyConfig } from '@/lib/foamy-store';
import type { ParaViewNodeType, ParaViewPipelineNode, ParaViewWorkbenchState } from '@/lib/paraview';
import {
  AlertTriangle, Box, ChevronLeft, ChevronRight, CircleDot, Download, Eye, EyeOff,
  Filter, GitFork, Info, Layers3, Loader2, Maximize2, Network, Pause, Play, Power,
  RefreshCw, Rotate3D, Scissors, Settings, SlidersHorizontal,
  SquareDashedMousePointer, Trash2, Waves,
} from 'lucide-react';
import { toast } from 'sonner';

type Vector3 = [number, number, number];
type FilterType = Exclude<ParaViewNodeType, 'OpenFOAMReader'>;
type CameraMode = 'rotate' | 'pan' | 'zoom';

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
}

interface DisplayDraft {
  opacity: number;
  lineWidth: number;
  pointSize: number;
}

const REPRESENTATIONS = ['Surface', 'Surface With Edges', 'Wireframe', 'Points', 'Outline'];
const COMMON_FILTERS: FilterType[] = ['Slice', 'Clip', 'Contour', 'StreamTracer'];
const MORE_FILTERS: FilterType[] = ['Threshold', 'Tube', 'CellDatatoPointData', 'ExtractSurface'];
const STARTUP_STAGES = [
  'Creating the paraFoam marker…',
  'Starting the ParaView Python engine…',
  'Reading mesh regions, fields and timesteps…',
  'Preparing the first offscreen render…',
];

const EMPTY_DRAFT: PropertyDraft = {
  origin: [0, 0, 0], normal: [1, 0, 0], invert: false,
  contourAssociation: 'POINTS', contourName: '', contourValue: 0,
  thresholdAssociation: 'CELLS', thresholdName: '', thresholdLower: 0, thresholdUpper: 1,
  streamName: '', streamSeedType: 'Point Cloud', streamCenter: [0, 0, 0],
  streamRadius: 1, streamPoints: 50, streamPoint1: [0, 0, 0], streamPoint2: [1, 0, 0],
  streamResolution: 50, streamDirection: 'BOTH', streamMaximumLength: 1,
  tubeRadius: 0.01, tubeSides: 8,
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
    StreamTracer: 'Stream Tracer',
    ExtractSurface: 'Extract Surface',
  };
  return labels[type] || type;
}

function filterIcon(type: ParaViewNodeType) {
  if (type === 'Slice') return <Scissors className="h-3.5 w-3.5" />;
  if (type === 'Clip') return <SquareDashedMousePointer className="h-3.5 w-3.5" />;
  if (type === 'Contour') return <CircleDot className="h-3.5 w-3.5" />;
  if (type === 'StreamTracer') return <Waves className="h-3.5 w-3.5" />;
  if (type === 'Threshold') return <Filter className="h-3.5 w-3.5" />;
  if (type === 'Tube') return <Network className="h-3.5 w-3.5" />;
  if (type === 'ExtractSurface') return <Box className="h-3.5 w-3.5" />;
  if (type === 'CellDatatoPointData') return <Layers3 className="h-3.5 w-3.5" />;
  return <GitFork className="h-3.5 w-3.5" />;
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
  const [startupStage, setStartupStage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [error, setError] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [draft, setDraft] = useState<PropertyDraft>(EMPTY_DRAFT);
  const [displayDraft, setDisplayDraft] = useState<DisplayDraft>({ opacity: 1, lineWidth: 1, pointSize: 3 });
  const [playing, setPlaying] = useState(false);
  const [moreFilter, setMoreFilter] = useState<FilterType | undefined>();

  const viewportRef = useRef<HTMLDivElement>(null);
  const imageUrlRef = useRef('');
  const startedCaseRef = useRef('');
  const dragRef = useRef<{ x: number; y: number; mode: CameraMode } | null>(null);
  const cameraInFlightRef = useRef(false);
  const pendingCameraRef = useRef<{ mode: CameraMode; dx: number; dy: number } | null>(null);
  const stillRequestedRef = useRef(false);
  const wheelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);
  const nextImageSequenceRef = useRef(0);
  const shownImageSequenceRef = useRef(0);

  const selected = useMemo(
    () => workbench?.pipeline.find(node => node.id === workbench.selectedId) || null,
    [workbench],
  );

  const imageSize = useCallback((interactive = false) => {
    const scale = interactive ? 0.58 : 1;
    return {
      width: Math.max(320, Math.min(1920, Math.round((viewportRef.current?.clientWidth || 1000) * scale))),
      height: Math.max(240, Math.min(1200, Math.round((viewportRef.current?.clientHeight || 700) * scale))),
    };
  }, []);

  const showImage = useCallback((blob: Blob, sequence: number) => {
    if (sequence < shownImageSequenceRef.current || disposedRef.current) return;
    shownImageSequenceRef.current = sequence;
    const next = URL.createObjectURL(blob);
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = next;
    setImageUrl(next);
  }, []);

  const fetchRender = useCallback(async (interactive = false) => {
    const sequence = ++nextImageSequenceRef.current;
    const size = imageSize(interactive);
    const quality = interactive ? 58 : 92;
    const response = await fetch(
      `/api/paraview?action=render&width=${size.width}&height=${size.height}&quality=${quality}`,
      { cache: 'no-store' },
    );
    if (!response.ok) throw new Error(await errorFrom(response));
    showImage(await response.blob(), sequence);
  }, [imageSize, showImage]);

  const command = useCallback(async (
    name: string,
    data: Record<string, unknown> = {},
    options: { render?: boolean; interactive?: boolean; quiet?: boolean } = {},
  ): Promise<ParaViewWorkbenchState | null> => {
    if (!options.quiet) setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/paraview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'command', command: name, data }),
      });
      if (!response.ok) throw new Error(await errorFrom(response));
      const result = await response.json() as { state?: ParaViewWorkbenchState };
      if (result.state) setWorkbench(result.state);
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

  const start = useCallback(async (force = false) => {
    if (!caseName || starting || !configLoaded) return;
    startedCaseRef.current = caseName;
    setStarting(true);
    setStartupStage(0);
    setPlaying(false);
    setError('');
    try {
      if (!force) {
        const sessionResponse = await fetch('/api/paraview?action=session', { cache: 'no-store' });
        if (sessionResponse.ok) {
          const current = await sessionResponse.json() as { session?: { caseName?: string } | null };
          if (current.session?.caseName === caseName) {
            const existing = await command('state', {}, { render: false, quiet: true });
            if (existing) {
              await fetchRender(true);
              window.setTimeout(() => void fetchRender(false), 80);
              return;
            }
          }
        }
      }
      const response = await fetch('/api/paraview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', case: caseName, path }),
      });
      if (!response.ok) throw new Error(await errorFrom(response));
      const result = await response.json() as { state: ParaViewWorkbenchState };
      setWorkbench(result.state);
      await fetchRender(true);
      window.setTimeout(() => void fetchRender(false), 80);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'ParaView could not start.';
      setError(message);
      setWorkbench(null);
    } finally {
      setStarting(false);
    }
  }, [caseName, command, configLoaded, fetchRender, path, starting]);

  const stop = useCallback(async () => {
    setPlaying(false);
    setBusy(true);
    try {
      await fetch('/api/paraview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
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
    window.addEventListener('paraview-config-changed', reloadConfig);
    return () => {
      cancelled = true;
      disposedRef.current = true;
      window.removeEventListener('paraview-config-changed', reloadConfig);
      if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (!starting) return;
    const timer = window.setInterval(() => setStartupStage(stage => Math.min(stage + 1, STARTUP_STAGES.length - 1)), 1150);
    return () => window.clearInterval(timer);
  }, [starting]);

  useEffect(() => {
    if (active && caseName && configLoaded && startedCaseRef.current !== caseName && !starting) void start();
  }, [active, caseName, configLoaded, start, starting]);

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
    });
    setDisplayDraft({ opacity: selected.opacity, lineWidth: selected.lineWidth, pointSize: selected.pointSize });
  }, [selected]);

  const requestStillRender = useCallback(() => {
    stillRequestedRef.current = true;
    if (!cameraInFlightRef.current) {
      stillRequestedRef.current = false;
      void fetchRender(false);
    }
  }, [fetchRender]);

  const cameraRequest = useCallback(async (mode: CameraMode, dx: number, dy: number) => {
    if (!workbench) return;
    if (cameraInFlightRef.current) {
      const queued = pendingCameraRef.current;
      if (queued && queued.mode === mode) {
        queued.dx += dx;
        queued.dy += dy;
      } else {
        pendingCameraRef.current = { mode, dx, dy };
      }
      return;
    }
    cameraInFlightRef.current = true;
    setCameraBusy(true);
    const sequence = ++nextImageSequenceRef.current;
    try {
      const size = imageSize(true);
      const response = await fetch('/api/paraview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'camera', cameraAction: 'camera', mode, dx, dy,
          quality: 55, ...size,
        }),
      });
      if (!response.ok) throw new Error(await errorFrom(response));
      showImage(await response.blob(), sequence);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Camera command failed.');
    } finally {
      cameraInFlightRef.current = false;
      const queued = pendingCameraRef.current;
      pendingCameraRef.current = null;
      if (queued) {
        void cameraRequest(queued.mode, queued.dx, queued.dy);
      } else {
        setCameraBusy(false);
        if (stillRequestedRef.current) {
          stillRequestedRef.current = false;
          void fetchRender(false);
        }
      }
    }
  }, [fetchRender, imageSize, showImage, workbench]);

  const cameraAction = useCallback(async (cameraActionName: 'reset_camera' | 'standard_view', view?: string) => {
    if (!workbench) return;
    setCameraBusy(true);
    const sequence = ++nextImageSequenceRef.current;
    try {
      const size = imageSize(false);
      const response = await fetch('/api/paraview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'camera', cameraAction: cameraActionName, view, quality: 92, ...size }),
      });
      if (!response.ok) throw new Error(await errorFrom(response));
      showImage(await response.blob(), sequence);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Camera command failed.');
    } finally {
      setCameraBusy(false);
    }
  }, [imageSize, showImage, workbench]);

  useEffect(() => {
    if (!playing || !workbench || workbench.times.length < 2) return;
    const index = Math.max(0, workbench.times.findIndex(value => value === workbench.time));
    const timer = window.setTimeout(() => {
      const next = workbench.times[(index + 1) % workbench.times.length];
      void command('time', { time: next }, { interactive: true, quiet: true });
    }, 520);
    return () => window.clearTimeout(timer);
  }, [playing, workbench, command]);

  useEffect(() => {
    if (!playing && workbench) void fetchRender(false).catch(() => undefined);
    // A still frame is useful when playback stops, not on every state update.
  }, [playing]);

  const updateVector = (field: keyof Pick<PropertyDraft, 'origin' | 'normal' | 'streamCenter' | 'streamPoint1' | 'streamPoint2'>, index: number, value: string) => {
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
    setMoreFilter(undefined);
    void command('add_filter', { filter });
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
            <p className="font-medium">Opening {caseName}</p>
            <p className="mt-2 min-h-5 text-xs text-white/65">{STARTUP_STAGES[startupStage]}</p>
            <div className="mx-auto mt-4 flex w-56 gap-1">{STARTUP_STAGES.map((_, index) => <span key={index} className={`h-1 flex-1 rounded ${index <= startupStage ? 'bg-cyan-400' : 'bg-white/15'}`} />)}</div>
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

  return (
    <div className="flex h-full min-h-[680px] flex-col overflow-hidden rounded-lg border bg-card shadow-sm">
      <div className="flex min-h-11 flex-wrap items-center gap-1 border-b bg-muted/35 px-2 py-1.5">
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={starting || busy} onClick={() => void start(true)} title="Reload the OpenFOAM case"><RefreshCw className={`h-3.5 w-3.5 ${starting ? 'animate-spin' : ''}`} /> Reload</Button>
        <Button size="icon" variant="ghost" className="h-7 w-7" disabled={busy} onClick={() => void command('refresh')} title="Refresh fields and timesteps"><RefreshCw className="h-3.5 w-3.5" /></Button>
        <span className="mx-1 h-6 w-px bg-border" />
        {COMMON_FILTERS.map(filter => (
          <Button key={filter} size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => addFilter(filter)} title={`Apply ${filterLabel(filter)}`}>
            {filterIcon(filter)}<span className="hidden xl:inline">{filterLabel(filter)}</span>
          </Button>
        ))}
        <Select value={moreFilter} onValueChange={value => addFilter(value as FilterType)}>
          <SelectTrigger size="sm" className="h-7 w-[118px] text-xs"><Filter className="h-3.5 w-3.5" /><SelectValue placeholder="More filters" /></SelectTrigger>
          <SelectContent>{MORE_FILTERS.map(filter => <SelectItem key={filter} value={filter}>{filterLabel(filter)}</SelectItem>)}</SelectContent>
        </Select>
        <Button size="icon" variant="ghost" className="h-7 w-7" disabled={busy || selected?.id === 'reader'} onClick={() => void command('delete')} title="Delete selected filter"><Trash2 className="h-3.5 w-3.5" /></Button>
        <span className="mx-1 h-6 w-px bg-border" />
        {['+X', '-X', '+Y', '-Y', '+Z', '-Z', 'Iso'].map(view => <Button key={view} size="sm" variant="ghost" className="h-7 min-w-7 px-1.5 font-mono text-[10px]" onClick={() => void cameraAction('standard_view', view)}>{view}</Button>)}
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void cameraAction('reset_camera')} title="Reset camera"><Maximize2 className="h-3.5 w-3.5" /></Button>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={downloadScreenshot} title="Save screenshot"><Download className="h-3.5 w-3.5" /></Button>
        <div className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
          {(busy || cameraBusy) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {workbench.reader.decomposedAvailable && <Badge variant="outline" className="font-mono text-[10px]">MPI ×{workbench.reader.processorCount}</Badge>}
          <Badge variant="secondary" className="font-mono text-[10px]">ParaView {workbench.version}</Badge>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void stop()} title="Stop ParaView"><Power className="h-3.5 w-3.5" /></Button>
        </div>
      </div>

      {error && <Alert variant="destructive" className="m-2 mb-0 py-2"><AlertTriangle className="h-4 w-4" /><AlertDescription className="text-xs">{error}</AlertDescription></Alert>}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[250px_minmax(360px,1fr)_310px]">
        <aside className="flex min-h-0 flex-col border-r bg-muted/15">
          <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b px-3 text-xs font-semibold"><Layers3 className="h-3.5 w-3.5" /> Pipeline Browser</div>
          <ScrollArea className="min-h-28 flex-1 border-b">
            <div className="p-1.5">{workbench.pipeline.map(node => (
              <div key={node.id} className={`group flex h-8 cursor-default items-center gap-1 rounded px-1 text-xs ${node.id === workbench.selectedId ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`} style={{ paddingLeft: `${4 + depthOf(node) * 15}px` }} onClick={() => void command('select', { id: node.id }, { render: false })}>
                {depthOf(node) > 0 && <span className="text-muted-foreground">└</span>}
                <button className="rounded p-0.5 opacity-80 hover:bg-background/20" title={node.visible ? 'Hide' : 'Show'} onClick={event => { event.stopPropagation(); void command('set_visibility', { id: node.id, visible: !node.visible }); }}>{node.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}</button>
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
            onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { x: event.clientX, y: event.clientY, mode: event.button === 2 || event.shiftKey ? 'pan' : 'rotate' }; }}
            onPointerMove={event => { const drag = dragRef.current; if (!drag) return; const dx = event.clientX - drag.x; const dy = event.clientY - drag.y; drag.x = event.clientX; drag.y = event.clientY; if (Math.abs(dx) + Math.abs(dy) > 1) void cameraRequest(drag.mode, dx, dy); }}
            onPointerUp={() => { dragRef.current = null; requestStillRender(); }}
            onPointerCancel={() => { dragRef.current = null; requestStillRender(); }}
            onWheel={event => { event.preventDefault(); void cameraRequest('zoom', 0, event.deltaY); if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current); wheelTimerRef.current = setTimeout(requestStillRender, 140); }}
          >
            {imageUrl ? <img src={imageUrl} alt={`ParaView render of ${caseName}`} draggable={false} className="h-full w-full object-contain" /> : <Loader2 className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 animate-spin text-white/70" />}
            <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/45 px-2 py-1 text-[10px] text-white/80">Left drag: rotate · Shift/right drag: pan · Wheel: zoom</div>
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
              <div><p className="font-semibold">{selected.label}</p><p className="text-[10px] text-muted-foreground">{selected.type}</p></div>

              <section className="space-y-2 border-t pt-3">
                <p className="font-semibold">Display</p>
                <Label className="text-[10px]">Representation</Label>
                <Select value={selected.representation} onValueChange={representation => void command('update', { representation })}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue /></SelectTrigger><SelectContent>{REPRESENTATIONS.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
                <div className="flex items-center justify-between"><Label className="text-[10px]">Opacity</Label><span className="font-mono text-[10px]">{displayDraft.opacity.toFixed(2)}</span></div>
                <input className="w-full accent-primary" type="range" min="0" max="1" step="0.05" value={displayDraft.opacity} onChange={event => setDisplayDraft(current => ({ ...current, opacity: Number(event.target.value) }))} onPointerUp={applyDisplay} onKeyUp={applyDisplay} />
                {(selected.representation === 'Surface With Edges' || selected.representation === 'Wireframe') && <><div className="flex items-center justify-between"><Label className="text-[10px]">Line width</Label><span className="font-mono text-[10px]">{displayDraft.lineWidth.toFixed(1)}</span></div><input className="w-full accent-primary" type="range" min="1" max="10" step="0.5" value={displayDraft.lineWidth} onChange={event => setDisplayDraft(current => ({ ...current, lineWidth: Number(event.target.value) }))} onPointerUp={applyDisplay} onKeyUp={applyDisplay} /></>}
                {selected.representation === 'Points' && <><div className="flex items-center justify-between"><Label className="text-[10px]">Point size</Label><span className="font-mono text-[10px]">{displayDraft.pointSize.toFixed(1)}</span></div><input className="w-full accent-primary" type="range" min="1" max="20" step="1" value={displayDraft.pointSize} onChange={event => setDisplayDraft(current => ({ ...current, pointSize: Number(event.target.value) }))} onPointerUp={applyDisplay} onKeyUp={applyDisplay} /></>}
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

              <section className="space-y-2 border-t pt-3"><p className="font-semibold">Render view</p><div className="flex items-center gap-2"><Checkbox id="pv-orientation" checked={workbench.view.orientationAxes} onCheckedChange={value => void command('update_view', { orientationAxes: value === true })} /><Label htmlFor="pv-orientation" className="text-xs">Orientation axes</Label></div><div className="flex items-center gap-2"><Checkbox id="pv-center-axes" checked={workbench.view.centerAxes} onCheckedChange={value => void command('update_view', { centerAxes: value === true })} /><Label htmlFor="pv-center-axes" className="text-xs">Center axes</Label></div><div className="flex items-center gap-2"><Checkbox id="pv-parallel" checked={workbench.view.parallelProjection} onCheckedChange={value => void command('update_view', { parallelProjection: value === true })} /><Label htmlFor="pv-parallel" className="text-xs">Parallel projection</Label></div><Label className="text-[10px]">Background</Label><Select value={workbench.view.background} onValueChange={background => void command('update_view', { background })}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue /></SelectTrigger><SelectContent>{['ParaView Dark', 'Midnight', 'Slate', 'White'].map(background => <SelectItem key={background} value={background}>{background}</SelectItem>)}</SelectContent></Select></section>
            </div>}</ScrollArea></TabsContent>

            <TabsContent value="information" className="mt-0 min-h-0 flex-1"><ScrollArea className="h-full"><div className="space-y-4 p-3 text-xs"><div><p className="font-semibold">{selected?.label}</p><p className="text-[10px] text-muted-foreground">Selected pipeline output</p></div><section className="space-y-1 border-t pt-3 text-[10px] text-muted-foreground"><div className="flex justify-between"><span>Points</span><span className="font-mono text-foreground">{workbench.points.toLocaleString()}</span></div><div className="flex justify-between"><span>Cells</span><span className="font-mono text-foreground">{workbench.cells.toLocaleString()}</span></div><div className="pt-1"><p className="mb-1 font-medium text-foreground">Bounds</p><p className="break-words font-mono">{workbench.bounds.map(value => Number(value).toPrecision(4)).join(', ')}</p></div></section><section className="space-y-2 border-t pt-3"><div className="flex items-center justify-between"><p className="font-semibold">Data arrays</p><Badge variant="outline" className="text-[9px]">{workbench.arrays.length}</Badge></div>{workbench.arrays.length === 0 ? <p className="text-[10px] text-muted-foreground">No result arrays at this pipeline output. Mesh-only representations remain available.</p> : workbench.arrays.map(array => <div key={`${array.association}:${array.name}`} className="rounded border bg-background/60 p-2"><div className="flex items-center justify-between gap-2"><span className="font-mono font-medium">{array.name}</span><Badge variant="secondary" className="text-[8px]">{array.association}</Badge></div><div className="mt-1 flex justify-between text-[9px] text-muted-foreground"><span>{array.components} component{array.components === 1 ? '' : 's'}</span><span className="font-mono">{array.range[0].toPrecision(4)} → {array.range[1].toPrecision(4)}</span></div></div>)}</section></div></ScrollArea></TabsContent>
          </Tabs>
        </aside>
      </div>

      <div className="flex min-h-11 items-center gap-2 border-t bg-muted/25 px-3 py-1.5">
        <Button size="icon" variant="ghost" className="h-7 w-7" disabled={timeIndex <= 0 || busy || !workbench.reader.hasTimeSteps} onClick={() => void command('time', { time: workbench.times[timeIndex - 1] })}><ChevronLeft className="h-4 w-4" /></Button>
        <Button size="icon" variant="outline" className="h-7 w-7" disabled={workbench.times.length < 2 || !workbench.reader.hasTimeSteps} onClick={() => setPlaying(value => !value)}>{playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}</Button>
        <Button size="icon" variant="ghost" className="h-7 w-7" disabled={timeIndex >= workbench.times.length - 1 || busy || !workbench.reader.hasTimeSteps} onClick={() => void command('time', { time: workbench.times[timeIndex + 1] })}><ChevronRight className="h-4 w-4" /></Button>
        <span className="text-[10px] text-muted-foreground">Time</span>
        <input className="min-w-24 flex-1 accent-primary" type="range" min="0" max={Math.max(0, workbench.times.length - 1)} step="1" value={timeIndex} disabled={workbench.times.length < 2 || busy || !workbench.reader.hasTimeSteps} onChange={event => void command('time', { time: workbench.times[Number(event.target.value)] })} />
        <Badge variant="outline" className="min-w-20 justify-center font-mono text-[10px]">{workbench.time}</Badge>
        <span className="hidden max-w-44 truncate text-[10px] text-muted-foreground sm:inline" title={caseName}>{caseName}</span>
      </div>
    </div>
  );
}

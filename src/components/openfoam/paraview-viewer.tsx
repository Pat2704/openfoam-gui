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
import { loadFoamyConfig } from '@/lib/foamy-store';
import type { ParaViewPipelineNode, ParaViewWorkbenchState } from '@/lib/paraview';
import {
  AlertTriangle, ChevronLeft, ChevronRight, CircleDot, Cuboid, Eye, EyeOff,
  Layers3, Loader2, Maximize2, Pause, Play, RefreshCw, Rotate3D, Scissors,
  Settings, SlidersHorizontal, SquareDashedMousePointer, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

type Vector3 = [number, number, number];
type FilterType = 'Slice' | 'Clip' | 'Contour' | 'CellDatatoPointData';
type CameraMode = 'rotate' | 'pan' | 'zoom';

interface PropertyDraft {
  origin: Vector3;
  normal: Vector3;
  invert: boolean;
  contourAssociation: 'CELLS' | 'POINTS';
  contourName: string;
  contourValue: number;
}

const REPRESENTATIONS = ['Surface', 'Surface With Edges', 'Wireframe', 'Points', 'Outline'];
const EMPTY_DRAFT: PropertyDraft = {
  origin: [0, 0, 0], normal: [1, 0, 0], invert: false,
  contourAssociation: 'POINTS', contourName: '', contourValue: 0,
};

async function errorFrom(response: Response): Promise<string> {
  try {
    const data = await response.json() as { error?: string };
    return data.error || `Request failed (HTTP ${response.status}).`;
  } catch {
    return `Request failed (HTTP ${response.status}).`;
  }
}

function nodeIcon(type: ParaViewPipelineNode['type']) {
  if (type === 'Slice') return <Scissors className="h-3.5 w-3.5" />;
  if (type === 'Clip') return <SquareDashedMousePointer className="h-3.5 w-3.5" />;
  if (type === 'Contour') return <CircleDot className="h-3.5 w-3.5" />;
  if (type === 'CellDatatoPointData') return <Layers3 className="h-3.5 w-3.5" />;
  return <Cuboid className="h-3.5 w-3.5" />;
}

function filterLabel(type: FilterType): string {
  return type === 'CellDatatoPointData' ? 'Cell Data to Point Data' : type;
}

export default function ParaViewViewer({ caseName, active = true, onConfigure }: {
  caseName: string;
  active?: boolean;
  onConfigure?: () => void;
}) {
  const [workbench, setWorkbench] = useState<ParaViewWorkbenchState | null>(null);
  const [path, setPath] = useState('');
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [error, setError] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [draft, setDraft] = useState<PropertyDraft>(EMPTY_DRAFT);
  const [playing, setPlaying] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageUrlRef = useRef('');
  const startedCaseRef = useRef('');
  const dragRef = useRef<{ x: number; y: number; mode: CameraMode } | null>(null);
  const cameraInFlightRef = useRef(false);
  const pendingCameraRef = useRef<{ mode: CameraMode; dx: number; dy: number } | null>(null);
  const disposedRef = useRef(false);

  const selected = useMemo(
    () => workbench?.pipeline.find(node => node.id === workbench.selectedId) || null,
    [workbench],
  );

  const imageSize = useCallback(() => ({
    width: Math.max(320, Math.min(1920, Math.round(viewportRef.current?.clientWidth || 1000))),
    height: Math.max(240, Math.min(1200, Math.round(viewportRef.current?.clientHeight || 700))),
  }), []);

  const showImage = useCallback((blob: Blob) => {
    const next = URL.createObjectURL(blob);
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = next;
    setImageUrl(next);
  }, []);

  const fetchRender = useCallback(async () => {
    const size = imageSize();
    const response = await fetch(`/api/paraview?action=render&width=${size.width}&height=${size.height}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(await errorFrom(response));
    showImage(await response.blob());
  }, [imageSize, showImage]);

  const command = useCallback(async (
    name: string,
    data: Record<string, unknown> = {},
    options: { render?: boolean; quiet?: boolean } = {},
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
      if (options.render !== false) await fetchRender();
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
    if (!caseName || starting) return;
    // Mark the automatic attempt immediately so a failed start does not loop.
    // The explicit Try again/Reload buttons can still force another attempt.
    startedCaseRef.current = caseName;
    setStarting(true);
    setPlaying(false);
    setError('');
    try {
      if (!force) {
        const sessionResponse = await fetch('/api/paraview?action=session', { cache: 'no-store' });
        if (sessionResponse.ok) {
          const current = await sessionResponse.json() as { session?: { caseName?: string } | null };
          if (current.session?.caseName === caseName) {
            const existing = await command('state', {}, { render: true, quiet: true });
            if (existing) {
              startedCaseRef.current = caseName;
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
      startedCaseRef.current = caseName;
      await fetchRender();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'ParaView could not start.';
      setError(message);
      setWorkbench(null);
    } finally {
      setStarting(false);
    }
  }, [caseName, command, fetchRender, path, starting]);

  useEffect(() => {
    disposedRef.current = false;
    let cancelled = false;
    void loadFoamyConfig().then(config => { if (!cancelled) setPath(config['paraview-path'] || ''); });
    const onConfig = () => void loadFoamyConfig().then(config => setPath(config['paraview-path'] || ''));
    window.addEventListener('paraview-config-changed', onConfig);
    return () => {
      cancelled = true;
      disposedRef.current = true;
      window.removeEventListener('paraview-config-changed', onConfig);
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (active && caseName && startedCaseRef.current !== caseName && !starting) void start();
  }, [active, caseName, start, starting]);

  useEffect(() => {
    if (!selected) return;
    setDraft({
      origin: selected.origin || [0, 0, 0], normal: selected.normal || [1, 0, 0], invert: selected.invert || false,
      contourAssociation: selected.contour?.association || 'POINTS', contourName: selected.contour?.name || '', contourValue: selected.contour?.value || 0,
    });
  }, [selected]);

  const cameraRequest = useCallback(async (mode: CameraMode, dx: number, dy: number) => {
    if (!workbench) return;
    if (cameraInFlightRef.current) {
      const queued = pendingCameraRef.current;
      if (queued && queued.mode === mode) { queued.dx += dx; queued.dy += dy; }
      else pendingCameraRef.current = { mode, dx, dy };
      return;
    }
    cameraInFlightRef.current = true;
    setCameraBusy(true);
    try {
      const size = imageSize();
      const response = await fetch('/api/paraview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'camera', cameraAction: 'camera', mode, dx, dy, ...size }),
      });
      if (!response.ok) throw new Error(await errorFrom(response));
      if (!disposedRef.current) showImage(await response.blob());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Camera command failed.');
    } finally {
      cameraInFlightRef.current = false;
      const queued = pendingCameraRef.current;
      pendingCameraRef.current = null;
      if (queued) void cameraRequest(queued.mode, queued.dx, queued.dy);
      else setCameraBusy(false);
    }
  }, [imageSize, showImage, workbench]);

  const cameraAction = useCallback(async (cameraActionName: 'reset_camera' | 'standard_view', view?: string) => {
    if (!workbench) return;
    setCameraBusy(true);
    try {
      const size = imageSize();
      const response = await fetch('/api/paraview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'camera', cameraAction: cameraActionName, view, ...size }),
      });
      if (!response.ok) throw new Error(await errorFrom(response));
      showImage(await response.blob());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Camera command failed.');
    } finally { setCameraBusy(false); }
  }, [imageSize, showImage, workbench]);

  useEffect(() => {
    if (!playing || !workbench || workbench.times.length < 2) return;
    const index = Math.max(0, workbench.times.findIndex(value => value === workbench.time));
    const timer = window.setTimeout(() => {
      const next = workbench.times[(index + 1) % workbench.times.length];
      void command('time', { time: next }, { quiet: true });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [playing, workbench, command]);

  const updateVector = (field: 'origin' | 'normal', index: number, value: string) => {
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
  };

  const setColor = (value: string) => {
    if (!selected) return;
    const [association, ...nameParts] = value.split(':');
    void command('update', { color: { association, name: nameParts.join(':'), preset: selected.color.preset, legend: selected.color.legend } });
  };

  const updateColor = (changes: Partial<ParaViewPipelineNode['color']>) => {
    if (selected) void command('update', { color: { ...selected.color, ...changes } });
  };

  const depthOf = (node: ParaViewPipelineNode): number => {
    let depth = 0, parent = node.parent;
    while (parent) { depth += 1; parent = workbench?.pipeline.find(item => item.id === parent)?.parent || null; }
    return depth;
  };

  if (!caseName) {
    return <div className="flex h-full min-h-[540px] items-center justify-center rounded-lg border bg-card text-center text-sm text-muted-foreground"><div><Cuboid className="mx-auto mb-3 h-12 w-12 opacity-25" /><p>Select a case from the Dashboard to open it in ParaView.</p></div></div>;
  }

  if (!workbench) {
    return (
      <div className="flex h-full min-h-[540px] items-center justify-center rounded-lg border bg-card p-6">
        <div className="max-w-lg text-center">
          {starting ? <><Loader2 className="mx-auto mb-3 h-10 w-10 animate-spin text-primary" /><p className="font-medium">Starting ParaView and reading {caseName}…</p><p className="mt-1 text-xs text-muted-foreground">The first load can take a few seconds.</p></> : <>
            <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-warning" /><p className="font-medium">ParaView workbench is not available</p><p className="mt-2 text-sm text-muted-foreground">{error || 'Start the ParaView engine for this case.'}</p>
            <div className="mt-4 flex justify-center gap-2"><Button onClick={() => void start(true)}><Play className="h-4 w-4" /> Try again</Button>{onConfigure && <Button variant="outline" onClick={onConfigure}><Settings className="h-4 w-4" /> Dashboard settings</Button>}</div>
          </>}
        </div>
      </div>
    );
  }

  const timeIndex = Math.max(0, workbench.times.findIndex(value => value === workbench.time));
  const contourArrays = workbench.arrays.filter(array => array.association === 'POINTS');

  return (
    <div className="flex h-full min-h-[680px] flex-col overflow-hidden rounded-lg border bg-card shadow-sm">
      <div className="flex min-h-11 flex-wrap items-center gap-1 border-b bg-muted/35 px-2 py-1.5">
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={starting || busy} onClick={() => void start(true)} title="Reload the OpenFOAM case"><RefreshCw className={`h-3.5 w-3.5 ${starting ? 'animate-spin' : ''}`} /> Reload</Button>
        <span className="mx-1 h-6 w-px bg-border" />
        {(['Slice', 'Clip', 'Contour', 'CellDatatoPointData'] as FilterType[]).map(filter => <Button key={filter} size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void command('add_filter', { filter })} title={`Apply ${filterLabel(filter)}`}>{filter === 'Slice' ? <Scissors className="h-3.5 w-3.5" /> : filter === 'Clip' ? <SquareDashedMousePointer className="h-3.5 w-3.5" /> : filter === 'Contour' ? <CircleDot className="h-3.5 w-3.5" /> : <Layers3 className="h-3.5 w-3.5" />}<span className="hidden xl:inline">{filterLabel(filter)}</span></Button>)}
        <Button size="icon" variant="ghost" className="h-7 w-7" disabled={busy || selected?.id === 'reader'} onClick={() => void command('delete')} title="Delete selected filter"><Trash2 className="h-3.5 w-3.5" /></Button>
        <span className="mx-1 h-6 w-px bg-border" />
        {['+X', '-X', '+Y', '-Y', '+Z', '-Z', 'Iso'].map(view => <Button key={view} size="sm" variant="ghost" className="h-7 min-w-7 px-1.5 font-mono text-[10px]" onClick={() => void cameraAction('standard_view', view)}>{view}</Button>)}
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void cameraAction('reset_camera')} title="Reset camera"><Maximize2 className="h-3.5 w-3.5" /></Button>
        <div className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">{(busy || cameraBusy) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}<Badge variant="secondary" className="font-mono text-[10px]">ParaView {workbench.version}</Badge></div>
      </div>

      {error && <Alert variant="destructive" className="m-2 mb-0 py-2"><AlertTriangle className="h-4 w-4" /><AlertDescription className="text-xs">{error}</AlertDescription></Alert>}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[220px_minmax(360px,1fr)_280px]">
        <aside className="min-h-0 border-r bg-muted/15">
          <div className="flex h-9 items-center gap-2 border-b px-3 text-xs font-semibold"><Layers3 className="h-3.5 w-3.5" /> Pipeline Browser</div>
          <ScrollArea className="h-[calc(100%-2.25rem)]"><div className="p-1.5">{workbench.pipeline.map(node => <div key={node.id} className={`group flex h-8 cursor-default items-center gap-1 rounded px-1 text-xs ${node.id === workbench.selectedId ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`} style={{ paddingLeft: `${4 + depthOf(node) * 15}px` }} onClick={() => void command('select', { id: node.id }, { render: false })}>
            {depthOf(node) > 0 && <span className="text-muted-foreground">└</span>}
            <button className="rounded p-0.5 opacity-80 hover:bg-background/20" title={node.visible ? 'Hide' : 'Show'} onClick={event => { event.stopPropagation(); void command('select', { id: node.id }, { render: false }).then(() => command('update', { visible: !node.visible })); }}>{node.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}</button>
            {nodeIcon(node.type)}<span className="truncate" title={node.label}>{node.label}</span>
          </div>)}</div></ScrollArea>
        </aside>

        <main className="relative min-h-[400px] overflow-hidden bg-[#252931]">
          <div ref={viewportRef} className="absolute inset-0 cursor-grab select-none overflow-hidden active:cursor-grabbing" onContextMenu={event => event.preventDefault()} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { x: event.clientX, y: event.clientY, mode: event.button === 2 || event.shiftKey ? 'pan' : 'rotate' }; }} onPointerMove={event => { const drag = dragRef.current; if (!drag) return; const dx = event.clientX - drag.x, dy = event.clientY - drag.y; drag.x = event.clientX; drag.y = event.clientY; if (Math.abs(dx) + Math.abs(dy) > 0) void cameraRequest(drag.mode, dx, dy); }} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }} onWheel={event => { event.preventDefault(); void cameraRequest('zoom', 0, event.deltaY); }}>
            {imageUrl ? <img src={imageUrl} alt={`ParaView render of ${caseName}`} draggable={false} className="h-full w-full object-contain" /> : <Loader2 className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 animate-spin text-white/70" />}
            <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/45 px-2 py-1 text-[10px] text-white/80">Left drag: rotate · Shift/right drag: pan · Wheel: zoom</div>
            {cameraBusy && <div className="pointer-events-none absolute right-2 top-2 rounded bg-black/45 p-1.5"><Rotate3D className="h-4 w-4 animate-pulse text-white" /></div>}
          </div>
        </main>

        <aside className="min-h-0 border-l bg-muted/10">
          <div className="flex h-9 items-center gap-2 border-b px-3 text-xs font-semibold"><SlidersHorizontal className="h-3.5 w-3.5" /> Properties</div>
          <ScrollArea className="h-[calc(100%-2.25rem)]">{selected && <div className="space-y-4 p-3 text-xs">
            <div><p className="font-semibold">{selected.label}</p><p className="text-[10px] text-muted-foreground">{selected.type}</p></div>
            <section className="space-y-2 border-t pt-3"><p className="font-semibold">Display</p><Label className="text-[10px]">Representation</Label>
              <Select value={selected.representation} onValueChange={value => void command('update', { representation: value })}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue /></SelectTrigger><SelectContent>{REPRESENTATIONS.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
              <div className="flex items-center justify-between"><Label className="text-[10px]">Opacity</Label><span className="font-mono text-[10px]">{selected.opacity.toFixed(2)}</span></div><input className="w-full accent-primary" type="range" min="0" max="1" step="0.05" value={selected.opacity} onChange={event => void command('update', { opacity: Number(event.target.value) })} />
            </section>
            <section className="space-y-2 border-t pt-3"><p className="font-semibold">Coloring</p>
              <Select value={selected.color.association === 'SOLID' ? 'SOLID:' : `${selected.color.association}:${selected.color.name}`} onValueChange={setColor}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="SOLID:">Solid Color</SelectItem>{workbench.arrays.map(array => <SelectItem key={`${array.association}:${array.name}`} value={`${array.association}:${array.name}`}>{array.name} ({array.association === 'CELLS' ? 'cell' : 'point'})</SelectItem>)}</SelectContent></Select>
              {selected.color.association !== 'SOLID' && <><Label className="text-[10px]">Color preset</Label><Select value={selected.color.preset} onValueChange={preset => updateColor({ preset })}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue placeholder="Preset" /></SelectTrigger><SelectContent>{workbench.presets.map(preset => <SelectItem key={preset} value={preset}>{preset}</SelectItem>)}</SelectContent></Select><div className="flex items-center gap-2"><Checkbox id="pv-legend" checked={selected.color.legend} onCheckedChange={value => updateColor({ legend: value === true })} /><Label htmlFor="pv-legend" className="text-xs">Show color legend</Label></div></>}
            </section>
            {(selected.type === 'Slice' || selected.type === 'Clip') && <section className="space-y-2 border-t pt-3"><p className="font-semibold">{selected.type} plane</p><Label className="text-[10px]">Origin (X, Y, Z)</Label><div className="grid grid-cols-3 gap-1">{draft.origin.map((value, index) => <Input key={index} type="number" step="any" className="h-7 px-1.5 font-mono text-[10px]" value={value} onChange={event => updateVector('origin', index, event.target.value)} />)}</div><Label className="text-[10px]">Normal (X, Y, Z)</Label><div className="grid grid-cols-3 gap-1">{draft.normal.map((value, index) => <Input key={index} type="number" step="any" className="h-7 px-1.5 font-mono text-[10px]" value={value} onChange={event => updateVector('normal', index, event.target.value)} />)}</div>{selected.type === 'Clip' && <div className="flex items-center gap-2"><Checkbox id="pv-invert" checked={draft.invert} onCheckedChange={value => setDraft(current => ({ ...current, invert: value === true }))} /><Label htmlFor="pv-invert" className="text-xs">Invert clip</Label></div>}<Button size="sm" className="h-7 w-full text-xs" disabled={busy} onClick={applyFilterProperties}>Apply</Button></section>}
            {selected.type === 'Contour' && <section className="space-y-2 border-t pt-3"><p className="font-semibold">Contour</p><Select value={`${draft.contourAssociation}:${draft.contourName}`} onValueChange={value => { const [association, ...parts] = value.split(':'); setDraft(current => ({ ...current, contourAssociation: association as 'CELLS' | 'POINTS', contourName: parts.join(':') })); }}><SelectTrigger size="sm" className="w-full text-xs"><SelectValue placeholder="Point array" /></SelectTrigger><SelectContent>{contourArrays.map(array => <SelectItem key={`${array.association}:${array.name}`} value={`${array.association}:${array.name}`}>{array.name}</SelectItem>)}</SelectContent></Select><Label className="text-[10px]">Isovalue</Label><Input type="number" step="any" className="h-7 font-mono text-xs" value={draft.contourValue} onChange={event => setDraft(current => ({ ...current, contourValue: Number(event.target.value) }))} /><Button size="sm" className="h-7 w-full text-xs" disabled={busy || !draft.contourName} onClick={applyFilterProperties}>Apply</Button></section>}
            <section className="space-y-1 border-t pt-3 text-[10px] text-muted-foreground"><div className="flex justify-between"><span>Points</span><span className="font-mono text-foreground">{workbench.points.toLocaleString()}</span></div><div className="flex justify-between"><span>Cells</span><span className="font-mono text-foreground">{workbench.cells.toLocaleString()}</span></div><div className="pt-1 font-mono">Bounds: {workbench.bounds.map(value => Number(value).toPrecision(3)).join(', ')}</div></section>
          </div>}</ScrollArea>
        </aside>
      </div>

      <div className="flex min-h-11 items-center gap-2 border-t bg-muted/25 px-3 py-1.5">
        <Button size="icon" variant="ghost" className="h-7 w-7" disabled={timeIndex <= 0 || busy} onClick={() => void command('time', { time: workbench.times[timeIndex - 1] })}><ChevronLeft className="h-4 w-4" /></Button><Button size="icon" variant="outline" className="h-7 w-7" disabled={workbench.times.length < 2} onClick={() => setPlaying(value => !value)}>{playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}</Button><Button size="icon" variant="ghost" className="h-7 w-7" disabled={timeIndex >= workbench.times.length - 1 || busy} onClick={() => void command('time', { time: workbench.times[timeIndex + 1] })}><ChevronRight className="h-4 w-4" /></Button><span className="text-[10px] text-muted-foreground">Time</span><input className="min-w-24 flex-1 accent-primary" type="range" min="0" max={Math.max(0, workbench.times.length - 1)} step="1" value={timeIndex} disabled={workbench.times.length < 2 || busy} onChange={event => void command('time', { time: workbench.times[Number(event.target.value)] })} /><Badge variant="outline" className="min-w-20 justify-center font-mono text-[10px]">{workbench.time}</Badge><span className="hidden max-w-44 truncate text-[10px] text-muted-foreground sm:inline" title={caseName}>{caseName}</span>
      </div>
    </div>
  );
}

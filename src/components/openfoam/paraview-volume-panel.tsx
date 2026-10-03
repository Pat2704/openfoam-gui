'use client';

import { useEffect, useState } from 'react';
import { Layers3, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { analysisNumber, currentAnalysisGuard, resampleRequest, volumeSettings } from '@/lib/paraview-analysis';
import type { ParaViewAnalysisPanelProps } from './paraview-analysis-panel';

export default function ParaViewVolumePanel({ workbench, locked, active, onCommand }: ParaViewAnalysisPanelProps) {
  const selected = workbench.pipeline.find(node => node.id === workbench.selectedId);
  const scalars = selected?.volumeCapabilities?.scalarArrays ?? [];
  const [field, setField] = useState('');
  const [points, setPoints] = useState<[string, string][]>([['0', '0'], ['1', '1']]);
  const [distance, setDistance] = useState('1');
  const [dimensions, setDimensions] = useState(['64', '64', '64']);

  useEffect(() => {
    if (!active || !selected) return;
    const scalar = scalars.find(array => array.name === selected.color.name && array.association === selected.color.association) || scalars.find(array => array.name === 'p') || scalars[0];
    setField(scalar ? JSON.stringify([scalar.association, scalar.name]) : '');
    const lo = scalar?.range[0] ?? 0, hi = scalar?.range[1] ?? 1;
    setPoints(selected.volume?.opacityPoints.map(point => point.map(String) as [string, string]) ?? [[String(lo), '0'], [String(hi > lo ? hi : lo + Math.max(Math.abs(lo) * 1e-6, 1e-6)), '1']]);
    const bounds = workbench.bounds;
    const span = Math.hypot(bounds[1] - bounds[0], bounds[3] - bounds[2], bounds[5] - bounds[4]);
    setDistance(String(selected.volume?.unitDistance ?? Math.max(span / 100, 1e-12)));
    setDimensions(selected.resample?.dimensions.map(String) ?? ['64', '64', '64']);
    // Drafts reset when the selected data changes, not on each render.
  }, [active, workbench.selectedId, workbench.dataRevision]);

  const handle = async (job: () => Promise<void>) => {
    try { await job(); }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : 'Volume settings failed.'); }
  };
  return <div className="space-y-3 p-3 text-xs">
    <p className="flex items-center gap-1 font-semibold"><Layers3 className="h-4 w-4 text-orange-500" /> Volume rendering</p>
    <p className="text-muted-foreground">Map a scalar field to color and opacity through the volume. Opacity unit distance is a visualization parameter, expressed in the mesh coordinate units; it is not material density.</p>
    {!selected?.volumeCapabilities?.supported && <p className="text-amber-600">{selected?.volumeCapabilities?.reason || 'Volume rendering is unavailable for this output.'}</p>}
    <Select value={field || undefined} disabled={locked || !scalars.length} onValueChange={value => {
      setField(value);
      const [association, name] = JSON.parse(value) as [string, string];
      const scalar = scalars.find(item => item.association === association && item.name === name);
      if (scalar) { const [lo, hi] = scalar.range; setPoints([[String(lo), '0'], [String(hi > lo ? hi : lo + Math.max(Math.abs(lo) * 1e-6, 1e-6)), '1']]); }
    }}><SelectTrigger className="h-8" aria-label="Volume scalar field"><SelectValue placeholder="Scalar field" /></SelectTrigger><SelectContent>{scalars.map(array => <SelectItem key={`${array.association}:${array.name}`} value={JSON.stringify([array.association, array.name])}>{array.name} ({array.association})</SelectItem>)}</SelectContent></Select>
    <div className="space-y-1"><div className="grid grid-cols-[1fr_1fr_24px] gap-1 text-muted-foreground"><span>Scalar value</span><span>Opacity (0–1)</span></div>{points.map((point, index) => <div key={index} className="grid grid-cols-[1fr_1fr_24px] gap-1"><Input className="h-8 text-xs" aria-label={`Opacity scalar ${index + 1}`} type="number" step="any" value={point[0]} disabled={locked} onChange={event => setPoints(items => items.map((item, i) => i === index ? [event.target.value, item[1]] : item))} /><Input className="h-8 text-xs" aria-label={`Opacity value ${index + 1}`} type="number" min="0" max="1" step="0.05" value={point[1]} disabled={locked} onChange={event => setPoints(items => items.map((item, i) => i === index ? [item[0], event.target.value] : item))} /><Button size="icon" variant="ghost" className="h-8 w-6" disabled={locked || points.length <= 2} aria-label={`Remove opacity point ${index + 1}`} onClick={() => setPoints(items => items.filter((_, i) => i !== index))}><Trash2 className="h-3 w-3" /></Button></div>)}</div>
    <Button size="sm" variant="ghost" disabled={locked || points.length >= 16} onClick={() => setPoints(items => {
      const first = items[0], second = items[1];
      return [first, [String((Number(first[0]) + Number(second[0])) / 2), String((Number(first[1]) + Number(second[1])) / 2)], ...items.slice(1)];
    })}><Plus className="h-3 w-3" /> Add opacity knot</Button>
    <label className="block space-y-1">Opacity unit distance<Input className="h-8" aria-label="Opacity unit distance" type="number" step="any" min="0" value={distance} disabled={locked} onChange={event => setDistance(event.target.value)} /></label>
    <Button size="sm" disabled={locked || !field || !selected?.volumeCapabilities?.supported} onClick={() => void handle(async () => {
      const [association, name] = JSON.parse(field) as ['CELLS' | 'POINTS', string];
      const volume = volumeSettings({ opacityPoints: points.map(point => [analysisNumber(point[0], 'opacity scalar'), analysisNumber(point[1], 'opacity')]), unitDistance: analysisNumber(distance, 'opacity unit distance') });
      await onCommand('update', { ...currentAnalysisGuard(workbench), representation: 'Volume', color: { association, name, preset: selected!.color.preset, legend: selected!.color.legend }, volume });
    })}>Apply volume and opacity</Button>
    <section className="space-y-2 border-t pt-3"><p className="font-semibold">Resample to Image</p><p className="text-muted-foreground">Create a regular XYZ sampling grid using input bounds. This interpolates existing fields; it does not refine the simulation. Each dimension is 2–160, with at most two million sample points. Outside-mesh samples retain ParaView&apos;s validity mask.</p><div className="grid grid-cols-3 gap-1">{dimensions.map((value, index) => <Input key={index} className="h-8 text-xs" aria-label={`Resample ${'XYZ'[index]} dimension`} type="number" min="2" max="160" step="1" value={value} disabled={locked} onChange={event => setDimensions(items => items.map((item, i) => i === index ? event.target.value : item))} />)}</div><Button size="sm" variant="outline" disabled={locked || !workbench.analysisCapabilities?.resample || selected?.renderable === false} onClick={() => void handle(async () => { await onCommand('resample_to_image', { ...resampleRequest({ ...currentAnalysisGuard(workbench), dimensions: dimensions.map((value, index) => analysisNumber(value, `sampling ${'XYZ'[index]} dimension`)) }) }); })}>Create sampling grid</Button></section>
  </div>;
}

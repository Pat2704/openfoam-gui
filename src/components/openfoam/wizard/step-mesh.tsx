'use client';

/**
 * The Mesh step, as a sequence of sub-steps in the order a real meshing
 * workflow takes them.
 *
 *   Box only         domain → cells and grading → patches → blockMeshDict
 *   Box + geometry   geometry (units, which side the fluid is) → surfaceFeatures
 *                    → background blockMesh (and its patches) → refinement
 *                    (surface levels, regions as patches, refinement regions)
 *                    → insidePoint → snapping → layers → mesh quality → review
 *
 * That is also the order the commands run in (src/lib/snappy-templates.ts:
 * meshSteps): surfaceTransformPoints for non-metre units, surfaceFeatures,
 * blockMesh, snappyHexMesh, checkMesh. Every value the installation's .cfg
 * already sets is shown with that value and written only when changed.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import {
  Grid3x3, Upload, Trash2, Wand2, RefreshCw, Eye, AlertTriangle, CheckCircle2, Info, Loader2, Plus,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import {
  defaultBoxPatches, meshPatches, meshProblems, type MeshSpec, type PatchRole,
} from '@/lib/case-templates';
import {
  CFG_DEFAULTS, DEFAULT_SURFACE_LEVELS, UNIT_SCALE,
  dictFile, effectiveBbox, geometryBbox, geometryFileName, internalBackgroundPatches, meshStepCommand,
  meshSteps, newRefinementRegion, proposeBackground, proposeInsidePoint, proposeRefinementBox,
  snappyPatches, snappyProblems, surfaceGroupName, surfaceNameFromFile,
  type FlowSide, type LengthUnit, type RefinementRegion, type SnappySettings, type SnappySurface,
} from '@/lib/snappy-templates';
import { GEOMETRY_MAX_BYTES, geometryKind, isGzip, type Vec3 } from '@/lib/geometry';
import { ROLE_INFO } from '@/lib/wizard/roles';
import { readGeometry, type InsideCheck, type LoadedGeometry } from './geometry-io';
import BoxPatchEditor from './box-patches';
import { Choice, Hint, InheritField, NumField, SubStepNav, Vec3Field, type SubStep } from './ui';

export interface MeshStepProps {
  /** full: 13/14, with the snappyHexMesh option. basic: blockMesh only. */
  tier: 'full' | 'basic';
  mesh: MeshSpec;
  setMesh: (update: (m: MeshSpec) => MeshSpec) => void;
  meshOverride: string | null;
  setMeshOverride: (v: string | null) => void;
  blockMeshDict: string;
  snappy: SnappySettings | null;
  setSnappy: (update: (s: SnappySettings) => SnappySettings) => void;
  onEnableSnappy: () => void;
  onDisableSnappy: () => void;
  snappySupport: { available: boolean; reason: string | null } | null;
  geometry: Record<string, LoadedGeometry>;
  setGeometry: (update: (g: Record<string, LoadedGeometry>) => Record<string, LoadedGeometry>) => void;
  insideCheck: InsideCheck;
  /** The ray test against every loaded surface; undefined when none is loaded. */
  isInsideBody?: (p: Vec3) => boolean;
  roles: PatchRole[];
  snappyDict: string;
  featuresDict: string;
  qualityDict: string;
  onPreview: (content: string, name: string) => void;
}

const BLOCK_STEPS = [
  { id: 'domain', title: 'Domain', re: /bounds|thickness|inverted|scale must/i },
  { id: 'cells', title: 'Cells and grading', re: /cell count|cells|grading/i },
  { id: 'patches', title: 'Patches', re: /face|Patch names|patches are called|empty patch|frontAndBack/i },
  { id: 'dict', title: 'blockMeshDict', re: /blockMeshDict/i },
];

const SNAPPY_STEPS = [
  { id: 'geometry', title: 'Geometry', re: /No geometry|Surface name|Two surfaces|geometry has no region/i },
  { id: 'features', title: 'Surface features', re: /feature level|includedAngle/i },
  { id: 'background', title: 'Background mesh', re: /background box|stretched|scale to 1|3D mesh|enclose|can only mesh|bounds|thickness|inverted|face|Patch names/i },
  { id: 'refine', title: 'Refinement', re: /levels|refinement region|the level|radius|axis points|patch group|two roles|both a box patch/i },
  { id: 'inside', title: 'insidePoint', re: /insidePoint/i },
  { id: 'snap', title: 'Snapping', re: /^$/ },
  { id: 'layers', title: 'Layers', re: /layer/i },
  { id: 'quality', title: 'Mesh quality', re: /^$/ },
  { id: 'review', title: 'Review', re: /^$/ },
];

const UNITS: { v: LengthUnit; label: string }[] = [
  { v: 'm', label: 'metres' }, { v: 'mm', label: 'millimetres' }, { v: 'cm', label: 'centimetres' }, { v: 'in', label: 'inches' },
];

const fmt = (v: number) => String(Number(v.toPrecision(4)));

export default function MeshStep(p: MeshStepProps) {
  const { mesh, setMesh, snappy, setSnappy } = p;
  const [sub, setSub] = useState(0);
  const snappyOn = !!snappy;
  useEffect(() => { setSub(0); }, [snappyOn]);

  const boxNames = meshPatches(mesh).map(x => x.name);
  const allProblems = snappy
    ? [...meshProblems(mesh), ...snappyProblems(snappy, mesh, null, boxNames)]
    : meshProblems(mesh);
  const defs = snappy ? SNAPPY_STEPS : BLOCK_STEPS;
  const steps: SubStep[] = defs.map(d => ({ id: d.id, title: d.title, problems: allProblems.filter(x => d.re.test(x)).length }));
  const current = defs[Math.min(sub, defs.length - 1)].id;
  const here = allProblems.filter(x => defs[Math.min(sub, defs.length - 1)].re.test(x));

  const cells = Math.max(1, Math.round(mesh.nx)) * Math.max(1, Math.round(mesh.ny)) * (mesh.twoD ? 1 : Math.max(1, Math.round(mesh.nz)));
  const h = [(mesh.x1 - mesh.x0) / Math.max(1, mesh.nx), (mesh.y1 - mesh.y0) / Math.max(1, mesh.ny), (mesh.z1 - mesh.z0) / Math.max(1, mesh.nz)];

  const field = (label: string, key: keyof MeshSpec, step = 'any') => (
    <NumField label={label} value={mesh[key] as number} step={step} onChange={v => setMesh(m => ({ ...m, [key]: v }))} />
  );

  // ── Panels shared by both flows ──────────────────────────────────────────
  const bounds = (
    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
      {field('x min', 'x0')}{field('x max', 'x1')}{field('y min', 'y0')}{field('y max', 'y1')}{field('z min', 'z0')}{field('z max', 'z1')}
    </div>
  );

  const cellsPanel = (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        {field('cells x', 'nx', '1')}{field('cells y', 'ny', '1')}
        <div className={mesh.twoD ? 'opacity-50 pointer-events-none' : ''}>{field('cells z', 'nz', '1')}</div>
      </div>
      {!snappy && (
        <div className="grid grid-cols-3 gap-2">
          {(['x', 'y', 'z'] as const).map((axis, i) => (
            <NumField key={axis} label={`grading ${axis}`} value={(mesh.grading ?? [1, 1, 1])[i]}
              title="Last cell size over first cell size along this axis (1 = uniform)"
              onChange={v => setMesh(m => { const g = [...(m.grading ?? [1, 1, 1])] as [number, number, number]; g[i] = v; return { ...m, grading: g }; })} />
          ))}
        </div>
      )}
      <Hint>
        {cells.toLocaleString()} {snappy ? 'background ' : ''}cells · cell size {h.map(fmt).join(' × ')}
        {h.every(v => v > 0) && ` · aspect ${fmt(Math.max(...h) / Math.min(...h))}`}
        {snappy ? ' — snappyHexMesh splits each cell into eight per level, so keep them cubic.' : ''}
      </Hint>
    </div>
  );

  // ── Geometry import (snappy) ─────────────────────────────────────────────
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);

  /** Background box, box patches, insidePoint and refinement box from the geometry. */
  const proposeFrom = (s: SnappySettings) => {
    const bbox = geometryBbox(s);
    if (!bbox) { toast.error('The geometry has no bounding box to propose from.'); return; }
    const next: MeshSpec = {
      ...mesh, ...proposeBackground(bbox, s.flow), twoD: false, scale: 1,
      patches: s.flow === 'internal' ? internalBackgroundPatches() : (mesh.patches && !mesh.patches.some(x => x.name === 'background') ? mesh.patches : defaultBoxPatches(false)),
    };
    setMesh(() => next);
    const minLevel = Math.min(...s.surfaces.map(x => x.minLevel));
    setSnappy(cur => ({
      ...cur,
      insidePoint: proposeInsidePoint(next, bbox, cur.flow, p.isInsideBody),
      refinementRegions: cur.refinementRegions.length || cur.flow === 'internal'
        ? cur.refinementRegions
        : [],
      layers: { ...cur.layers, patches: cur.layers.patches.length ? cur.layers.patches : cur.surfaces.map(x => x.name) },
    }));
    void minLevel;
  };

  const importFile = async (file: File) => {
    if (!snappy) return;
    if (!geometryKind(file.name)) {
      toast.error('Only STL (.stl, .stlb) and OBJ (.obj) files can be imported, optionally gzip-compressed (.gz).');
      return;
    }
    if (file.size > GEOMETRY_MAX_BYTES) {
      toast.error(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${GEOMETRY_MAX_BYTES / 1048576} MB. Compress it with gzip.`);
      return;
    }
    setImporting(true);
    try {
      const raw = new Uint8Array(await file.arrayBuffer());
      const parsed = await readGeometry(file.name, raw);
      const name = surfaceNameFromFile(file.name, [...snappy.surfaces.map(x => x.name), ...snappy.refinementRegions.map(r => r.name)]);
      let target = geometryFileName(name, file.name).replace(/\.gz$/i, '');
      if (isGzip(raw)) target += '.gz';
      if (snappy.surfaces.some(x => x.file === target)) { toast.error(`A surface already uses ${target}.`); return; }
      const L = Math.max(...[0, 1, 2].map(a => parsed.bbox.max[a] - parsed.bbox.min[a]));
      const surface: SnappySurface = {
        name, file: target, units: 'm', ...DEFAULT_SURFACE_LEVELS, role: 'wall',
        regionNames: parsed.regions, regions: [],
        bbox: parsed.bbox, triangles: parsed.triangleCount,
        regionCount: Math.max(1, parsed.regions.length), bytes: raw.length,
      };
      p.setGeometry(g => ({ ...g, [target]: { upload: raw, parsed } }));
      const next = { ...snappy, surfaces: [...snappy.surfaces, surface] };
      setSnappy(s => ({ ...s, surfaces: [...s.surfaces, surface] }));
      if (snappy.surfaces.length === 0) proposeFrom(next);
      toast.success(`${file.name}: ${parsed.triangleCount.toLocaleString()} triangles, ${surface.regionCount} region${surface.regionCount === 1 ? '' : 's'}`);
      if (L > 50) toast.info(`${name} is ${fmt(L)} units across. If it was drawn in millimetres, set its units so it is scaled to metres.`);
    } catch (e) {
      toast.error(`Could not read ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const updateSurface = (i: number, u: Partial<SnappySurface>) =>
    setSnappy(s => ({ ...s, surfaces: s.surfaces.map((x, j) => (j === i ? { ...x, ...u } : x)) }));

  const removeSurface = (i: number) => {
    const s = snappy!.surfaces[i];
    setSnappy(cur => ({
      ...cur,
      surfaces: cur.surfaces.filter((_, j) => j !== i),
      layers: { ...cur.layers, patches: cur.layers.patches.filter(n => n !== s.name) },
    }));
    p.setGeometry(g => { const n = { ...g }; delete n[s.file]; return n; });
  };

  const setFlow = (flow: FlowSide) => {
    if (!snappy || flow === snappy.flow) return;
    const next = { ...snappy, flow };
    setSnappy(s => ({ ...s, flow }));
    if (snappy.surfaces.length) proposeFrom(next);
    else setMesh(m => ({ ...m, patches: flow === 'internal' ? internalBackgroundPatches() : defaultBoxPatches(false) }));
  };

  const updateRegion = (i: number, r: RefinementRegion) =>
    setSnappy(s => ({ ...s, refinementRegions: s.refinementRegions.map((x, j) => (j === i ? r : x)) }));

  // ── Rendering ────────────────────────────────────────────────────────────
  const renderPanel = () => {
    if (!snappy) {
      switch (current) {
        case 'domain':
          return (
            <div className="space-y-3">
              {bounds}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
                {field('scale', 'scale')}
                <div className="flex gap-1">
                  {[['m', 1], ['mm', 0.001]].map(([l, v]) => (
                    <Button key={l} size="sm" variant={mesh.scale === v ? 'default' : 'outline'} className="h-8 text-xs"
                      onClick={() => setMesh(m => ({ ...m, scale: v as number }))}>{l}</Button>
                  ))}
                </div>
                <label className="flex items-center gap-2 cursor-pointer h-8 col-span-2">
                  <Checkbox checked={mesh.twoD} onCheckedChange={v => setMesh(m => ({ ...m, twoD: v === true }))} />
                  <span className="text-sm">2D case</span>
                </label>
              </div>
              <Hint>
                blockMesh multiplies every vertex by <span className="font-mono">scale</span>: with 0.001 the bounds above are millimetres.
                {mesh.twoD ? ' A 2D case has one cell across z; the ±z faces become the empty frontAndBack patch.' : ''}
              </Hint>
            </div>
          );
        case 'cells': return cellsPanel;
        case 'patches': return <BoxPatchEditor mesh={mesh} setMesh={setMesh} roles={p.roles} />;
        default: return dictEditor('blockMesh');
      }
    }

    switch (current) {
      case 'geometry':
        return (
          <div className="space-y-3">
            <div>
              <Label className="text-sm">Where is the fluid?</Label>
              <div className="mt-1">
                <Choice value={snappy.flow} onChange={setFlow} options={[
                  { v: 'external', label: 'Around the geometry', desc: 'External flow: a body in a stream (car, wing, building)' },
                  { v: 'internal', label: 'Inside the geometry', desc: 'Internal flow: the surface encloses the fluid (pipe, manifold, vessel)' },
                ]} />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <Label className="text-sm">Surfaces <span className="text-muted-foreground font-normal">→ constant/geometry</span></Label>
              <input ref={fileInput} type="file" accept=".stl,.stlb,.obj,.gz" className="hidden" aria-label="Geometry file"
                onChange={e => { const f = e.target.files?.[0]; if (f) void importFile(f); }} />
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={importing} onClick={() => fileInput.current?.click()}>
                {importing ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Upload className="w-3 h-3 mr-1" />} Import STL / OBJ…
              </Button>
            </div>
            <Hint>
              ASCII or binary STL, or OBJ, optionally gzip-compressed, up to {GEOMETRY_MAX_BYTES / 1048576} MB. Read here to size the
              domain and check insidePoint, then copied unchanged into the case. A file in other units is scaled to metres by
              surfaceTransformPoints before anything else runs.
            </Hint>
            {snappy.surfaces.length === 0 && <div className="text-center text-xs text-muted-foreground py-4">No geometry yet.</div>}
            {snappy.surfaces.map((s, i) => {
              const loaded = p.geometry[s.file];
              const bb = effectiveBbox(s);
              return (
                <div key={s.file} className="rounded-md bg-muted/30 p-2 space-y-1.5">
                  <div className="grid grid-cols-2 sm:grid-cols-[1.3fr_1fr_1.3fr_auto] gap-2 items-end">
                    <div>
                      <Label className="text-[11px]">Surface name</Label>
                      <Input value={s.name} onChange={e => updateSurface(i, { name: e.target.value.replace(/\s/g, '') })}
                        className="font-mono text-xs h-8 mt-0.5" aria-label="Surface name" />
                    </div>
                    <div>
                      <Label className="text-[11px]">Drawn in</Label>
                      <Select value={s.units} onValueChange={v => updateSurface(i, { units: v as LengthUnit })}>
                        <SelectTrigger className="h-8 text-xs mt-0.5"><SelectValue /></SelectTrigger>
                        <SelectContent>{UNITS.map(u => <SelectItem key={u.v} value={u.v} className="text-xs">{u.label}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-[11px]">Its patches are</Label>
                      <Select value={s.role} onValueChange={v => updateSurface(i, { role: v as PatchRole })}>
                        <SelectTrigger className="h-8 text-xs mt-0.5"><SelectValue /></SelectTrigger>
                        <SelectContent>{p.roles.map(r => <SelectItem key={r} value={r} className="text-xs">{ROLE_INFO[r].label}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-red-500" onClick={() => removeSurface(i)} aria-label={`Remove surface ${s.name}`}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 font-mono">
                    <span>{s.file}{s.units !== 'm' ? ` → ${dictFile(s)} (×${UNIT_SCALE[s.units]})` : ''}</span>
                    <span>{s.triangles.toLocaleString()} triangles</span>
                    <span>{s.regionCount} region{s.regionCount === 1 ? '' : 's'}{s.regionNames.length ? `: ${s.regionNames.slice(0, 6).join(', ')}${s.regionNames.length > 6 ? '…' : ''}` : ''}</span>
                    {bb && <span>{bb.min.map(fmt).join(' ')} → {bb.max.map(fmt).join(' ')} m</span>}
                    <span className="font-sans">group <span className="font-mono">{surfaceGroupName(s.name)}</span></span>
                    {loaded?.upload && <Badge variant="secondary" className="text-[10px]">copied into the case on Create / Update</Badge>}
                    {loaded && !loaded.parsed && !loaded.error && <span className="font-sans"><Loader2 className="w-3 h-3 inline animate-spin" /> reading from the case…</span>}
                    {loaded?.error && <span className="font-sans text-amber-600">{loaded.error}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        );

      case 'features':
        return (
          <div className="space-y-3">
            <Hint>
              surfaceFeatures extracts the sharp edges of each surface into constant/geometry/&lt;name&gt;.eMesh; snappyHexMesh then refines
              along them and snaps the mesh onto them. It runs before the background mesh. A surface with feature level 0 is left out.
            </Hint>
            {snappy.surfaces.map((s, i) => (
              <div key={s.file} className="grid grid-cols-[1fr_auto_8rem] gap-2 items-end rounded-md bg-muted/30 p-2">
                <div className="text-xs font-mono self-center">{s.name}</div>
                <label className="flex items-center gap-2 h-8 text-xs cursor-pointer">
                  <Checkbox checked={s.featureLevel > 0} onCheckedChange={v => updateSurface(i, { featureLevel: v === true ? Math.max(1, s.maxLevel) : 0 })} />
                  Extract edges
                </label>
                <NumField label="Refinement level at edges" value={s.featureLevel} step="1" min={0} max={10} disabled={s.featureLevel === 0}
                  onChange={v => updateSurface(i, { featureLevel: v })} />
              </div>
            ))}
            <div className="w-56">
              <NumField label="includedAngle [°]" value={snappy.includedAngle}
                title="Edges whose faces meet at less than this angle are features (0 none, 180 all)"
                onChange={v => setSnappy(s => ({ ...s, includedAngle: v }))} />
            </div>
            {dictEditor('features')}
          </div>
        );

      case 'background':
        return (
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!geometryBbox(snappy)} onClick={() => proposeFrom(snappy)}
                title={snappy.flow === 'internal' ? 'A small margin around the geometry, cells of 1/20 its size' : 'One body length upstream, three downstream, one on each side; cubic cells of 1/8 the body length'}>
                <Wand2 className="w-3 h-3 mr-1" /> Propose from the geometry
              </Button>
              {geometryBbox(snappy) && <Hint>geometry {geometryBbox(snappy)!.min.map(fmt).join(' ')} → {geometryBbox(snappy)!.max.map(fmt).join(' ')} m</Hint>}
            </div>
            {bounds}
            {cellsPanel}
            <Separator />
            {snappy.flow === 'internal' ? (
              <Hint>
                Internal flow: everything outside the geometry is discarded, so the box&apos;s faces vanish; they form one
                <span className="font-mono"> background</span> patch the 0/ files still list. The fluid&apos;s boundaries are the
                surface&apos;s regions (Refinement).
              </Hint>
            ) : (
              <>
                <Label className="text-sm">Patches of the box</Label>
                <BoxPatchEditor mesh={mesh} setMesh={setMesh} roles={p.roles} />
              </>
            )}
          </div>
        );

      case 'refine':
        return (
          <div className="space-y-3">
            {snappy.surfaces.map((s, i) => (
              <div key={s.file} className="rounded-md border p-2 space-y-2">
                <div className="grid grid-cols-[1fr_7rem_7rem] gap-2 items-end">
                  <div className="text-xs font-mono self-center">{s.name}</div>
                  <NumField label="Level min" value={s.minLevel} step="1" min={0} max={10} onChange={v => updateSurface(i, { minLevel: v })}
                    title="Level everywhere on the surface: each level halves the background cell size" />
                  <NumField label="Level max" value={s.maxLevel} step="1" min={0} max={10} onChange={v => updateSurface(i, { maxLevel: v })}
                    title="Level reached where the surface curves more sharply than resolveFeatureAngle" />
                </div>
                {s.regionNames.length > 0 && (
                  <div className="space-y-1">
                    <Hint>Regions: give a region its own patch group to set its own conditions (an inlet, an outlet) or level.</Hint>
                    {s.regionNames.map(rn => {
                      const r = s.regions.find(x => x.region === rn);
                      const setR = (u: Partial<typeof r> | null) => updateSurface(i, {
                        regions: u === null ? s.regions.filter(x => x.region !== rn)
                          : r ? s.regions.map(x => (x.region === rn ? { ...x, ...u } : x))
                            : [...s.regions, { region: rn, group: rn.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]/, 'r_'), role: 'wall', type: 'wall', minLevel: null, maxLevel: null, ...u }],
                      });
                      return (
                        <div key={rn} className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr_1.3fr_0.8fr_4.5rem_4.5rem] gap-1.5 items-center text-xs">
                          <span className="font-mono truncate" title={rn}>{rn}</span>
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <Checkbox checked={!!r} onCheckedChange={v => setR(v === true ? {} : null)} /> own patch
                          </label>
                          {r ? (
                            <>
                              <Input value={r.group} onChange={e => setR({ group: e.target.value.replace(/\s/g, '') })} className="h-7 text-xs font-mono" aria-label="Patch group" />
                              <Select value={r.role} onValueChange={v => setR({ role: v as PatchRole, type: ROLE_INFO[v as PatchRole].type === 'wall' ? 'wall' : 'patch' })}>
                                <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent>{p.roles.map(x => <SelectItem key={x} value={x} className="text-xs">{ROLE_INFO[x].label}</SelectItem>)}</SelectContent>
                              </Select>
                              <Select value={r.type} onValueChange={v => setR({ type: v as 'patch' | 'wall' })}>
                                <SelectTrigger className="h-7 text-xs font-mono"><SelectValue /></SelectTrigger>
                                <SelectContent>{['patch', 'wall'].map(x => <SelectItem key={x} value={x} className="text-xs font-mono">{x}</SelectItem>)}</SelectContent>
                              </Select>
                              <Input type="number" placeholder={String(s.minLevel)} value={r.minLevel ?? ''} aria-label="Region level min"
                                onChange={e => setR({ minLevel: e.target.value === '' ? null : Number(e.target.value) })} className="h-7 text-xs font-mono" />
                              <Input type="number" placeholder={String(s.maxLevel)} value={r.maxLevel ?? ''} aria-label="Region level max"
                                onChange={e => setR({ maxLevel: e.target.value === '' ? null : Number(e.target.value) })} className="h-7 text-xs font-mono" />
                            </>
                          ) : <span className="text-muted-foreground lg:col-span-5">in {surfaceGroupName(s.name)}</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm">Refinement regions</Label>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!geometryBbox(snappy)}
                    onClick={() => setSnappy(s => ({ ...s, refinementRegions: [...s.refinementRegions, proposeRefinementBox(geometryBbox(s)!, Math.min(...s.surfaces.map(x => x.minLevel)), uniqueName(s, 'refinementBox'))] }))}>
                    <Wand2 className="w-3 h-3 mr-1" /> Box around the body and wake
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs"
                    onClick={() => setSnappy(s => ({ ...s, refinementRegions: [...s.refinementRegions, newRefinementRegion(uniqueName(s, 'region'), geometryBbox(s))] }))}>
                    <Plus className="w-3 h-3 mr-1" /> Add
                  </Button>
                </div>
              </div>
              {snappy.refinementRegions.map((r, i) => (
                <div key={i} className="rounded-md bg-muted/30 p-2 space-y-1.5">
                  <div className="grid grid-cols-2 sm:grid-cols-[1fr_1fr_1fr_5rem_auto] gap-2 items-end">
                    <div><Label className="text-[11px]">Name</Label>
                      <Input value={r.name} onChange={e => updateRegion(i, { ...r, name: e.target.value.replace(/\s/g, '') })} className="h-8 text-xs font-mono mt-0.5" /></div>
                    <div><Label className="text-[11px]">Shape</Label>
                      <Select value={r.shape} onValueChange={v => updateRegion(i, { ...r, shape: v as RefinementRegion['shape'] })}>
                        <SelectTrigger className="h-8 text-xs mt-0.5"><SelectValue /></SelectTrigger>
                        <SelectContent>{['box', 'sphere', 'cylinder'].map(x => <SelectItem key={x} value={x} className="text-xs">{x}</SelectItem>)}</SelectContent>
                      </Select></div>
                    <div><Label className="text-[11px]">Refine cells</Label>
                      <Select value={r.mode} onValueChange={v => updateRegion(i, { ...r, mode: v as 'inside' | 'outside' })}>
                        <SelectTrigger className="h-8 text-xs mt-0.5"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="inside" className="text-xs">inside</SelectItem><SelectItem value="outside" className="text-xs">outside</SelectItem></SelectContent>
                      </Select></div>
                    <NumField label="Level" value={r.level} step="1" min={1} max={10} onChange={v => updateRegion(i, { ...r, level: v })} />
                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-red-500" aria-label={`Remove ${r.name}`}
                      onClick={() => setSnappy(s => ({ ...s, refinementRegions: s.refinementRegions.filter((_, j) => j !== i) }))}><Trash2 className="w-3.5 h-3.5" /></Button>
                  </div>
                  {r.shape === 'box' && <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <Vec3Field label="min" value={r.min} onChange={v => updateRegion(i, { ...r, min: v })} />
                    <Vec3Field label="max" value={r.max} onChange={v => updateRegion(i, { ...r, max: v })} /></div>}
                  {r.shape === 'sphere' && <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-2">
                    <Vec3Field label="centre" value={r.centre} onChange={v => updateRegion(i, { ...r, centre: v })} />
                    <NumField label="radius" value={r.radius} onChange={v => updateRegion(i, { ...r, radius: v })} /></div>}
                  {r.shape === 'cylinder' && <div className="grid grid-cols-1 md:grid-cols-[2fr_2fr_1fr] gap-2">
                    <Vec3Field label="axis point 1" value={r.point1} onChange={v => updateRegion(i, { ...r, point1: v })} />
                    <Vec3Field label="axis point 2" value={r.point2} onChange={v => updateRegion(i, { ...r, point2: v })} />
                    <NumField label="radius" value={r.radius} onChange={v => updateRegion(i, { ...r, radius: v })} /></div>}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-2">
              <InheritField label="nCellsBetweenLevels" integer value={snappy.castellated.nCellsBetweenLevels} inherited={CFG_DEFAULTS.castellated.nCellsBetweenLevels}
                title="Buffer layers of cells between refinement levels" onChange={v => setSnappy(s => ({ ...s, castellated: { ...s.castellated, nCellsBetweenLevels: v } }))} />
              <InheritField label="resolveFeatureAngle [°]" value={snappy.castellated.resolveFeatureAngle} inherited={CFG_DEFAULTS.castellated.resolveFeatureAngle}
                title="Where the surface bends more than this within a cell, the max level is used" onChange={v => setSnappy(s => ({ ...s, castellated: { ...s.castellated, resolveFeatureAngle: v } }))} />
              <InheritField label="maxGlobalCells" integer value={snappy.castellated.maxGlobalCells} inherited={CFG_DEFAULTS.castellated.maxGlobalCells}
                title="Refinement stops once the mesh reaches this many cells" onChange={v => setSnappy(s => ({ ...s, castellated: { ...s.castellated, maxGlobalCells: v } }))} />
            </div>
          </div>
        );

      case 'inside':
        return (
          <div className="space-y-2">
            <Hint>
              snappyHexMesh keeps the connected region of cells containing this point and discards the rest. It must be in the
              fluid: {snappy.flow === 'internal' ? 'inside the geometry, for this internal flow' : 'outside the body, inside the background box'}.
            </Hint>
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2 items-end">
              <Vec3Field label="insidePoint" value={snappy.insidePoint} onChange={v => setSnappy(s => ({ ...s, insidePoint: v }))} />
              <Button size="sm" variant="outline" className="h-8 text-xs"
                onClick={() => setSnappy(s => ({ ...s, insidePoint: proposeInsidePoint(mesh, geometryBbox(s), s.flow, p.isInsideBody) }))}>
                <Wand2 className="w-3 h-3 mr-1" /> Propose
              </Button>
            </div>
            <p className={`text-xs flex items-start gap-1 ${p.insideCheck.tone === 'ok' ? 'text-emerald-600' : p.insideCheck.tone === 'bad' ? 'text-amber-600' : 'text-muted-foreground'}`}>
              {p.insideCheck.tone === 'ok' ? <CheckCircle2 className="w-3.5 h-3.5 mt-px flex-shrink-0" />
                : p.insideCheck.tone === 'bad' ? <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
                  : <Info className="w-3.5 h-3.5 mt-px flex-shrink-0" />}
              {p.insideCheck.message}
            </p>
          </div>
        );

      case 'snap': {
        const sn = snappy.snap;
        const setSn = (u: Partial<SnappySettings['snap']>) => setSnappy(s => ({ ...s, snap: { ...s.snap, ...u } }));
        return (
          <div className="space-y-3">
            <label className="flex items-center gap-2 cursor-pointer w-fit">
              <Checkbox checked={sn.enabled} onCheckedChange={v => setSn({ enabled: v === true })} />
              <span className="text-sm">Snap the castellated mesh onto the surfaces</span>
            </label>
            <div>
              <Label className="text-[11px]">Feature edges</Label>
              <div className="mt-1"><Choice value={sn.featureSnap} onChange={v => setSn({ featureSnap: v })} disabled={!sn.enabled} options={[
                { v: 'auto', label: 'Automatic', desc: 'Explicit when surfaceFeatures extracted edges' },
                { v: 'explicit', label: 'Explicit', desc: 'Snap to the .eMesh edges' },
                { v: 'implicit', label: 'Implicit', desc: 'Detect edges from the surface itself' },
              ]} /></div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <InheritField label="nSmoothPatch" integer value={sn.nSmoothPatch} inherited={CFG_DEFAULTS.snap.nSmoothPatch} onChange={v => setSn({ nSmoothPatch: v })} />
              <InheritField label="tolerance" value={sn.tolerance} inherited={CFG_DEFAULTS.snap.tolerance} onChange={v => setSn({ tolerance: v })}
                title="How far, in local cell sizes, points are attracted to the surface" />
              <InheritField label="nSolveIter" integer value={sn.nSolveIter} inherited={CFG_DEFAULTS.snap.nSolveIter} onChange={v => setSn({ nSolveIter: v })} />
              <InheritField label="nRelaxIter" integer value={sn.nRelaxIter} inherited={CFG_DEFAULTS.snap.nRelaxIter} onChange={v => setSn({ nRelaxIter: v })} />
              <InheritField label="nFeatureSnapIter" integer value={sn.nFeatureSnapIter} inherited={CFG_DEFAULTS.snap.nFeatureSnapIter} onChange={v => setSn({ nFeatureSnapIter: v })} />
            </div>
          </div>
        );
      }

      case 'layers': {
        const ly = snappy.layers;
        const setLy = (u: Partial<SnappySettings['layers']>) => setSnappy(s => ({ ...s, layers: { ...s.layers, ...u } }));
        const candidates = [
          ...snappy.surfaces.map(x => x.name),
          ...(snappy.flow === 'external' ? meshPatches(mesh).filter(x => x.role === 'wall' || x.role === 'movingWall').map(x => x.name) : []),
        ];
        return (
          <div className="space-y-3">
            <label className="flex items-center gap-2 cursor-pointer w-fit">
              <Checkbox checked={ly.enabled} onCheckedChange={v => setLy({ enabled: v === true, patches: ly.patches.length ? ly.patches : snappy.surfaces.map(x => x.name) })} />
              <span className="text-sm">Add boundary layers (prismatic cells along walls)</span>
            </label>
            {ly.enabled && (
              <>
                <div className="flex flex-wrap gap-3">
                  {candidates.map(c => (
                    <label key={c} className="flex items-center gap-1.5 text-xs cursor-pointer font-mono">
                      <Checkbox checked={ly.patches.includes(c)} onCheckedChange={v => setLy({ patches: v === true ? [...ly.patches, c] : ly.patches.filter(x => x !== c) })} />
                      {c}
                    </label>
                  ))}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
                  <NumField label="Layers" value={ly.nSurfaceLayers} step="1" min={1} max={20} onChange={v => setLy({ nSurfaceLayers: v })} />
                  <NumField label="Expansion ratio" value={ly.expansionRatio} onChange={v => setLy({ expansionRatio: v })} />
                  <NumField label="Final layer thickness" value={ly.finalLayerThickness} onChange={v => setLy({ finalLayerThickness: v })}
                    title={ly.relativeSizes ? 'Relative to the local cell size' : 'In metres'} />
                  <NumField label="Minimum thickness" value={ly.minThickness} onChange={v => setLy({ minThickness: v })} />
                </div>
                <label className="flex items-center gap-2 cursor-pointer w-fit text-xs">
                  <Checkbox checked={ly.relativeSizes} onCheckedChange={v => setLy({ relativeSizes: v === true })} />
                  Thicknesses relative to the local cell size
                </label>
              </>
            )}
          </div>
        );
      }

      case 'quality': {
        const q = snappy.quality;
        const setQ = (u: Partial<SnappySettings['quality']>) => setSnappy(s => ({ ...s, quality: { ...s.quality, ...u } }));
        return (
          <div className="space-y-2">
            <Hint>
              snappyHexMesh undoes any snapping or layer move that would break these limits. Empty fields keep the
              installation&apos;s meshQualityDict.cfg; a value is written after its #includeEtc in system/meshQualityDict.
            </Hint>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <InheritField label="maxNonOrtho [°]" value={q.maxNonOrtho} inherited={CFG_DEFAULTS.quality.maxNonOrtho} onChange={v => setQ({ maxNonOrtho: v })} />
              <InheritField label="maxBoundarySkewness" value={q.maxBoundarySkewness} inherited={CFG_DEFAULTS.quality.maxBoundarySkewness} onChange={v => setQ({ maxBoundarySkewness: v })} />
              <InheritField label="maxInternalSkewness" value={q.maxInternalSkewness} inherited={CFG_DEFAULTS.quality.maxInternalSkewness} onChange={v => setQ({ maxInternalSkewness: v })} />
              <InheritField label="maxConcave [°]" value={q.maxConcave} inherited={CFG_DEFAULTS.quality.maxConcave} onChange={v => setQ({ maxConcave: v })} />
              <InheritField label="minDeterminant" value={q.minDeterminant} inherited={CFG_DEFAULTS.quality.minDeterminant} onChange={v => setQ({ minDeterminant: v })} />
            </div>
          </div>
        );
      }

      default:
        return (
          <div className="space-y-3">
            <div>
              <Label className="text-sm">The commands, in order</Label>
              <ol className="list-decimal pl-5 text-xs font-mono mt-1 space-y-0.5">
                {meshSteps(snappy).map(st => <li key={st.log}>{meshStepCommand(st)}</li>)}
              </ol>
              <Hint className="mt-1">Run them from the wizard once the case is created; each keeps its log.&lt;application&gt; in the case.</Hint>
            </div>
            <Tabs defaultValue="snappy">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="block" className="text-xs">blockMeshDict</TabsTrigger>
                <TabsTrigger value="features" className="text-xs">surfaceFeaturesDict</TabsTrigger>
                <TabsTrigger value="snappy" className="text-xs">snappyHexMeshDict</TabsTrigger>
                <TabsTrigger value="quality" className="text-xs">meshQualityDict</TabsTrigger>
              </TabsList>
              <TabsContent value="block">{dictEditor('blockMesh')}</TabsContent>
              <TabsContent value="features">{dictEditor('features')}</TabsContent>
              <TabsContent value="snappy">{dictEditor('snappy')}</TabsContent>
              <TabsContent value="quality"><pre className="text-[11px] font-mono bg-muted/30 rounded p-2 whitespace-pre-wrap">{p.qualityDict}</pre></TabsContent>
            </Tabs>
          </div>
        );
    }
  };

  /** A generated dictionary, editable by hand; editing freezes it until regenerated. */
  function dictEditor(which: 'blockMesh' | 'features' | 'snappy') {
    const conf = which === 'blockMesh'
      ? { path: 'system/blockMeshDict', text: p.blockMeshDict, override: p.meshOverride, set: p.setMeshOverride }
      : which === 'features'
        ? { path: 'system/surfaceFeaturesDict', text: p.featuresDict, override: snappy?.featuresOverride ?? null, set: (v: string | null) => setSnappy(s => ({ ...s, featuresOverride: v })) }
        : { path: 'system/snappyHexMeshDict', text: p.snappyDict, override: snappy?.snappyOverride ?? null, set: (v: string | null) => setSnappy(s => ({ ...s, snappyOverride: v })) };
    return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <Label className="text-xs font-mono">{conf.path} {conf.override !== null && <Badge variant="secondary" className="ml-1 text-[10px]">edited by hand</Badge>}</Label>
          <div className="flex gap-1">
            {conf.override !== null && (
              <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => conf.set(null)}>
                <RefreshCw className="w-3 h-3 mr-1" /> Regenerate from the form
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => p.onPreview(conf.text, conf.path)}><Eye className="w-3 h-3 mr-1" /> Preview</Button>
          </div>
        </div>
        <Textarea value={conf.text} onChange={e => conf.set(e.target.value)} className="font-mono text-xs min-h-[280px]" spellCheck={false} aria-label={conf.path} />
        {conf.override !== null && (
          <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> Hand-edited: the form no longer changes this file.
          </p>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Grid3x3 className="w-5 h-5" /> Mesh</CardTitle>
        <CardDescription>
          {snappy
            ? 'A background box refined and cut around (or inside) the imported geometry, in the order the real workflow runs.'
            : 'A single-block box. Its patches — and, with a geometry, the surface groups — are what the boundary conditions are generated against.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {p.tier === 'full' && (
          <div>
            <Choice
              value={snappy ? 'snappy' : 'block'}
              onChange={v => (v === 'snappy' ? p.onEnableSnappy() : p.onDisableSnappy())}
              options={[
                { v: 'block', label: 'Box only (blockMesh)', desc: 'Domain, cells, grading and the patch of every face' },
                { v: 'snappy', label: 'Box + geometry (snappyHexMesh)', desc: 'Import STL/OBJ; surfaceFeatures, blockMesh and snappyHexMesh', disabled: !p.snappySupport?.available && !snappy },
              ]}
            />
            {p.snappySupport === null ? (
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Checking the installation for snappyHexMesh support…</p>
            ) : !p.snappySupport.available && (
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1"><Info className="w-3 h-3 flex-shrink-0" /> {p.snappySupport.reason}</p>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-[11rem_1fr] gap-4">
          <SubStepNav steps={steps} current={Math.min(sub, steps.length - 1)} onSelect={setSub} />
          <div className="min-w-0 space-y-3">
            {renderPanel()}
            {here.length > 0 && (
              <ul className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs list-disc pl-7 space-y-0.5">
                {here.map((x, i) => <li key={i}>{x}</li>)}
              </ul>
            )}
            <div className="flex justify-between">
              <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={sub === 0} onClick={() => setSub(s => s - 1)}>
                <ChevronLeft className="w-3 h-3 mr-1" /> {sub > 0 ? steps[sub - 1].title : ''}
              </Button>
              {sub < steps.length - 1 && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setSub(s => s + 1)}>
                  {steps[sub + 1].title} <ChevronRight className="w-3 h-3 ml-1" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function uniqueName(s: SnappySettings, base: string): string {
  const taken = new Set([...s.surfaces.map(x => x.name), ...s.refinementRegions.map(r => r.name)]);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}

/** The groups the 0/ files get from the surfaces, for the Fields step's note. */
export function surfaceGroupsNote(s: SnappySettings | null): string {
  return snappyPatches(s).map(x => x.name).join(', ');
}

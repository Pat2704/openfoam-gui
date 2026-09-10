'use client';

/**
 * The Mesh step's snappyHexMesh section: geometry import, refinement levels,
 * the refinement box, insidePoint, layers, and the two generated dictionaries
 * with the same hand-edit escape hatch the blockMeshDict has.
 *
 * The settings live in the wizard (they are part of what "Update case"
 * records); this component edits them. Geometry is read here, in the browser —
 * src/lib/geometry.ts — and handed back as bytes for the upload at Create.
 */

import React, { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import {
  Upload, Trash2, Wand2, RefreshCw, Eye, AlertTriangle, CheckCircle2, Info, Loader2,
} from 'lucide-react';
import {
  GEOMETRY_MAX_BYTES, geometryKind, isGzip, parseGeometry, unionBbox,
  type ParsedGeometry, type Vec3,
} from '@/lib/geometry';
import {
  DEFAULT_SURFACE_LEVELS, geometryFileName, proposeBackground, proposeInsidePoint,
  proposeRefinementBox, surfaceGroupName, surfaceNameFromFile,
  type SnappySettings, type SnappySurface,
} from '@/lib/snappy-templates';
import type { MeshSpec } from '@/lib/case-templates';

export interface LoadedGeometry {
  /** Bytes to upload at Create/Update; null when the file is already in the case. */
  upload: Uint8Array | null;
  /** Null while it is still being read back from the case. */
  parsed: ParsedGeometry | null;
  error?: string;
}

export interface InsideCheck { tone: 'ok' | 'bad' | 'unknown'; message: string }

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Parse a geometry file as picked or as read back from the case, .gz or not. */
export async function readGeometry(name: string, raw: Uint8Array): Promise<ParsedGeometry> {
  const plain = isGzip(raw) ? await gunzip(raw) : raw;
  return parseGeometry(name.replace(/\.gz$/i, ''), plain);
}

function Vec3Field({ label, value, onChange }: { label: string; value: Vec3; onChange: (v: Vec3) => void }) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <div className="grid grid-cols-3 gap-1 mt-0.5">
        {(['x', 'y', 'z'] as const).map((axis, i) => (
          <Input
            key={axis} type="number" step="any" aria-label={`${label} ${axis}`} title={axis}
            value={String(value[i])}
            onChange={e => { const next = [...value] as Vec3; next[i] = Number(e.target.value); onChange(next); }}
            className="font-mono text-xs h-8"
          />
        ))}
      </div>
    </div>
  );
}

function IntField({ label, value, onChange, min = 0, max = 10, title }: {
  label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; title?: string;
}) {
  return (
    <div title={title}>
      <Label className="text-[11px]">{label}</Label>
      <Input
        type="number" step="1" min={min} max={max} value={String(value)}
        onChange={e => onChange(Number(e.target.value))}
        className="font-mono text-xs h-8 mt-0.5"
      />
    </div>
  );
}

export default function SnappySection({
  snappy, setSnappy, mesh, setMesh, geometry, setGeometry, insideCheck,
  snappyDict, featuresDict, onPreview,
}: {
  snappy: SnappySettings;
  setSnappy: (update: (s: SnappySettings) => SnappySettings) => void;
  mesh: MeshSpec;
  setMesh: (update: (m: MeshSpec) => MeshSpec) => void;
  geometry: Record<string, LoadedGeometry>;
  setGeometry: (update: (g: Record<string, LoadedGeometry>) => Record<string, LoadedGeometry>) => void;
  insideCheck: InsideCheck;
  snappyDict: string;
  featuresDict: string;
  onPreview: (content: string, name: string) => void;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);

  /** Background box, insidePoint and refinement box from the geometry. */
  const proposeFrom = (surfaces: SnappySurface[], keepBoxEnabled: boolean) => {
    const bbox = unionBbox(surfaces.map(s => s.bbox));
    if (!bbox) { toast.error('The geometry has no bounding box to propose from.'); return; }
    const next: MeshSpec = { ...mesh, ...proposeBackground(bbox), twoD: false, scale: 1 };
    setMesh(() => next);
    const minLevel = Math.min(...surfaces.map(s => s.minLevel));
    setSnappy(s => ({
      ...s,
      insidePoint: proposeInsidePoint(next, bbox),
      refinementBox: { ...proposeRefinementBox(bbox, minLevel), enabled: keepBoxEnabled ? s.refinementBox.enabled : false },
    }));
  };

  const importFile = async (file: File) => {
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
      const name = surfaceNameFromFile(file.name, snappy.surfaces.map(s => s.name));
      // The name on disk says whether it is compressed, and the bytes decide.
      let target = geometryFileName(name, file.name).replace(/\.gz$/i, '');
      if (isGzip(raw)) target += '.gz';
      if (snappy.surfaces.some(s => s.file === target)) {
        toast.error(`A surface already uses ${target}.`);
        return;
      }
      const surface: SnappySurface = {
        name, file: target, ...DEFAULT_SURFACE_LEVELS,
        bbox: parsed.bbox, triangles: parsed.triangleCount,
        regions: Math.max(1, parsed.regions.length), bytes: raw.length,
      };
      setGeometry(g => ({ ...g, [target]: { upload: raw, parsed } }));
      const surfaces = [...snappy.surfaces, surface];
      setSnappy(s => ({ ...s, surfaces: [...s.surfaces, surface] }));
      // The first geometry decides the domain; later ones leave the user's box alone.
      if (snappy.surfaces.length === 0) proposeFrom(surfaces, false);
      toast.success(`${file.name}: ${parsed.triangleCount.toLocaleString()} triangles, ${surface.regions} region${surface.regions === 1 ? '' : 's'}`);
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
    const file = snappy.surfaces[i]?.file;
    setSnappy(s => ({ ...s, surfaces: s.surfaces.filter((_, j) => j !== i) }));
    if (file) setGeometry(g => { const n = { ...g }; delete n[file]; return n; });
  };

  const bbox = unionBbox(snappy.surfaces.map(s => s.bbox));
  const box = snappy.refinementBox;

  return (
    <div className="space-y-3">
      {/* Geometry */}
      <div className="rounded-md border p-3 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <Label className="text-sm">Geometry <span className="text-muted-foreground font-normal">→ constant/geometry</span></Label>
          <div className="flex gap-1">
            <input
              ref={fileInput} type="file" accept=".stl,.stlb,.obj,.gz" className="hidden"
              aria-label="Geometry file"
              onChange={e => { const f = e.target.files?.[0]; if (f) void importFile(f); }}
            />
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={importing} onClick={() => fileInput.current?.click()}>
              {importing ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Upload className="w-3 h-3 mr-1" />}
              Import STL / OBJ…
            </Button>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          ASCII or binary STL, or OBJ, optionally gzip-compressed, up to {GEOMETRY_MAX_BYTES / 1048576} MB. The file is
          read here to size the domain and check insidePoint, and copied unchanged into the case when you create it.
        </p>

        {snappy.surfaces.length === 0 ? (
          <div className="text-center text-xs text-muted-foreground py-4">No geometry yet.</div>
        ) : snappy.surfaces.map((s, i) => {
          const loaded = geometry[s.file];
          return (
            <div key={s.file} className="rounded-md bg-muted/30 p-2 space-y-1.5">
              <div className="grid grid-cols-2 sm:grid-cols-[1.4fr_repeat(3,0.7fr)_auto] gap-2 items-end">
                <div>
                  <Label className="text-[11px]">Surface name</Label>
                  <Input
                    value={s.name} onChange={e => updateSurface(i, { name: e.target.value.replace(/\s/g, '') })}
                    className="font-mono text-xs h-8 mt-0.5" aria-label="Surface name"
                  />
                </div>
                <IntField label="Level min" value={s.minLevel} onChange={v => updateSurface(i, { minLevel: v })}
                  title="Refinement level everywhere on the surface: each level halves the background cell size" />
                <IntField label="Level max" value={s.maxLevel} onChange={v => updateSurface(i, { maxLevel: v })}
                  title="Level reached where the surface curves more sharply than resolveFeatureAngle" />
                <IntField label="Feature level" value={s.featureLevel} onChange={v => updateSurface(i, { featureLevel: v })}
                  title="Level at the sharp edges surfaceFeatures extracts; 0 leaves them out" />
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-red-500" onClick={() => removeSurface(i)}
                  aria-label={`Remove surface ${s.name}`} title="Remove this surface">
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
              <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 font-mono">
                <span>{s.file}</span>
                <span>{s.triangles.toLocaleString()} triangles</span>
                <span>{s.regions} region{s.regions === 1 ? '' : 's'}</span>
                <span className="font-sans">patches grouped as <span className="font-mono">{surfaceGroupName(s.name)}</span></span>
                {loaded?.upload && <Badge variant="secondary" className="text-[10px]">new: copied into the case on Create / Update</Badge>}
                {loaded && !loaded.parsed && !loaded.error && <span className="font-sans"><Loader2 className="w-3 h-3 inline animate-spin" /> reading from the case…</span>}
                {loaded?.error && <span className="font-sans text-amber-600">{loaded.error}</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Domain */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!bbox}
          onClick={() => proposeFrom(snappy.surfaces, true)}
          title="Box: one body length upstream, three downstream, one on each side; cubic cells of 1/8 the body length">
          <Wand2 className="w-3 h-3 mr-1" /> Propose the background box from the geometry
        </Button>
        {bbox && (
          <span className="text-[11px] text-muted-foreground font-mono">
            geometry ({bbox.min.map(v => Number(v.toPrecision(4))).join(' ')}) → ({bbox.max.map(v => Number(v.toPrecision(4))).join(' ')})
          </span>
        )}
      </div>

      <Separator />

      {/* insidePoint */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2 items-end">
        <Vec3Field label="insidePoint (a point in the fluid)" value={snappy.insidePoint}
          onChange={v => setSnappy(s => ({ ...s, insidePoint: v }))} />
        <Button size="sm" variant="outline" className="h-8 text-xs"
          onClick={() => setSnappy(s => ({ ...s, insidePoint: proposeInsidePoint(mesh, bbox) }))}>
          <Wand2 className="w-3 h-3 mr-1" /> Propose
        </Button>
      </div>
      <p className={`text-xs flex items-start gap-1 ${insideCheck.tone === 'ok' ? 'text-emerald-600' : insideCheck.tone === 'bad' ? 'text-amber-600' : 'text-muted-foreground'}`}>
        {insideCheck.tone === 'ok' ? <CheckCircle2 className="w-3.5 h-3.5 mt-px flex-shrink-0" />
          : insideCheck.tone === 'bad' ? <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
            : <Info className="w-3.5 h-3.5 mt-px flex-shrink-0" />}
        {insideCheck.message}
      </p>

      <Separator />

      {/* Refinement box, layers, features */}
      <div className="space-y-2">
        <label className="flex items-center gap-2 cursor-pointer w-fit">
          <Checkbox checked={box.enabled} onCheckedChange={v => setSnappy(s => ({ ...s, refinementBox: { ...s.refinementBox, enabled: v === true } }))} />
          <span className="text-sm">Refinement box</span>
          <span className="text-[11px] text-muted-foreground">finer cells in a region, typically around the body and its wake</span>
        </label>
        {box.enabled && (
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_0.4fr_auto] gap-2 items-end">
            <Vec3Field label="min" value={box.min} onChange={v => setSnappy(s => ({ ...s, refinementBox: { ...s.refinementBox, min: v } }))} />
            <Vec3Field label="max" value={box.max} onChange={v => setSnappy(s => ({ ...s, refinementBox: { ...s.refinementBox, max: v } }))} />
            <IntField label="Level" min={1} value={box.level} onChange={v => setSnappy(s => ({ ...s, refinementBox: { ...s.refinementBox, level: v } }))} />
            <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!bbox}
              onClick={() => bbox && setSnappy(s => ({ ...s, refinementBox: proposeRefinementBox(bbox, Math.min(...s.surfaces.map(x => x.minLevel))) }))}>
              <Wand2 className="w-3 h-3 mr-1" /> Propose
            </Button>
          </div>
        )}

        <div className="flex items-end gap-4 flex-wrap">
          <label className="flex items-center gap-2 cursor-pointer h-8">
            <Checkbox checked={snappy.addLayers} onCheckedChange={v => setSnappy(s => ({ ...s, addLayers: v === true }))} />
            <span className="text-sm">Boundary layers on the surfaces</span>
          </label>
          {snappy.addLayers && (
            <div className="w-28">
              <IntField label="Layers" min={1} max={20} value={snappy.nSurfaceLayers}
                onChange={v => setSnappy(s => ({ ...s, nSurfaceLayers: v }))} />
            </div>
          )}
          <div className="w-40" title="surfaceFeatures: edges whose faces meet at less than this angle are features">
            <Label className="text-[11px]">includedAngle [°]</Label>
            <Input type="number" step="any" value={String(snappy.includedAngle)}
              onChange={e => setSnappy(s => ({ ...s, includedAngle: Number(e.target.value) }))}
              className="font-mono text-xs h-8 mt-0.5" />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Everything else — snapping, layer controls, mesh quality — is the installation&apos;s own default from
          <span className="font-mono"> snappyHexMeshDict.cfg</span>, included by the dictionary below.
        </p>
      </div>

      <Separator />

      {/* The two dictionaries */}
      <Tabs defaultValue="snappy">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="snappy" className="text-xs">
            snappyHexMeshDict {snappy.snappyOverride !== null && <Badge variant="secondary" className="ml-1 text-[9px]">edited</Badge>}
          </TabsTrigger>
          <TabsTrigger value="features" className="text-xs">
            surfaceFeaturesDict {snappy.featuresOverride !== null && <Badge variant="secondary" className="ml-1 text-[9px]">edited</Badge>}
          </TabsTrigger>
        </TabsList>
        {([
          ['snappy', 'system/snappyHexMeshDict', snappyDict, snappy.snappyOverride, (v: string | null) => setSnappy(s => ({ ...s, snappyOverride: v }))],
          ['features', 'system/surfaceFeaturesDict', featuresDict, snappy.featuresOverride, (v: string | null) => setSnappy(s => ({ ...s, featuresOverride: v }))],
        ] as const).map(([key, path, text, override, set]) => (
          <TabsContent key={key} value={key}>
            <div className="flex justify-end gap-1 mb-1">
              {override !== null && (
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => set(null)}>
                  <RefreshCw className="w-3 h-3 mr-1" /> Regenerate from the form
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => onPreview(text, path)}>
                <Eye className="w-3 h-3 mr-1" /> Preview
              </Button>
            </div>
            <Textarea value={text} onChange={e => set(e.target.value)} className="font-mono text-xs min-h-[280px]" spellCheck={false} aria-label={path} />
            {override !== null && (
              <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> Hand-edited: the form above no longer changes this file.
              </p>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

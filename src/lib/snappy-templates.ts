/**
 * snappyHexMesh for the New Case wizard: the dictionaries, the proposals, the
 * checks and the order the meshing steps run in — kept out of the component for
 * the same reason as ./case-templates.ts, the interesting part is not the UI.
 *
 * What it writes is modelled on the Foundation v13 and v14 installations, not on
 * memory:
 *
 *   - The utility is `surfaceFeatures` reading `system/surfaceFeaturesDict`.
 *     `surfaceFeatureExtract` is the ESI name; on 13 and 14 it is only a script
 *     that prints "superseded by surfaceFeatures".
 *   - Every snappy tutorial names the fluid point `insidePoint` (never
 *     `locationInMesh`) and keeps its geometry in `constant/geometry`.
 *   - The installation ships `caseDicts/mesh/generation/snappyHexMeshDict.cfg`,
 *     `caseDicts/surface/surfaceFeaturesDict.cfg` and `meshQualityDict.cfg`; the
 *     generated dictionaries `#includeEtc` them and override only what the user
 *     chose. The snappy .cfg includes `${FOAM_CASE}/system/meshQualityDict`, so
 *     that file is written too.
 *   - Surface types are `triSurface`, `box`, `sphere`, `cylinder` (foamToC's
 *     searchableSurface table on 14; the v13 tutorials use the same names).
 *   - A geometry drawn in millimetres is scaled with `surfaceTransformPoints
 *     "scale=(0.001 0.001 0.001)"`, same syntax on 13 and 14.
 *   - Regions of a surface (STL solids, OBJ groups) become patches
 *     `<surface>_<region>`; `patchInfo` gives each its type and patch groups,
 *     which is how the inflowOutflow template maps CAD regions to inlet/outlet.
 *
 * The real workflow order, which is also the order of the wizard's mesh
 * sub-steps and of meshSteps(): geometry (and its units) → surfaceFeatures →
 * blockMesh background → snappyHexMesh (castellate, snap, layers) → checkMesh.
 *
 * Only offered on 13 and 14, where all of that was checked.
 */

import { header, type BoxPatch, type MeshPatch, type MeshSpec, type PatchRole } from './case-templates';
import { pointInBox, unionBbox, type Bbox, type Vec3 } from './geometry';

export const SNAPPY_VERSIONS: readonly number[] = [13, 14];

export const SNAPPY_UNAVAILABLE = 'Available on OpenFOAM 13 and 14 only';

export const SNAPPY_CFG = 'caseDicts/mesh/generation/snappyHexMeshDict.cfg';
export const SURFACE_FEATURES_CFG = 'caseDicts/surface/surfaceFeaturesDict.cfg';
export const MESH_QUALITY_CFG = 'caseDicts/mesh/generation/meshQualityDict.cfg';
/** The files the generated dictionaries include from the installation. */
export const SNAPPY_ETC_FILES = [SNAPPY_CFG, SURFACE_FEATURES_CFG, MESH_QUALITY_CFG];

export interface SnappyAvailability { available: boolean; reason: string | null }

/**
 * Whether the guided snappyHexMesh option may be offered.
 *
 * `missingEtc` lists the SNAPPY_ETC_FILES the installation does not provide;
 * null means that check could not run, which is not the same as passing it.
 */
export function snappyAvailability(major: number | null, missingEtc: string[] | null): SnappyAvailability {
  if (major === null || !Number.isFinite(major)) {
    return { available: false, reason: `${SNAPPY_UNAVAILABLE}; the OpenFOAM version could not be detected.` };
  }
  if (!SNAPPY_VERSIONS.includes(major)) {
    return { available: false, reason: `${SNAPPY_UNAVAILABLE}; the selected installation is OpenFOAM ${major}.` };
  }
  if (missingEtc === null) {
    return { available: false, reason: `The OpenFOAM ${major} installation could not be checked for the snappyHexMesh defaults.` };
  }
  if (missingEtc.length) {
    return { available: false, reason: `This OpenFOAM ${major} installation does not provide ${missingEtc.join(', ')}.` };
  }
  return { available: true, reason: null };
}

// ── Settings ────────────────────────────────────────────────────────────────

/** Where the fluid is: around the geometry (external) or inside it (internal). */
export type FlowSide = 'external' | 'internal';

export type LengthUnit = 'm' | 'mm' | 'cm' | 'in';
export const UNIT_SCALE: Record<LengthUnit, number> = { m: 1, mm: 0.001, cm: 0.01, in: 0.0254 };

/** A region of a surface given its own patch group, role, type and levels. */
export interface RegionPatch {
  region: string;
  /** The patch group the 0/ files address: `inlet`, `outlet`, `hotWall`… */
  group: string;
  role: PatchRole;
  type: 'patch' | 'wall';
  /** null: the surface's levels. */
  minLevel: number | null;
  maxLevel: number | null;
}

export interface SnappySurface {
  /** Geometry entry and patch prefix: an OpenFOAM word. */
  name: string;
  /** File in constant/geometry, e.g. `motorBike.obj.gz`. */
  file: string;
  /** The unit the file was drawn in; anything but metres is scaled first. */
  units: LengthUnit;
  minLevel: number;
  maxLevel: number;
  /** Refinement level at the feature edges surfaceFeatures extracts; 0 = none. */
  featureLevel: number;
  /** Role of the surface's own group (every region not reassigned below). */
  role: PatchRole;
  /** Region names found in the file, for the UI. */
  regionNames: string[];
  regions: RegionPatch[];
  /** From the import, in the FILE's units; see effectiveBbox. */
  bbox: Bbox | null;
  triangles: number;
  regionCount: number;
  bytes: number;
}

export type RefinementShape = 'box' | 'sphere' | 'cylinder';

export interface RefinementRegion {
  name: string;
  shape: RefinementShape;
  mode: 'inside' | 'outside';
  level: number;
  min: Vec3; max: Vec3;          // box
  centre: Vec3; radius: number;  // sphere; cylinder radius
  point1: Vec3; point2: Vec3;    // cylinder axis
}

export interface SnappySettings {
  flow: FlowSide;
  surfaces: SnappySurface[];
  refinementRegions: RefinementRegion[];
  /** A point in the fluid: snappyHexMesh keeps the region that contains it. */
  insidePoint: Vec3;
  /** surfaceFeatures: edges whose faces meet at less than this angle are features. */
  includedAngle: number;
  /** null everywhere below: the installation's .cfg value (CFG_DEFAULTS). */
  castellated: { nCellsBetweenLevels: number | null; resolveFeatureAngle: number | null; maxGlobalCells: number | null };
  snap: {
    enabled: boolean;
    /** auto: explicit when surfaceFeatures extracted edges, implicit otherwise. */
    featureSnap: 'auto' | 'explicit' | 'implicit';
    nSmoothPatch: number | null; tolerance: number | null; nSolveIter: number | null;
    nRelaxIter: number | null; nFeatureSnapIter: number | null;
  };
  layers: {
    enabled: boolean;
    /** Surface names and box patch names that get layers. */
    patches: string[];
    nSurfaceLayers: number;
    relativeSizes: boolean;
    expansionRatio: number;
    finalLayerThickness: number;
    minThickness: number;
  };
  quality: {
    maxNonOrtho: number | null; maxBoundarySkewness: number | null; maxInternalSkewness: number | null;
    maxConcave: number | null; minDeterminant: number | null;
  };
  /** Hand edits, as for the blockMeshDict: set, the form stops regenerating. */
  snappyOverride: string | null;
  featuresOverride: string | null;
}

/**
 * The values the installation's .cfg files give (identical on v13 and v14:
 * snappyHexMeshDict.cfg and meshQualityDict.cfg), shown next to each control
 * so "inherited" has a number. The layer entries are not in the .cfg; they are
 * the inflowOutflow template's.
 */
export const CFG_DEFAULTS = {
  castellated: { nCellsBetweenLevels: 3, resolveFeatureAngle: 30, maxGlobalCells: 100000000 },
  snap: { nSmoothPatch: 3, tolerance: 2, nSolveIter: 100, nRelaxIter: 5, nFeatureSnapIter: 10 },
  quality: { maxNonOrtho: 65, maxBoundarySkewness: 20, maxInternalSkewness: 4, maxConcave: 80, minDeterminant: 0.001 },
} as const;

export const DEFAULT_SNAPPY: SnappySettings = {
  flow: 'external',
  surfaces: [],
  refinementRegions: [],
  insidePoint: [0, 0, 0],
  includedAngle: 150,
  castellated: { nCellsBetweenLevels: null, resolveFeatureAngle: null, maxGlobalCells: null },
  snap: { enabled: true, featureSnap: 'auto', nSmoothPatch: null, tolerance: null, nSolveIter: null, nRelaxIter: null, nFeatureSnapIter: null },
  layers: { enabled: false, patches: [], nSurfaceLayers: 3, relativeSizes: true, expansionRatio: 1.2, finalLayerThickness: 0.5, minThickness: 0.1 },
  quality: { maxNonOrtho: null, maxBoundarySkewness: null, maxInternalSkewness: null, maxConcave: null, minDeterminant: null },
  snappyOverride: null,
  featuresOverride: null,
};

export const DEFAULT_SURFACE_LEVELS = { minLevel: 2, maxLevel: 3, featureLevel: 3 };

export function newRefinementRegion(name: string, bbox: Bbox | null, level = 1): RefinementRegion {
  const b = bbox ?? { min: [0, 0, 0] as Vec3, max: [1, 1, 1] as Vec3 };
  const centre = [0, 1, 2].map(a => (b.min[a] + b.max[a]) / 2) as Vec3;
  const r = Math.max(...[0, 1, 2].map(a => b.max[a] - b.min[a])) / 2 || 0.5;
  return {
    name, shape: 'box', mode: 'inside', level,
    min: [...b.min] as Vec3, max: [...b.max] as Vec3,
    centre, radius: r,
    point1: [b.min[0], centre[1], centre[2]], point2: [b.max[0], centre[1], centre[2]],
  };
}

// ── Names ───────────────────────────────────────────────────────────────────

const GEOMETRY_EXT = /\.(stl|stlb|obj)$/i;
const WORD = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A surface name from a file name: an OpenFOAM word, unique among `taken`. */
export function surfaceNameFromFile(fileName: string, taken: string[] = []): string {
  const base = fileName.split(/[\\/]/).pop() || '';
  const stem = base.replace(/\.gz$/i, '').replace(GEOMETRY_EXT, '');
  let name = stem.replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 48);
  if (!/^[A-Za-z]/.test(name)) name = name ? `surface_${name}` : 'surface';
  const used = new Set(taken);
  if (!used.has(name)) return name;
  for (let i = 2; ; i++) if (!used.has(`${name}_${i}`)) return `${name}_${i}`;
}

/** The name the file gets in constant/geometry: the surface name, same extension. */
export function geometryFileName(surfaceName: string, originalName: string): string {
  const lower = originalName.toLowerCase();
  const gz = lower.endsWith('.gz') ? '.gz' : '';
  const ext = lower.replace(/\.gz$/, '').match(GEOMETRY_EXT)?.[0] ?? '.stl';
  return `${surfaceName}${ext}${gz}`;
}

/** How dictionaries name the file: OpenFOAM finds `x.obj.gz` when asked for `x.obj`. */
export function referencedFile(file: string): string {
  return file.replace(/\.gz$/i, '');
}

/** The file the dictionaries use: the original, or the scaled copy for non-metre units. */
export function dictFile(s: Pick<SnappySurface, 'name' | 'file' | 'units'>): string {
  if (s.units === 'm') return referencedFile(s.file);
  const ext = referencedFile(s.file).match(GEOMETRY_EXT)?.[1]?.toLowerCase() === 'obj' ? 'obj' : 'stl';
  return `${s.name}_m.${ext}`;
}

/** The edge mesh surfaceFeatures writes next to the surface. */
export function featureFile(s: Pick<SnappySurface, 'name' | 'file' | 'units'>): string {
  return `${dictFile(s).replace(GEOMETRY_EXT, '')}.eMesh`;
}

export function geometryPath(file: string): string {
  return `constant/geometry/${file}`;
}

/** The bounding box in metres, after the unit scaling. */
export function effectiveBbox(s: Pick<SnappySurface, 'bbox' | 'units'>): Bbox | null {
  if (!s.bbox) return null;
  const k = UNIT_SCALE[s.units] ?? 1;
  return { min: s.bbox.min.map(v => v * k) as Vec3, max: s.bbox.max.map(v => v * k) as Vec3 };
}

export function geometryBbox(s: SnappySettings): Bbox | null {
  return unionBbox(s.surfaces.map(effectiveBbox));
}

/**
 * The patch group every patch cut from a surface is put in, unless its region
 * was reassigned. snappyHexMesh makes one patch per region
 * (`motorBike_frame:016-shadow%13`, 67 of them for motorBike) and the 0/ files
 * cannot list them in advance; the group is declared in `patchInfo`, so one
 * entry covers them all — and the Mesh tab's boundary check resolves groups.
 */
export function surfaceGroupName(surfaceName: string): string {
  return `${surfaceName}Group`;
}

/** The entries a snappy case needs in every 0/ file: one per group, with its role. */
export function snappyPatches(s: SnappySettings | null): MeshPatch[] {
  if (!s) return [];
  const out: MeshPatch[] = [];
  const add = (p: MeshPatch) => { if (!out.some(x => x.name === p.name)) out.push(p); };
  for (const x of s.surfaces) {
    const reassigned = new Set(x.regions.map(r => r.region));
    // Every region reassigned: the surface's own group has no patch left.
    if (!x.regionNames.length || x.regionNames.some(r => !reassigned.has(r))) {
      add({ name: surfaceGroupName(x.name), role: x.role, type: x.role === 'wall' || x.role === 'slipWall' || x.role === 'movingWall' ? 'wall' : 'patch' });
    }
    for (const r of x.regions) add({ name: r.group, role: r.role, type: r.type });
  }
  return out;
}

/** The background box's patches for an internal flow: snappy removes the box. */
export function internalBackgroundPatches(): BoxPatch[] {
  return [{ name: 'background', type: 'wall', role: 'wall', faces: ['xMin', 'xMax', 'yMin', 'yMax', 'zMin', 'zMax'] }];
}

// ── The meshing steps ───────────────────────────────────────────────────────

export interface MeshStep { app: string; args: string; log: string }

/** The commands that build the mesh, in the order a real workflow runs them. */
export function meshSteps(s: SnappySettings | null): MeshStep[] {
  const step = (app: string, args = '', log = app): MeshStep => ({ app, args, log });
  if (!s || s.surfaces.length === 0) return [step('blockMesh'), step('checkMesh')];
  const out: MeshStep[] = [];
  for (const x of s.surfaces) {
    if (x.units === 'm') continue;
    const k = num(UNIT_SCALE[x.units]);
    out.push(step('surfaceTransformPoints',
      `"scale=(${k} ${k} ${k})" ${geometryPath(x.file)} ${geometryPath(dictFile(x))}`,
      `surfaceTransformPoints.${x.name}`));
  }
  if (s.surfaces.some(x => x.featureLevel > 0)) out.push(step('surfaceFeatures'));
  out.push(step('blockMesh'), step('snappyHexMesh'), step('checkMesh'));
  return out;
}

export function meshStepCommand(st: MeshStep): string {
  return `${st.app}${st.args ? ` ${st.args}` : ''}`;
}

// ── Formatting ──────────────────────────────────────────────────────────────

function num(v: number): string {
  return String(Number(Number(v).toFixed(10)));
}

function vec(v: Vec3): string {
  return `(${v.map(num).join(' ')})`;
}

function intIn(v: number, lo: number, hi: number): boolean {
  return Number.isInteger(v) && v >= lo && v <= hi;
}

function overrides(entries: [string, number | boolean | null][], indent = '    '): string {
  return entries.filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${indent}${k.padEnd(20)}${typeof v === 'boolean' ? (v ? 'true' : 'false') : num(v as number)};\n`).join('');
}

// ── Dictionaries ────────────────────────────────────────────────────────────

export function generateSurfaceFeaturesDict(s: SnappySettings): string {
  const files = s.surfaces.filter(x => x.featureLevel > 0).map(x => `    "${dictFile(x)}"`).join('\n');
  return `${header('dictionary', 'surfaceFeaturesDict', 'system')}
// Everything not set here is the installation's default, from
// $FOAM_ETC/${SURFACE_FEATURES_CFG}
#includeEtc "${SURFACE_FEATURES_CFG}"

surfaces
(
${files}
);

// Edges whose faces meet at less than this angle are features
// (0 selects no edges, 180 all of them).
includedAngle   ${num(s.includedAngle)};
`;
}

export function generateMeshQualityDict(s: SnappySettings | null = null): string {
  const q = s?.quality;
  const extra = q ? overrides([
    ['maxNonOrtho', q.maxNonOrtho], ['maxBoundarySkewness', q.maxBoundarySkewness],
    ['maxInternalSkewness', q.maxInternalSkewness], ['maxConcave', q.maxConcave], ['minDeterminant', q.minDeterminant],
  ], '') : '';
  return `${header('dictionary', 'meshQualityDict', 'system')}
// Read by snappyHexMeshDict.cfg through \${FOAM_CASE}/system/meshQualityDict.
#includeEtc "${MESH_QUALITY_CFG}"
${extra ? `\n// Overrides of the installation's values\n${extra}` : ''}`;
}

function regionGeometry(r: RefinementRegion): string {
  switch (r.shape) {
    case 'sphere': return `        type sphere;\n        centre ${vec(r.centre)};\n        radius ${num(r.radius)};`;
    case 'cylinder': return `        type cylinder;\n        point1 ${vec(r.point1)};\n        point2 ${vec(r.point2)};\n        radius ${num(r.radius)};`;
    default: return `        type box;\n        min  ${vec(r.min)};\n        max  ${vec(r.max)};`;
  }
}

export function generateSnappyHexMeshDict(s: SnappySettings): string {
  const withFeatures = s.surfaces.filter(x => x.featureLevel > 0);
  const explicit = s.snap.featureSnap === 'explicit' || (s.snap.featureSnap === 'auto' && withFeatures.length > 0);

  const geometry = [
    ...s.surfaces.map(x => `    ${x.name}\n    {\n        type triSurface;\n        file "${dictFile(x)}";\n    }`),
    ...s.refinementRegions.map(r => `    ${r.name}\n    {\n${regionGeometry(r)}\n    }`),
  ].join('\n\n');

  const features = withFeatures
    .map(x => `        { file "${featureFile(x)}"; level ${x.featureLevel}; }`).join('\n');

  const patchInfo = (type: string, group: string, indent: string) =>
    `${indent}patchInfo\n${indent}{\n${indent}    type ${type};\n${indent}    inGroups (${group});\n${indent}}`;

  const surfaces = s.surfaces.map(x => {
    const own = snappyPatches({ ...s, surfaces: [x] }).find(p => p.name === surfaceGroupName(x.name));
    const regions = x.regions.map(r => `            ${r.region}
            {
                level (${r.minLevel ?? x.minLevel} ${r.maxLevel ?? x.maxLevel});
${patchInfo(r.type, r.group, '                ')}
            }`).join('\n');
    return `        ${x.name}
        {
            level (${x.minLevel} ${x.maxLevel});
${patchInfo(own?.type ?? 'wall', surfaceGroupName(x.name), '            ')}${regions ? `\n            regions\n            {\n${regions}\n            }` : ''}
        }`;
  }).join('\n\n');

  const regions = s.refinementRegions.map(r => `        ${r.name}\n        {\n            mode    ${r.mode};\n            level   ${r.level};\n        }`).join('\n\n');

  // The patches of one surface are `<name>` or `<name>_<region>`; this pattern
  // takes both without also catching a surface whose name merely starts the same.
  const surfaceNames = new Set(s.surfaces.map(x => x.name));
  const layers = s.layers.enabled ? s.layers.patches.map(p => `        "${surfaceNames.has(p) ? `${p}(_.*)?` : p}"
        {
            nSurfaceLayers ${s.layers.nSurfaceLayers};
        }`).join('\n\n') : '';

  const c = s.castellated;
  const sn = s.snap;
  return `${header('dictionary', 'snappyHexMeshDict', 'system')}
// Only the choices made in the wizard are written here. Everything else is the
// installation's default, from $FOAM_ETC/${SNAPPY_CFG}
// (entries below merge into its dictionaries).
#includeEtc "${SNAPPY_CFG}"

castellatedMesh true;
snap            ${sn.enabled ? 'true' : 'false'};
addLayers       ${s.layers.enabled ? 'true' : 'false'};

geometry
{
${geometry}
};

castellatedMeshControls
{
${overrides([['nCellsBetweenLevels', c.nCellsBetweenLevels], ['resolveFeatureAngle', c.resolveFeatureAngle], ['maxGlobalCells', c.maxGlobalCells]])}    features
    (
${features}
    );

    refinementSurfaces
    {
${surfaces}
    }

    refinementRegions
    {
${regions}
    }

    // ${s.flow === 'internal' ? 'Inside the geometry: the mesh is the volume the surface encloses.' : 'In the fluid around the geometry.'}
    insidePoint ${vec(s.insidePoint)};
}

snapControls
{
${overrides([['nSmoothPatch', sn.nSmoothPatch], ['tolerance', sn.tolerance], ['nSolveIter', sn.nSolveIter], ['nRelaxIter', sn.nRelaxIter], ['nFeatureSnapIter', sn.nFeatureSnapIter]])}    explicitFeatureSnap ${explicit ? 'true' : 'false'};
    implicitFeatureSnap ${explicit ? 'false' : 'true'};
}

addLayersControls
{
    layers
    {
${layers}
    }

    relativeSizes       ${s.layers.relativeSizes ? 'true' : 'false'};
    expansionRatio      ${num(s.layers.expansionRatio)};
    finalLayerThickness ${num(s.layers.finalLayerThickness)};
    minThickness        ${num(s.layers.minThickness)};
}
`;
}

// ── Proposals ───────────────────────────────────────────────────────────────

function roundSig(v: number, digits = 2): number {
  if (!Number.isFinite(v) || v === 0) return v;
  const p = Math.pow(10, digits - Math.ceil(Math.log10(Math.abs(v))));
  return Math.round(v * p) / p;
}

function tidy(v: number): number {
  return Number(v.toFixed(10));
}

type BoxBounds = Pick<MeshSpec, 'x0' | 'x1' | 'y0' | 'y1' | 'z0' | 'z1' | 'nx' | 'ny' | 'nz'>;

/**
 * A background box from the geometry's bounding box, snapped to whole cubic
 * cells (snappyHexMesh splits each cell into eight, so a stretched background
 * cell stays stretched at every level). With L the largest extent:
 *
 *   external  one L upstream (x min, where the inlet is), three downstream for
 *             the wake, one on every other side; cells of L/8.
 *   internal  a margin of L/20 around the geometry — everything outside it is
 *             discarded — and cells of L/20.
 */
export function proposeBackground(bbox: Bbox, flow: FlowSide = 'external'): BoxBounds {
  const size = [0, 1, 2].map(a => bbox.max[a] - bbox.min[a]);
  const L = Math.max(...size) || 1;
  const h = roundSig(flow === 'internal' ? L / 20 : L / 8);
  const before = flow === 'internal' ? [h, h, h] : [L, L, L];
  const after = flow === 'internal' ? [h, h, h] : [3 * L, L, L];
  const lo: number[] = [];
  const n: number[] = [];
  for (let a = 0; a < 3; a++) {
    const start = Math.floor((bbox.min[a] - before[a]) / h) * h;
    lo.push(tidy(start));
    n.push(Math.max(1, Math.ceil((bbox.max[a] + after[a] - start) / h)));
  }
  return {
    x0: lo[0], x1: tidy(lo[0] + n[0] * h),
    y0: lo[1], y1: tidy(lo[1] + n[1] * h),
    z0: lo[2], z1: tidy(lo[2] + n[2] * h),
    nx: n[0], ny: n[1], nz: n[2],
  };
}

function boxOf(m: Pick<MeshSpec, 'x0' | 'x1' | 'y0' | 'y1' | 'z0' | 'z1'>): Bbox {
  return { min: [m.x0, m.y0, m.z0], max: [m.x1, m.y1, m.z1] };
}

/**
 * A point in the fluid, off every cell centre and face so it cannot sit on a
 * face or edge once cells are split.
 *
 *   external  inside the first background cell of a box corner clear of the geometry;
 *   internal  a point the ray test places inside the geometry, found on a
 *             grid over its bounding box (`isInside` is that test; without it
 *             the bounding-box centre is the best guess).
 */
export function proposeInsidePoint(m: MeshSpec, geometry: Bbox | null, flow: FlowSide = 'external', isInside?: (p: Vec3) => boolean): Vec3 {
  if (flow === 'internal' && geometry) {
    const centre = [0, 1, 2].map(a => (geometry.min[a] + geometry.max[a]) / 2) as Vec3;
    if (!isInside) return centre.map(v => tidy(roundSig(v, 4))) as Vec3;
    // Candidates ordered from the centre outwards; the offsets are irrational
    // multiples so a candidate never lands on a symmetry plane of the part.
    const steps = 9;
    const cands: Vec3[] = [];
    for (let i = 0; i < steps; i++) for (let j = 0; j < steps; j++) for (let k = 0; k < steps; k++) {
      const f = (t: number, a: number) => geometry.min[a] + (geometry.max[a] - geometry.min[a]) * ((t + 0.5 + 0.0713 * (a + 1)) / (steps + 0.2));
      cands.push([f(i, 0), f(j, 1), f(k, 2)]);
    }
    const d2 = (p: Vec3) => p.reduce((s, v, a) => s + (v - centre[a]) ** 2, 0);
    cands.sort((p, q) => d2(p) - d2(q));
    const hit = cands.find(isInside);
    return (hit ?? centre).map(v => tidy(roundSig(v, 5))) as Vec3;
  }
  const h = [(m.x1 - m.x0) / Math.max(1, m.nx), (m.y1 - m.y0) / Math.max(1, m.ny), (m.z1 - m.z0) / Math.max(1, m.nz)];
  const lo = [m.x0, m.y0, m.z0];
  const hi = [m.x1, m.y1, m.z1];
  let fallback: Vec3 | null = null;
  for (let corner = 0; corner < 8; corner++) {
    const p = [0, 1, 2].map(a => {
      const fromMax = (corner >> a) & 1;
      return tidy(roundSig(fromMax ? hi[a] - 0.63 * h[a] : lo[a] + 0.63 * h[a], 4));
    }) as Vec3;
    fallback ??= p;
    if (!geometry || !pointInBox(p, geometry)) return p;
  }
  return fallback!;
}

/** A refinement box around the body and its near wake, one level below the surface. */
export function proposeRefinementBox(bbox: Bbox, surfaceMinLevel: number, name = 'refinementBox'): RefinementRegion {
  const size = [0, 1, 2].map(a => bbox.max[a] - bbox.min[a]);
  const L = Math.max(...size) || 1;
  const pad = 0.25 * L;
  const r = newRefinementRegion(name, bbox, Math.max(1, surfaceMinLevel - 1));
  r.min = [0, 1, 2].map(a => tidy(roundSig(bbox.min[a] - pad, 3))) as Vec3;
  r.max = [0, 1, 2].map(a => tidy(roundSig(bbox.max[a] + (a === 0 ? 2 * L : pad), 3))) as Vec3;
  return r;
}

// ── Checks ──────────────────────────────────────────────────────────────────

/**
 * What is wrong with the snappy settings, in words; empty when nothing is.
 * `insideBody` is the caller's ray-test verdict on the loaded geometry, already
 * phrased for the flow side (null when the geometry is not loaded, so nothing
 * is claimed either way).
 */
export function snappyProblems(s: SnappySettings, m: MeshSpec, insideBody: string | null = null, boxPatchNames: string[] = []): string[] {
  const out: string[] = [];
  if (s.surfaces.length === 0) {
    out.push('No geometry imported: add an STL or OBJ file, or switch the mesh back to blockMesh only.');
  }

  const names = new Set<string>();
  const taken = new Set(s.refinementRegions.map(r => r.name));
  for (const x of s.surfaces) {
    if (!WORD.test(x.name)) out.push(`Surface name "${x.name}" must be a letter followed by letters, digits or underscores.`);
    if (names.has(x.name)) out.push(`Two surfaces are called "${x.name}".`);
    if (taken.has(x.name)) out.push(`"${x.name}" is also a refinement region's name; rename one of them.`);
    names.add(x.name);
    if (!intIn(x.minLevel, 0, 10) || !intIn(x.maxLevel, 0, 10)) {
      out.push(`${x.name}: refinement levels must be whole numbers from 0 to 10.`);
    } else if (x.minLevel > x.maxLevel) {
      out.push(`${x.name}: the minimum level (${x.minLevel}) is above the maximum (${x.maxLevel}).`);
    }
    if (!intIn(x.featureLevel, 0, 10)) out.push(`${x.name}: the feature level must be a whole number from 0 to 10.`);
    for (const r of x.regions) {
      if (!x.regionNames.includes(r.region)) out.push(`${x.name}: the geometry has no region "${r.region}".`);
      if (!WORD.test(r.group)) out.push(`${x.name}/${r.region}: the patch group must be a letter followed by letters, digits or underscores.`);
      const lo = r.minLevel ?? x.minLevel, hi = r.maxLevel ?? x.maxLevel;
      if (!intIn(lo, 0, 10) || !intIn(hi, 0, 10) || lo > hi) out.push(`${x.name}/${r.region}: levels must be whole numbers from 0 to 10, minimum not above maximum.`);
    }
  }

  // One entry per group name in 0/: two roles under one name cannot both hold.
  const roles = new Map<string, string>();
  for (const p of snappyPatches(s)) {
    const had = roles.get(p.name);
    if (had && had !== p.role) out.push(`The patch group "${p.name}" is given two roles (${had}, ${p.role}).`);
    roles.set(p.name, p.role);
    if (boxPatchNames.includes(p.name)) out.push(`"${p.name}" is both a box patch and a surface group; rename one of them.`);
  }

  if (m.twoD) out.push('snappyHexMesh builds a 3D mesh: turn off "2D case".');
  // blockMesh multiplies the background vertices by `scale`, snappyHexMesh
  // reads the geometry as it is: anything but 1 puts the two in different units.
  if (m.scale !== 1) out.push('Set the blockMesh scale to 1: the background box is in metres, like the (scaled) geometry.');

  const box = boxOf(m);
  if (!s.insidePoint.every(Number.isFinite)) {
    out.push('insidePoint must be three numbers.');
  } else if (!pointInBox(s.insidePoint, box)) {
    out.push(`insidePoint ${vec(s.insidePoint)} is outside the background box, so snappyHexMesh finds no fluid to keep.`);
  }
  if (insideBody) out.push(insideBody);

  const geometry = geometryBbox(s);
  if (geometry && s.flow === 'external') {
    const clipped = [0, 1, 2].some(a => geometry.min[a] < box.min[a] || geometry.max[a] > box.max[a]);
    if (clipped) out.push('Part of the geometry lies outside the background box; snappyHexMesh can only mesh inside it.');
  }
  if (geometry && s.flow === 'internal') {
    const inside = [0, 1, 2].every(a => geometry.min[a] > box.min[a] && geometry.max[a] < box.max[a]);
    if (!inside) out.push('For an internal flow the background box must enclose the whole geometry, with a margin.');
  }

  const h = [(m.x1 - m.x0) / Math.max(1, m.nx), (m.y1 - m.y0) / Math.max(1, m.ny), (m.z1 - m.z0) / Math.max(1, m.nz)];
  if (h.every(v => v > 0)) {
    const ratio = Math.max(...h) / Math.min(...h);
    if (ratio > 2) {
      out.push(`Background cells are ${ratio.toFixed(1)} times longer one way than another. snappyHexMesh splits each cell into eight, so stretched cells stay stretched: aim for the same cell size along x, y and z.`);
    }
  }

  for (const r of s.refinementRegions) {
    if (!WORD.test(r.name)) out.push(`Refinement region "${r.name}" must be a letter followed by letters, digits or underscores.`);
    if (!intIn(r.level, 1, 10)) out.push(`${r.name}: the level must be a whole number from 1 to 10.`);
    if (r.shape === 'box' && ![0, 1, 2].every(a => Number.isFinite(r.min[a]) && Number.isFinite(r.max[a]) && r.max[a] > r.min[a])) {
      out.push(`${r.name}: the box needs max above min along x, y and z.`);
    }
    if (r.shape !== 'box' && !(r.radius > 0)) out.push(`${r.name}: the radius must be positive.`);
    if (r.shape === 'cylinder' && r.point1.every((v, a) => v === r.point2[a])) out.push(`${r.name}: the cylinder's two axis points coincide.`);
  }
  const regionNames = s.refinementRegions.map(r => r.name);
  if (new Set(regionNames).size !== regionNames.length) out.push('Two refinement regions have the same name.');

  if (s.layers.enabled) {
    if (!intIn(s.layers.nSurfaceLayers, 1, 20)) out.push('The number of layers must be a whole number from 1 to 20.');
    if (!s.layers.patches.length) out.push('Layers are on, but no surface or patch is chosen to get them.');
    if (!(s.layers.expansionRatio >= 1)) out.push('The layer expansion ratio must be 1 or more.');
    if (!(s.layers.finalLayerThickness > 0) || !(s.layers.minThickness > 0)) out.push('Layer thicknesses must be positive.');
  }
  if (!(s.includedAngle >= 0 && s.includedAngle <= 180)) out.push('includedAngle must be between 0 and 180 degrees.');
  return out;
}

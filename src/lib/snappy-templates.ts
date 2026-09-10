/**
 * snappyHexMesh for the New Case wizard: the dictionaries, the proposals and
 * the checks, kept out of the component for the same reason as
 * ./case-templates.ts — the interesting part is not the UI.
 *
 * What it writes is modelled on the Foundation v13 and v14 installations, not on
 * memory:
 *
 *   - The utility is `surfaceFeatures` reading `system/surfaceFeaturesDict`.
 *     `surfaceFeatureExtract` is the ESI name; on 13 and 14 it is only a script
 *     that prints "superseded by surfaceFeatures".
 *   - Every snappy tutorial names the fluid point `insidePoint` (never
 *     `locationInMesh`) and keeps its geometry in `constant/geometry`.
 *   - The installation ships `caseDicts/mesh/generation/snappyHexMeshDict.cfg`
 *     and `caseDicts/surface/surfaceFeaturesDict.cfg`, and the tutorials that
 *     `#includeEtc` them override only what they need. The generated dictionaries
 *     do the same, so everything the user did not choose here stays the
 *     installation's own default. That .cfg includes
 *     `${FOAM_CASE}/system/meshQualityDict`, so that file is written too.
 *   - Surface types are `triSurface` and `box` (foamToC's searchableSurface
 *     table on 14; the v13 motorBike tutorial uses the same names).
 *
 * Only offered on 13 and 14, where all of that was checked.
 */

import { header, type MeshPatch, type MeshSpec } from './case-templates';
import { pointInBox, unionBbox, type Bbox, type Vec3 } from './geometry';

export const SNAPPY_VERSIONS: readonly number[] = [13, 14];

export const SNAPPY_UNAVAILABLE = 'Available on OpenFOAM 13 and 14 only';

export const SNAPPY_CFG = 'caseDicts/mesh/generation/snappyHexMeshDict.cfg';
export const SURFACE_FEATURES_CFG = 'caseDicts/surface/surfaceFeaturesDict.cfg';
export const MESH_QUALITY_CFG = 'caseDicts/mesh/generation/meshQualityDict.cfg';
/** The files the generated dictionaries include from the installation. */
export const SNAPPY_ETC_FILES = [SNAPPY_CFG, SURFACE_FEATURES_CFG, MESH_QUALITY_CFG];

/** Name of the analytical refinement box in the geometry dictionary. */
export const REFINEMENT_BOX = 'refinementBox';

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

export interface SnappySurface {
  /** Geometry entry and patch prefix: an OpenFOAM word. */
  name: string;
  /** File in constant/geometry, e.g. `motorBike.obj.gz`. */
  file: string;
  minLevel: number;
  maxLevel: number;
  /** Refinement level at the feature edges surfaceFeatures extracts; 0 = none. */
  featureLevel: number;
  /** From the import; kept so a reopened case can still propose and check. */
  bbox: Bbox | null;
  triangles: number;
  regions: number;
  bytes: number;
}

export interface RefinementBoxSpec { enabled: boolean; min: Vec3; max: Vec3; level: number }

export interface SnappySettings {
  surfaces: SnappySurface[];
  refinementBox: RefinementBoxSpec;
  /** A point in the fluid: snappyHexMesh keeps the region that contains it. */
  insidePoint: Vec3;
  addLayers: boolean;
  nSurfaceLayers: number;
  /** surfaceFeatures: edges sharper than 180 - this angle are features. */
  includedAngle: number;
  /** Hand edits, as for the blockMeshDict: set, the form stops regenerating. */
  snappyOverride: string | null;
  featuresOverride: string | null;
}

export const DEFAULT_SNAPPY: SnappySettings = {
  surfaces: [],
  refinementBox: { enabled: false, min: [0, 0, 0], max: [1, 1, 1], level: 1 },
  insidePoint: [0, 0, 0],
  addLayers: false,
  nSurfaceLayers: 3,
  includedAngle: 150,
  snappyOverride: null,
  featuresOverride: null,
};

export const DEFAULT_SURFACE_LEVELS = { minLevel: 2, maxLevel: 3, featureLevel: 3 };

// ── Names ───────────────────────────────────────────────────────────────────

const GEOMETRY_EXT = /\.(stl|stlb|obj)$/i;

/** A surface name from a file name: an OpenFOAM word, unique among `taken`. */
export function surfaceNameFromFile(fileName: string, taken: string[] = []): string {
  const base = fileName.split(/[\\/]/).pop() || '';
  const stem = base.replace(/\.gz$/i, '').replace(GEOMETRY_EXT, '');
  let name = stem.replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 48);
  if (!/^[A-Za-z]/.test(name)) name = name ? `surface_${name}` : 'surface';
  const used = new Set([...taken, REFINEMENT_BOX]);
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

/** The edge mesh surfaceFeatures writes next to the surface. */
export function featureFile(file: string): string {
  return `${referencedFile(file).replace(GEOMETRY_EXT, '')}.eMesh`;
}

export function geometryPath(file: string): string {
  return `constant/geometry/${file}`;
}

/**
 * The patch group every patch cut from a surface is put in.
 *
 * snappyHexMesh makes one patch per region (`motorBike_frame:016-shadow%13`,
 * 67 of them for motorBike), and the 0/ files cannot list them in advance. The
 * group is declared in `patchInfo`, so the wizard can write one condition for
 * all of them — and the Mesh tab's boundary check already resolves groups.
 */
export function surfaceGroupName(surfaceName: string): string {
  return `${surfaceName}Group`;
}

/** The extra entries a snappy case needs in every 0/ file. */
export function snappyPatches(s: SnappySettings | null): MeshPatch[] {
  if (!s) return [];
  return s.surfaces.map(x => ({ name: surfaceGroupName(x.name), role: 'wall' as const }));
}

/** The commands that build the mesh, in order. */
export function meshSteps(s: SnappySettings | null): string[] {
  if (!s || s.surfaces.length === 0) return ['blockMesh', 'checkMesh'];
  return ['blockMesh', 'surfaceFeatures', 'snappyHexMesh', 'checkMesh'];
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

// ── Dictionaries ────────────────────────────────────────────────────────────

export function generateSurfaceFeaturesDict(s: SnappySettings): string {
  const files = s.surfaces.map(x => `    "${referencedFile(x.file)}"`).join('\n');
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

export function generateMeshQualityDict(): string {
  return `${header('dictionary', 'meshQualityDict', 'system')}
// Read by snappyHexMeshDict.cfg through \${FOAM_CASE}/system/meshQualityDict.
#includeEtc "${MESH_QUALITY_CFG}"
`;
}

export function generateSnappyHexMeshDict(s: SnappySettings): string {
  const withFeatures = s.surfaces.filter(x => x.featureLevel > 0);

  const geometry = [
    ...s.surfaces.map(x => `    ${x.name}
    {
        type triSurface;
        file "${referencedFile(x.file)}";
    }`),
    ...(s.refinementBox.enabled ? [`    ${REFINEMENT_BOX}
    {
        type box;
        min  ${vec(s.refinementBox.min)};
        max  ${vec(s.refinementBox.max)};
    }`] : []),
  ].join('\n\n');

  const features = withFeatures
    .map(x => `        { file "${featureFile(x.file)}"; level ${x.featureLevel}; }`)
    .join('\n');

  const surfaces = s.surfaces.map(x => `        ${x.name}
        {
            level (${x.minLevel} ${x.maxLevel});
            patchInfo
            {
                type wall;
                inGroups (${surfaceGroupName(x.name)});
            }
        }`).join('\n\n');

  const regions = s.refinementBox.enabled ? `\n        ${REFINEMENT_BOX}
        {
            mode    inside;
            level   ${s.refinementBox.level};
        }` : '';

  // The patches of one surface are `<name>` or `<name>_<region>`; this pattern
  // takes both without also catching a surface whose name merely starts the same.
  const layers = s.addLayers ? `\n${s.surfaces.map(x => `        "${x.name}(_.*)?"
        {
            nSurfaceLayers ${s.nSurfaceLayers};
        }`).join('\n\n')}` : '';

  return `${header('dictionary', 'snappyHexMeshDict', 'system')}
// Only the choices made in the wizard are written here. Everything else is the
// installation's default, from $FOAM_ETC/${SNAPPY_CFG}
// (entries below merge into its dictionaries).
#includeEtc "${SNAPPY_CFG}"

castellatedMesh true;
snap            true;
addLayers       ${s.addLayers ? 'true' : 'false'};

geometry
{
${geometry}
};

castellatedMeshControls
{
    features
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

    insidePoint ${vec(s.insidePoint)};
}

snapControls
{
    // Snap to the edges surfaceFeatures extracted when there are any.
    explicitFeatureSnap ${withFeatures.length ? 'true' : 'false'};
    implicitFeatureSnap ${withFeatures.length ? 'false' : 'true'};
}

addLayersControls
{
    layers
    {
${layers}
    }

    relativeSizes       true;
    expansionRatio      1.2;
    finalLayerThickness 0.5;
    minThickness        0.1;
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

/**
 * A background box for flow around a body, from the geometry's bounding box.
 *
 * With L the largest extent: one L of free stream upstream (towards x min,
 * where the inlet patch is), three downstream for the wake, one on every other
 * side. Cells are cubes of L/8 — snappyHexMesh refines by splitting each cell
 * into eight, so a stretched background cell stays stretched at every level —
 * and the box is snapped to whole cells so they stay cubes.
 */
export function proposeBackground(bbox: Bbox): Pick<MeshSpec, 'x0' | 'x1' | 'y0' | 'y1' | 'z0' | 'z1' | 'nx' | 'ny' | 'nz'> {
  const size = [0, 1, 2].map(a => bbox.max[a] - bbox.min[a]);
  const L = Math.max(...size) || 1;
  const h = roundSig(L / 8);
  const before = [L, L, L];
  const after = [3 * L, L, L];
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
 * A point in the fluid: inside the first background cell of a corner of the
 * box that is clear of the geometry, off the cell centre so it cannot sit on a
 * face or edge once the cell is split.
 */
export function proposeInsidePoint(m: MeshSpec, geometry: Bbox | null): Vec3 {
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

/** A refinement box around the body and its near wake. */
export function proposeRefinementBox(bbox: Bbox, surfaceMinLevel: number): RefinementBoxSpec {
  const size = [0, 1, 2].map(a => bbox.max[a] - bbox.min[a]);
  const L = Math.max(...size) || 1;
  const pad = 0.25 * L;
  return {
    enabled: true,
    min: [0, 1, 2].map(a => tidy(roundSig(bbox.min[a] - pad, 3))) as Vec3,
    max: [0, 1, 2].map(a => tidy(roundSig(bbox.max[a] + (a === 0 ? 2 * L : pad), 3))) as Vec3,
    level: Math.max(1, surfaceMinLevel - 1),
  };
}

// ── Checks ──────────────────────────────────────────────────────────────────

/**
 * What is wrong with the snappy settings, in words; empty when nothing is.
 * `insideBody` is the caller's ray test on the loaded geometry (null when the
 * geometry is not loaded, so nothing is claimed either way).
 */
export function snappyProblems(s: SnappySettings, m: MeshSpec, insideBody: string | null = null): string[] {
  const out: string[] = [];
  if (s.surfaces.length === 0) {
    out.push('No geometry imported: add an STL or OBJ file, or switch the mesh back to blockMesh only.');
  }

  const names = new Set<string>();
  for (const x of s.surfaces) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(x.name)) out.push(`Surface name "${x.name}" must be a letter followed by letters, digits or underscores.`);
    if (names.has(x.name)) out.push(`Two surfaces are called "${x.name}".`);
    if (x.name === REFINEMENT_BOX) out.push(`"${REFINEMENT_BOX}" is the refinement box's name; rename the surface.`);
    names.add(x.name);
    if (!intIn(x.minLevel, 0, 10) || !intIn(x.maxLevel, 0, 10)) {
      out.push(`${x.name}: refinement levels must be whole numbers from 0 to 10.`);
    } else if (x.minLevel > x.maxLevel) {
      out.push(`${x.name}: the minimum level (${x.minLevel}) is above the maximum (${x.maxLevel}).`);
    }
    if (!intIn(x.featureLevel, 0, 10)) out.push(`${x.name}: the feature level must be a whole number from 0 to 10.`);
  }

  if (m.twoD) out.push('snappyHexMesh builds a 3D mesh: turn off "2D case".');
  // blockMesh multiplies the background vertices by `scale`, snappyHexMesh
  // reads the geometry as it is: anything but 1 puts the two in different units.
  if (m.scale !== 1) out.push('Set the blockMesh scale to 1: the background box must be in the geometry\'s own units, which snappyHexMesh does not scale.');

  const box = boxOf(m);
  if (!s.insidePoint.every(Number.isFinite)) {
    out.push('insidePoint must be three numbers.');
  } else if (!pointInBox(s.insidePoint, box)) {
    out.push(`insidePoint ${vec(s.insidePoint)} is outside the background box, so snappyHexMesh finds no fluid to keep.`);
  }
  if (insideBody) out.push(insideBody);

  const geometry = unionBbox(s.surfaces.map(x => x.bbox));
  if (geometry) {
    const clipped = [0, 1, 2].some(a => geometry.min[a] < box.min[a] || geometry.max[a] > box.max[a]);
    if (clipped) out.push('Part of the geometry lies outside the background box; snappyHexMesh can only mesh inside it.');
  }

  const h = [(m.x1 - m.x0) / Math.max(1, m.nx), (m.y1 - m.y0) / Math.max(1, m.ny), (m.z1 - m.z0) / Math.max(1, m.nz)];
  if (h.every(v => v > 0)) {
    const ratio = Math.max(...h) / Math.min(...h);
    if (ratio > 2) {
      out.push(`Background cells are ${ratio.toFixed(1)} times longer one way than another. snappyHexMesh splits each cell into eight, so stretched cells stay stretched: aim for the same cell size along x, y and z.`);
    }
  }

  const r = s.refinementBox;
  if (r.enabled) {
    if (![0, 1, 2].every(a => Number.isFinite(r.min[a]) && Number.isFinite(r.max[a]) && r.max[a] > r.min[a])) {
      out.push('The refinement box needs max above min along x, y and z.');
    }
    if (!intIn(r.level, 1, 10)) out.push('The refinement box level must be a whole number from 1 to 10.');
  }
  if (s.addLayers && !intIn(s.nSurfaceLayers, 1, 20)) out.push('The number of layers must be a whole number from 1 to 20.');
  if (!(s.includedAngle >= 0 && s.includedAngle <= 180)) out.push('includedAngle must be between 0 and 180 degrees.');
  return out;
}

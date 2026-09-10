/**
 * "Update case": what the New Case wizard leaves in a case, and how an update
 * decides which files it may rewrite.
 *
 * A case the wizard creates carries `system/studioWizard.json` — the settings
 * the wizard was given and the SHA-256 of every file it wrote. It lives in
 * system/ on purpose: renaming moves the whole folder and cloning copies 0/,
 * system/ and constant/, so the record follows the case both ways (the user's
 * decision), and OpenFOAM never reads a file it was not told to.
 *
 * The hashes are what make an update safe. For every file there are three:
 * what the wizard wrote last time (recorded), what is on disk now, and what the
 * wizard would write now (next). A file whose disk hash still matches the
 * recorded one was not touched since, and may be rewritten; one that differs
 * was edited by someone else — the File Editor, an agent, a script — and the
 * user is asked. Nothing is ever overwritten silently.
 *
 * Pure: the component supplies the hashes, the server computes the disk ones.
 */

import {
  DEFAULT_MESH, type FieldConfig, type Flavour, type MeshSpec, type TurbulenceModel,
} from './case-templates';
import { DEFAULT_SNAPPY, type SnappySettings, type SnappySurface } from './snappy-templates';
import type { Bbox, Vec3 } from './geometry';

export const WIZARD_MARKER_PATH = 'system/studioWizard.json';
export const WIZARD_MARKER_FORMAT = 1;

const ABOUT = 'Written by the OpenFOAM Studio New Case wizard so the case can be updated from it. '
  + 'OpenFOAM does not read this file; deleting it only removes that option.';

/** Everything the wizard needs to reproduce its files. */
export interface WizardSettings {
  flavour: Flavour;
  solver: string;
  transient: boolean;
  turbulence: TurbulenceModel;
  nu: string;
  inletVelocity: string;
  intensity: string;
  lengthScale: string;
  endTime: string;
  deltaT: string;
  writeInterval: string;
  gravity: string;
  mesh: MeshSpec;
  meshOverride: string | null;
  systemOverrides: Record<string, string>;
  constantOverrides: Record<string, string>;
  fields: FieldConfig[];
  /** null: the mesh is blockMesh only. */
  snappy: SnappySettings | null;
}

export interface WizardMarker {
  about: string;
  format: number;
  createdAt: string;
  updatedAt: string;
  /** The installation's version when last written, for information. */
  foamVersion: string | null;
  settings: WizardSettings;
  /** Case-relative path → SHA-256 (hex) of the content the wizard last wrote. */
  files: Record<string, string>;
}

export function buildMarker(
  settings: WizardSettings,
  files: Record<string, string>,
  foamVersion: string | null,
  previous: WizardMarker | null,
  now = new Date(),
): WizardMarker {
  const stamp = now.toISOString();
  return {
    about: ABOUT,
    format: WIZARD_MARKER_FORMAT,
    createdAt: previous?.createdAt ?? stamp,
    updatedAt: stamp,
    foamVersion,
    settings,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function serializeMarker(marker: WizardMarker): string {
  return `${JSON.stringify(marker, null, 2)}\n`;
}

// ── Reading a marker back ───────────────────────────────────────────────────
//
// The file is in the case, so anything can have edited it. A malformed value
// must not reach the wizard's state (it renders straight from it), so each one
// falls back to the default rather than failing the whole restore.

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const numb = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function vec3(v: unknown, d: Vec3): Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && Number.isFinite(x))
    ? [v[0], v[1], v[2]] : [...d] as Vec3;
}

function strRecord(v: unknown): Record<string, string> {
  if (!isObj(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) as Record<string, string>;
}

function bbox(v: unknown): Bbox | null {
  if (!isObj(v)) return null;
  const min = vec3(v.min, [NaN, NaN, NaN]);
  const max = vec3(v.max, [NaN, NaN, NaN]);
  return min.every(Number.isFinite) && max.every(Number.isFinite) ? { min, max } : null;
}

function normalizeMesh(v: unknown): MeshSpec {
  const m = isObj(v) ? v : {};
  const d = DEFAULT_MESH;
  return {
    x0: numb(m.x0, d.x0), x1: numb(m.x1, d.x1),
    y0: numb(m.y0, d.y0), y1: numb(m.y1, d.y1),
    z0: numb(m.z0, d.z0), z1: numb(m.z1, d.z1),
    nx: numb(m.nx, d.nx), ny: numb(m.ny, d.ny), nz: numb(m.nz, d.nz),
    scale: numb(m.scale, d.scale),
    twoD: bool(m.twoD, d.twoD),
  };
}

function normalizeFields(v: unknown, d: FieldConfig[]): FieldConfig[] {
  if (!Array.isArray(v)) return d;
  return v.filter(isObj).map(f => ({
    fieldName: str(f.fieldName, ''),
    dimensions: str(f.dimensions, '[0 0 0 0 0 0 0]'),
    internalField: str(f.internalField, 'uniform 0'),
    boundaryConditions: (Array.isArray(f.boundaryConditions) ? f.boundaryConditions : [])
      .filter(isObj)
      .map(bc => ({ name: str(bc.name, ''), type: str(bc.type, 'zeroGradient'), value: str(bc.value, '') })),
  }));
}

function normalizeSurface(v: Record<string, unknown>): SnappySurface {
  return {
    name: str(v.name, 'surface'),
    file: str(v.file, ''),
    minLevel: numb(v.minLevel, 2),
    maxLevel: numb(v.maxLevel, 3),
    featureLevel: numb(v.featureLevel, 0),
    bbox: bbox(v.bbox),
    triangles: numb(v.triangles, 0),
    regions: numb(v.regions, 0),
    bytes: numb(v.bytes, 0),
  };
}

function normalizeSnappy(v: unknown): SnappySettings | null {
  if (!isObj(v)) return null;
  const d = DEFAULT_SNAPPY;
  const box = isObj(v.refinementBox) ? v.refinementBox : {};
  return {
    surfaces: (Array.isArray(v.surfaces) ? v.surfaces : []).filter(isObj).map(normalizeSurface)
      .filter(s => s.file),
    refinementBox: {
      enabled: bool(box.enabled, d.refinementBox.enabled),
      min: vec3(box.min, d.refinementBox.min),
      max: vec3(box.max, d.refinementBox.max),
      level: numb(box.level, d.refinementBox.level),
    },
    insidePoint: vec3(v.insidePoint, d.insidePoint),
    addLayers: bool(v.addLayers, d.addLayers),
    nSurfaceLayers: numb(v.nSurfaceLayers, d.nSurfaceLayers),
    includedAngle: numb(v.includedAngle, d.includedAngle),
    snappyOverride: strOrNull(v.snappyOverride),
    featuresOverride: strOrNull(v.featuresOverride),
  };
}

/** The recorded settings, every value checked and defaulted against `d`. */
export function normalizeSettings(v: unknown, d: WizardSettings): WizardSettings {
  const s = isObj(v) ? v : {};
  const flavour = s.flavour === 'legacy' || s.flavour === 'modular' ? s.flavour : d.flavour;
  const turbulence = (['laminar', 'kEpsilon', 'kOmegaSST', 'SpalartAllmaras'] as const)
    .find(t => t === s.turbulence) ?? d.turbulence;
  return {
    flavour,
    solver: str(s.solver, d.solver),
    transient: bool(s.transient, d.transient),
    turbulence,
    nu: str(s.nu, d.nu),
    inletVelocity: str(s.inletVelocity, d.inletVelocity),
    intensity: str(s.intensity, d.intensity),
    lengthScale: str(s.lengthScale, d.lengthScale),
    endTime: str(s.endTime, d.endTime),
    deltaT: str(s.deltaT, d.deltaT),
    writeInterval: str(s.writeInterval, d.writeInterval),
    gravity: str(s.gravity, d.gravity),
    mesh: normalizeMesh(s.mesh),
    meshOverride: strOrNull(s.meshOverride),
    systemOverrides: strRecord(s.systemOverrides),
    constantOverrides: strRecord(s.constantOverrides),
    fields: normalizeFields(s.fields, d.fields),
    snappy: normalizeSnappy(s.snappy),
  };
}

const HASH = /^[0-9a-f]{64}$/;
const SAFE_PATH = /^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[^\0\\]+$/;

/**
 * Read a marker, or say why it cannot be used. A case without one is simply a
 * case the wizard did not make — the caller only asks when it expects one.
 */
export function parseMarker(text: string, defaults: WizardSettings):
  { marker: WizardMarker; error: null } | { marker: null; error: string } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch {
    return { marker: null, error: `${WIZARD_MARKER_PATH} is not valid JSON.` };
  }
  if (!isObj(raw)) return { marker: null, error: `${WIZARD_MARKER_PATH} is not a wizard record.` };
  if (raw.format !== WIZARD_MARKER_FORMAT) {
    return { marker: null, error: `${WIZARD_MARKER_PATH} was written by a different version of the wizard (format ${String(raw.format)}).` };
  }
  if (!isObj(raw.settings)) return { marker: null, error: `${WIZARD_MARKER_PATH} carries no settings.` };
  const files: Record<string, string> = {};
  if (isObj(raw.files)) {
    for (const [p, h] of Object.entries(raw.files)) {
      if (typeof h === 'string' && HASH.test(h) && SAFE_PATH.test(p) && p !== WIZARD_MARKER_PATH) files[p] = h;
    }
  }
  return {
    error: null,
    marker: {
      about: ABOUT,
      format: WIZARD_MARKER_FORMAT,
      createdAt: str(raw.createdAt, ''),
      updatedAt: str(raw.updatedAt, ''),
      foamVersion: strOrNull(raw.foamVersion),
      settings: normalizeSettings(raw.settings, defaults),
      files,
    },
  };
}

// ── Planning an update ──────────────────────────────────────────────────────

export type PlanAction = 'same' | 'create' | 'write' | 'delete' | 'conflict';

/**
 * Why a file needs the user's word:
 *   modified          the wizard wrote it, someone edited it since
 *   missing           the wizard wrote it, someone deleted it
 *   foreign           the wizard never wrote it, but a file is already there
 *   obsolete-modified the wizard no longer generates it, and it was edited
 */
export type ConflictReason = 'modified' | 'missing' | 'foreign' | 'obsolete-modified';

export interface PlanEntry {
  path: string;
  action: PlanAction;
  reason?: ConflictReason;
}

/** The user's answer for a conflict: do what the wizard wants, or leave the disk alone. */
export type Decision = 'apply' | 'keep';

export function planUpdate(input: {
  /** From the marker. */
  recorded: Record<string, string>;
  /** Current disk hashes; null = no such file. Must cover every path below. */
  onDisk: Record<string, string | null>;
  /** What the wizard would write now. */
  next: Record<string, string>;
  /** Recorded paths to leave alone entirely (geometry not re-imported). */
  untouched?: string[];
}): PlanEntry[] {
  const { recorded, onDisk, next } = input;
  const untouched = new Set(input.untouched ?? []);
  const plan: PlanEntry[] = [];

  for (const path of Object.keys(next).sort()) {
    const disk = onDisk[path] ?? null;
    const rec = recorded[path];
    const want = next[path];
    if (disk === want) plan.push({ path, action: 'same' });
    else if (disk === null) plan.push(rec === undefined ? { path, action: 'create' } : { path, action: 'conflict', reason: 'missing' });
    else if (rec !== undefined && disk === rec) plan.push({ path, action: 'write' });
    else plan.push({ path, action: 'conflict', reason: rec === undefined ? 'foreign' : 'modified' });
  }

  for (const path of Object.keys(recorded).sort()) {
    if (path in next || untouched.has(path)) continue;
    const disk = onDisk[path] ?? null;
    if (disk === null) continue;                       // already gone
    if (disk === recorded[path]) plan.push({ path, action: 'delete' });
    else plan.push({ path, action: 'conflict', reason: 'obsolete-modified' });
  }
  return plan;
}

export interface ResolvedPlan {
  /** Paths to write with the wizard's content. */
  write: string[];
  /** Paths to delete. */
  remove: string[];
  /** The marker's `files` after the update. */
  recorded: Record<string, string>;
  /** Conflicts without an answer; nothing may be applied while any remain. */
  undecided: string[];
}

/**
 * Turn a plan and the user's answers into writes, deletions and the new record.
 *
 * What is recorded for a file the user kept matters more than it looks. Were it
 * the user's own hash, the NEXT update would take their version for the
 * wizard's and overwrite it without asking; the previous hash stays instead, so
 * the file keeps coming back as edited by hand. An obsolete file the user kept
 * is dropped from the record: the wizard no longer generates it, and it is now
 * simply theirs.
 */
export function resolvePlan(
  plan: PlanEntry[],
  decisions: Record<string, Decision | undefined>,
  next: Record<string, string>,
  recorded: Record<string, string>,
  untouched: string[] = [],
): ResolvedPlan {
  const out: ResolvedPlan = { write: [], remove: [], recorded: {}, undecided: [] };
  for (const path of untouched) if (recorded[path]) out.recorded[path] = recorded[path];

  for (const e of plan) {
    const wanted = e.path in next;
    switch (e.action) {
      case 'same':
        out.recorded[e.path] = next[e.path];
        break;
      case 'create':
      case 'write':
        out.write.push(e.path);
        out.recorded[e.path] = next[e.path];
        break;
      case 'delete':
        out.remove.push(e.path);
        break;
      case 'conflict': {
        const d = decisions[e.path];
        if (!d) { out.undecided.push(e.path); if (recorded[e.path]) out.recorded[e.path] = recorded[e.path]; break; }
        if (d === 'apply') {
          if (wanted) { out.write.push(e.path); out.recorded[e.path] = next[e.path]; }
          else out.remove.push(e.path);
        } else if (wanted && recorded[e.path]) {
          out.recorded[e.path] = recorded[e.path];
        }
        break;
      }
    }
  }
  return out;
}

/** Deep equality of two settings objects, whatever order their keys were set in. */
export function settingsEqual(a: WizardSettings, b: WizardSettings): boolean {
  const stable = (v: unknown): string => JSON.stringify(v, (_key, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => p.localeCompare(q)))
      : x);
  return stable(a) === stable(b);
}

/** Files the mesh is built from: changing any of them makes the mesh stale. */
export function isMeshInput(path: string): boolean {
  return /^system\/(blockMeshDict|snappyHexMeshDict|surfaceFeaturesDict|meshQualityDict)$/.test(path)
    || path.startsWith('constant/geometry/');
}

// ── Hashing ─────────────────────────────────────────────────────────────────

/**
 * SHA-256 as lowercase hex — the same string `sha256sum` prints for the file the
 * server writes, since text goes to disk as its UTF-8 bytes. Web Crypto, so it
 * runs unchanged in the browser (the app's origin is localhost, a secure
 * context) and in Node.
 */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

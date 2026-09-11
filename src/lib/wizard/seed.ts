/**
 * Starting a case from one of the installation's tutorials of a solver module
 * — the route the wizard takes for the modules whose physics is many
 * interlocking dictionaries (multiphaseEuler, XiFluid, …), by the user's
 * decision.
 *
 * The tutorial supplies the physics; the wizard supplies the mesh. So:
 *
 *   - constant/ and the non-mesh system/ dictionaries are taken as they are
 *     (and shown for editing); mesh dictionaries are the wizard's own;
 *   - every 0/ field keeps its dimensions, internalField and everything above
 *     them, and gets a new boundaryField for the wizard's patches: each patch
 *     takes the condition the tutorial used on a patch with the same role
 *     (inlet, outlet, wall, …), decided from the tutorial's own patch types
 *     and names;
 *   - a physics file that names one of the tutorial's patches is flagged, since
 *     that patch will not exist in the new mesh (found by searching the text,
 *     not guessed).
 *
 * Pure; the files come from /api/tutorials?action=seed.
 */

import type { BoundaryCondition, FieldConfig, MeshPatch, PatchRole } from '../case-templates';
import { constraintType } from '../case-templates';
import { entries, parseFieldFile, renderEntries, splitBoundaryBody, stripComments, type DictEntry } from './foam-dict';

export interface SeedFile { path: string; content: string }

/** Dictionaries that build or change the mesh: the wizard writes its own. */
const MESH_FILE = /^system\/(blockMeshDict|snappyHexMeshDict|surfaceFeaturesDict|meshQualityDict|extrudeMeshDict|createPatchDict|createBafflesDict|mirrorMeshDict|refineMeshDict|topoSetDict|subsetMeshDict|collapseDict|createZonesDict|fineBlockMeshDict|createNonConformalCouplesDict)(\..*)?$/;

/** A tutorial patch as its blockMeshDict declares it. */
export interface TutorialPatch { name: string; type: string }

/** The patches of the tutorial's blockMeshDict (empty when it meshes some other way). */
export function tutorialPatches(files: SeedFile[]): TutorialPatch[] {
  const bm = files.find(f => f.path === 'system/blockMeshDict');
  if (!bm) return [];
  const top = entries(stripComments(bm.content));
  const boundary = top.find(e => e.key === 'boundary');
  if (!boundary) return [];
  const inner = boundary.body.replace(/^\(/, '').replace(/\)$/, '');
  return entries(inner).filter(e => e.kind === 'dict').map(e => ({
    name: e.key,
    type: entries(e.body).find(x => x.key === 'type')?.body ?? 'patch',
  }));
}

/** What a tutorial patch does, from its type and its name. null: cannot tell. */
export function classifyPatch(name: string, type = 'patch'): PatchRole | null {
  const n = name.toLowerCase().replace(/^"|"$/g, '');
  if (type === 'empty' || /frontandback|frontback|^empty/.test(n)) return 'empty';
  if (type === 'symmetryPlane' || type === 'symmetry' || /symmetry/.test(n)) return 'symmetry';
  if (/inlet|inflow/.test(n)) return 'inlet';
  if (/outlet|outflow/.test(n)) return 'outlet';
  if (/atmosphere|^top$|openatm/.test(n)) return 'atmosphere';
  if (/freestream|farfield/.test(n)) return 'freestream';
  if (/lid|moving/.test(n) && type === 'wall') return 'movingWall';
  if (type === 'wall' || /wall|floor|ceiling|bottom|sides?$/.test(n)) return 'wall';
  return null;
}

/** The physics files to keep, and those that name a tutorial patch. */
export function seedPhysicsFiles(files: SeedFile[], patchNames: string[]): { keep: SeedFile[]; mentionsPatches: Record<string, string[]> } {
  const keep = files.filter(f =>
    (f.path.startsWith('constant/') || f.path.startsWith('system/')) && !MESH_FILE.test(f.path));
  const mentionsPatches: Record<string, string[]> = {};
  for (const f of keep) {
    const text = stripComments(f.content);
    const hits = patchNames.filter(p => new RegExp(`(^|[^A-Za-z0-9_])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`).test(text));
    if (hits.length) mentionsPatches[f.path] = hits;
  }
  return { keep, mentionsPatches };
}

/** 0/include/* and similar: files the fields #include, copied as they are. */
export function seedIncludeFiles(files: SeedFile[]): SeedFile[] {
  return files.filter(f => /^0(\.orig)?\/.+\/.+/.test(f.path)).map(f => ({ ...f, path: f.path.replace(/^0\.orig\//, '0/') }));
}

function fallbackBC(field: string, cls: string, patch: MeshPatch): BoundaryCondition {
  const vector = cls.includes('Vector');
  const at = (type: string, value = '', extra = ''): BoundaryCondition => (extra ? { name: patch.name, type, value, extra } : { name: patch.name, type, value });
  const constraint = constraintType(patch.type) ?? (patch.role === 'empty' ? 'empty' : patch.role === 'symmetry' ? 'symmetry' : null);
  if (constraint) return at(constraint);
  const pressure = /^p(_rgh)?(\.|$)/.test(field);
  switch (patch.role) {
    case 'inlet': return pressure ? at('zeroGradient') : at('fixedValue', '$internalField');
    case 'outlet': case 'pressureInlet': case 'atmosphere': case 'freestream':
      return pressure ? at('fixedValue', '$internalField') : at('inletOutlet', '$internalField', 'inletValue $internalField');
    case 'slipWall': return vector ? at('slip') : at('zeroGradient');
    default: return vector && /^U(\.|$)/.test(field) ? at('noSlip') : at('zeroGradient');
  }
}

/**
 * A tutorial field, re-targeted at the wizard's patches.
 *
 * Each wizard patch takes the tutorial's condition for the same role (the
 * first tutorial patch classified that way); a role the tutorial never used
 * gets a plain default the user sees and can change in the Fields step.
 */
export function seedField(file: SeedFile, patches: MeshPatch[], tutorial: TutorialPatch[]): FieldConfig | null {
  const parsed = parseFieldFile(file.content);
  if (!parsed) return null;
  const base = file.path.replace(/^0(\.orig)?\//, '');
  // `alpha.water.orig` (v13 tutorials that run setFields) is the field alpha.water.
  const orig = base.endsWith('.orig');
  const name = orig ? base.slice(0, -'.orig'.length) : base;
  const typeOf = new Map(tutorial.map(p => [p.name, p.type]));
  const byRole = new Map<PatchRole, DictEntry>();
  for (const e of parsed.boundary) {
    if (e.kind !== 'dict') continue;
    const role = classifyPatch(e.key, typeOf.get(e.key) ?? (e.key.includes('*') || e.key.includes('(') ? 'wall' : 'patch'));
    if (role && !byRole.has(role)) byRole.set(role, e);
  }
  const boundaryConditions = patches.map(p => {
    const role = p.role === 'movingWall' && !byRole.has('movingWall') ? 'wall' : p.role;
    const hit = byRole.get(role);
    const constraint = constraintType(p.type);
    if (!hit || constraint) return fallbackBC(name, parsed.cls, p);
    const { type, value, extra } = splitBoundaryBody(hit.body);
    return extra ? { name: p.name, type, value, extra } : { name: p.name, type, value };
  });
  const directives = parsed.boundary.filter(e => e.kind === 'directive');
  return {
    fieldName: name,
    cls: parsed.cls,
    dimensions: parsed.dimensions,
    internalField: parsed.internalField,
    preamble: renderEntries(parsed.preamble),
    boundaryConditions,
    ...(directives.length ? { boundaryTail: renderEntries(directives) } : {}),
    ...(orig ? { orig: true } : {}),
  };
}

/** Every 0/ field of the tutorial (0/, else 0.orig/), re-targeted. */
export function seedFields(files: SeedFile[], patches: MeshPatch[]): FieldConfig[] {
  const has0 = files.some(f => /^0\/[^/]+$/.test(f.path));
  const dir = has0 ? /^0\/[^/]+$/ : /^0\.orig\/[^/]+$/;
  const tutorial = tutorialPatches(files);
  return files.filter(f => dir.test(f.path))
    .map(f => seedField(f, patches, tutorial))
    .filter((f): f is FieldConfig => !!f);
}

/**
 * Case file generation for the New Case wizard.
 *
 * Kept out of the component because the interesting part is not the UI: it is
 * that **OpenFOAM 11 reorganised how a case is described**, and a case written
 * the old way simply does not run on 11+.
 *
 *   ≤ 10 ("legacy")            11+ ("modular")
 *   ────────────────────────   ─────────────────────────────
 *   application simpleFoam;    solver incompressibleFluid;   (in controlDict)
 *   constant/transportProperties   constant/physicalProperties
 *   constant/turbulenceProperties  constant/momentumTransport
 *   RAS { RASModel kEpsilon; }     RAS { model kEpsilon; }
 *   dimensions [0 1 -1 0 0 0 0];   dimensions [velocity];
 *
 * Every generator here takes the flavour and emits the right one. The content
 * is modelled on the tutorials that ship with the installed version
 * (`incompressibleFluid/cavity`, `pitzDaily`, `pitzDailySteady` for 14), not on
 * memory — patch names, wall functions and scheme choices are copied from
 * there deliberately.
 */

export type Flavour = 'modular' | 'legacy';

/** OpenFOAM 11 is where `foamRun` + solver modules replaced the solver apps. */
export const MODULAR_FROM_VERSION = 11;

export function flavourForVersion(major: number | null | undefined): Flavour {
  // Unknown version: assume modern. Everything from 11 to 14 is modular, and a
  // legacy case on a modular install fails immediately and confusingly, while
  // the reverse at least reads.
  //
  // NaN counts as unknown, and has to be tested for rather than fallen through:
  // `NaN >= 11` is false, so the comparison below would quietly answer "legacy"
  // — the one answer this function exists to avoid. NaN is not hypothetical
  // either, it is exactly what the caller computes from a version string with no
  // digits in it (`parseInt('', 10)`), which is what a failed detection returns.
  if (major === null || major === undefined || !Number.isFinite(major)) return 'modular';
  return major >= MODULAR_FROM_VERSION ? 'modular' : 'legacy';
}

// ── Solvers ─────────────────────────────────────────────────────────────────

export interface SolverChoice {
  value: string;
  label: string;
  desc: string;
  /** Time treatment this solver is normally used with. */
  transient: boolean;
  /** Needs constant/g and a p_rgh field rather than p. */
  buoyant?: boolean;
  compressible?: boolean;
  multiphase?: boolean;
}

/**
 * OpenFOAM 11+ — `foamRun -solver <name>`, names as in `lib*Solver.so`.
 *
 * Only the solvers whose files this wizard can actually write. It generates U,
 * a kinematic p and a viscosity-only properties file; isothermalFluid, fluid,
 * the VoF and multicomponent solvers, shockFluid and solidDisplacement each
 * need more (T and a thermoType, alpha fields and phaseProperties, D) and used
 * to be offered anyway — the case stopped at startup while the summary said
 * everything checked out. The wizard sends those users to the tutorials.
 */
export const SOLVER_MODULES: SolverChoice[] = [
  { value: 'incompressibleFluid', label: 'incompressibleFluid', desc: 'Incompressible, steady or transient (was simpleFoam / pimpleFoam)', transient: false },
];

/**
 * OpenFOAM ≤ 10 — the solver is an executable named in controlDict. Same rule
 * as above; of the solvers dropped, sonicFoam did not exist on 9 or 10 at all
 * and buoyantSimpleFoam is gone from 10 (merged into buoyantFoam).
 */
export const SOLVER_APPLICATIONS: SolverChoice[] = [
  { value: 'simpleFoam', label: 'simpleFoam', desc: 'Incompressible steady-state (RANS)', transient: false },
  { value: 'pimpleFoam', label: 'pimpleFoam', desc: 'Incompressible transient (PIMPLE)', transient: true },
  { value: 'pisoFoam', label: 'pisoFoam', desc: 'Incompressible transient (PISO)', transient: true },
  { value: 'icoFoam', label: 'icoFoam', desc: 'Incompressible laminar transient', transient: true },
];

export function solverChoices(flavour: Flavour): SolverChoice[] {
  return flavour === 'modular' ? SOLVER_MODULES : SOLVER_APPLICATIONS;
}

export function findSolver(flavour: Flavour, value: string): SolverChoice | undefined {
  return solverChoices(flavour).find(s => s.value === value);
}

/** The command the user will actually run, shown on the summary step. */
export function runCommand(flavour: Flavour, solver: string): string {
  return flavour === 'modular' ? 'foamRun' : solver;
}

// ── Turbulence ──────────────────────────────────────────────────────────────

export type TurbulenceModel = 'laminar' | 'kEpsilon' | 'kOmegaSST' | 'SpalartAllmaras';

export const TURBULENCE_MODELS: { value: TurbulenceModel; label: string; desc: string }[] = [
  { value: 'laminar', label: 'Laminar', desc: 'No turbulence model' },
  { value: 'kEpsilon', label: 'k-epsilon', desc: 'Standard, robust for internal flows' },
  { value: 'kOmegaSST', label: 'k-omega SST', desc: 'Better in boundary layers and adverse gradients' },
  { value: 'SpalartAllmaras', label: 'Spalart-Allmaras', desc: 'One equation, external aerodynamics' },
];

/** The 0/ fields a model needs on top of U and p. */
export function turbulenceFieldNames(model: TurbulenceModel): string[] {
  switch (model) {
    case 'kEpsilon': return ['k', 'epsilon', 'nut'];
    case 'kOmegaSST': return ['k', 'omega', 'nut'];
    case 'SpalartAllmaras': return ['nuTilda', 'nut'];
    default: return [];
  }
}

/**
 * Inlet turbulence from the usual engineering correlations.
 *
 *   k = 1.5 (U·I)²        ε = Cμ^¾ k^{3/2} / L        ω = k^{1/2} / (Cμ^¼ L)
 *
 * `intensity` is a fraction (0.05 = 5%) and `lengthScale` is the turbulent
 * length scale in metres — about 7% of the hydraulic diameter for a duct. These
 * are the numbers people otherwise compute on a scrap of paper, and getting
 * them wrong by orders of magnitude is the usual reason a first RANS run
 * diverges.
 */
export function estimateTurbulence(velocity: number, intensity: number, lengthScale: number) {
  const Cmu = 0.09;
  const u = Math.abs(velocity) || 1e-6;
  const L = Math.abs(lengthScale) || 1e-3;
  const k = 1.5 * Math.pow(u * intensity, 2);
  const epsilon = Math.pow(Cmu, 0.75) * Math.pow(k, 1.5) / L;
  const omega = Math.pow(k, 0.5) / (Math.pow(Cmu, 0.25) * L);
  return { k: sig(k), epsilon: sig(epsilon), omega: sig(omega) };
}

/** 4 significant digits — enough for an initial condition, short enough to read. */
function sig(v: number): number {
  if (!Number.isFinite(v) || v === 0) return 0;
  const d = Math.ceil(Math.log10(Math.abs(v)));
  const p = 4 - d;
  return Number(v.toFixed(Math.max(0, Math.min(20, p))));
}

// ── Mesh ────────────────────────────────────────────────────────────────────

/**
 * What a patch does, which decides the boundary condition every field gets
 * there. The first four are the classic box; the rest are what a real case
 * needs — a lid-driven cavity has a moving wall, a tank an open top, an
 * external flow a far field.
 */
export type PatchRole =
  | 'inlet' | 'outlet' | 'wall' | 'empty'
  | 'symmetry' | 'slipWall' | 'movingWall' | 'pressureInlet' | 'atmosphere' | 'freestream'
  // A solid: heat conduction (solid) and stress analysis (solidDisplacement).
  | 'fixedTemperature' | 'heatFlux' | 'adiabatic' | 'convection'
  | 'fixedSupport' | 'traction' | 'tractionFree';

/** blockMesh patch types the wizard writes. Constraint types force the BC type. */
export type PatchType = 'patch' | 'wall' | 'symmetryPlane' | 'symmetry' | 'empty';

export interface MeshPatch { name: string; role: PatchRole; type?: PatchType }

export type BoxFace = 'xMin' | 'xMax' | 'yMin' | 'yMax' | 'zMin' | 'zMax';
export const BOX_FACES: BoxFace[] = ['xMin', 'xMax', 'yMin', 'yMax', 'zMin', 'zMax'];

/** A patch of the box: a name, a type, a role, and the faces it covers. */
export interface BoxPatch { name: string; type: PatchType; role: PatchRole; faces: BoxFace[] }

export interface MeshSpec {
  x0: number; x1: number;
  y0: number; y1: number;
  z0: number; z1: number;
  nx: number; ny: number; nz: number;
  /** blockMesh `scale`: vertices are multiplied by this, so 0.001 means mm. */
  scale: number;
  /** 2D case: the two z faces become an `empty` patch and nz is forced to 1. */
  twoD: boolean;
  /** simpleGrading (x y z): last cell / first cell along each axis. Absent: (1 1 1). */
  grading?: [number, number, number];
  /**
   * The box's patches. Absent: the classic inlet (x min), outlet (x max) and
   * walls (the rest), plus frontAndBack in 2D — what every earlier case had.
   * In 2D the z faces always form the empty frontAndBack patch, whatever this says.
   */
  patches?: BoxPatch[];
}

/** The constraint BC a patch type imposes, or null for patch and wall. */
export function constraintType(type: PatchType | undefined): string | null {
  return type === 'empty' || type === 'symmetryPlane' || type === 'symmetry' ? type : null;
}

/** The patch type a role normally has. */
export function typeForRole(role: PatchRole): PatchType {
  switch (role) {
    case 'wall': case 'slipWall': case 'movingWall': return 'wall';
    // Not symmetryPlane: that one must be a single plane, and a patch made of
    // several box faces is not (OpenFOAM stops with "is not planar").
    case 'symmetry': return 'symmetry';
    case 'empty': return 'empty';
    default: return 'patch';
  }
}

/** The classic box, as explicit patches. */
export function defaultBoxPatches(twoD: boolean): BoxPatch[] {
  return [
    { name: 'inlet', type: 'patch', role: 'inlet', faces: ['xMin'] },
    { name: 'outlet', type: 'patch', role: 'outlet', faces: ['xMax'] },
    { name: 'walls', type: 'wall', role: 'wall', faces: twoD ? ['yMin', 'yMax'] : ['yMin', 'yMax', 'zMin', 'zMax'] },
  ];
}

/** The box patches blockMesh will actually write, after the 2D rule. */
export function effectiveBoxPatches(m: MeshSpec): BoxPatch[] {
  const base = (m.patches ?? defaultBoxPatches(m.twoD))
    .map(p => ({ ...p, faces: m.twoD ? p.faces.filter(f => f !== 'zMin' && f !== 'zMax') : [...p.faces] }))
    .filter(p => p.faces.length > 0 && p.type !== 'empty');
  if (m.twoD) base.push({ name: 'frontAndBack', type: 'empty', role: 'empty', faces: ['zMin', 'zMax'] });
  return base;
}

export const DEFAULT_MESH: MeshSpec = {
  x0: 0, x1: 1, y0: 0, y1: 0.2, z0: 0, z1: 0.1,
  nx: 60, ny: 20, nz: 1,
  scale: 1,
  twoD: true,
};

/**
 * The patches the generated blockMeshDict defines, in the order they appear.
 *
 * The wizard drives the boundary conditions off this list, so the 0/ files and
 * the mesh can never disagree about patch names — which is the single most
 * common way a hand-built case fails to start.
 */
export function meshPatches(m: MeshSpec): MeshPatch[] {
  return effectiveBoxPatches(m).map(p => ({ name: p.name, role: p.role, type: p.type }));
}

function num(v: number): string {
  // Avoid 0.30000000000000004 in a dictionary a human is going to read.
  return String(Number(v.toFixed(10)));
}

/**
 * What is wrong with a mesh, in words, or an empty list if nothing is.
 *
 * The wizard used to check names, fields and patches but never the geometry, so
 * the three ways a box can be nonsense all reached blockMesh instead of the
 * summary step:
 *
 *   - a zero-thickness domain (`x1` left equal to `x0`, easy to do by clearing
 *     the field, since an empty number input reads back as 0) produced a block
 *     with no volume, and blockMesh answered with an arithmetic error about a
 *     face it could not normalise;
 *   - an inverted domain (`x1 < x0`) produced negative volumes, which blockMesh
 *     reports much later and in terms of cell indices;
 *   - a cell count of a few hundred per side is 10^7-10^8 cells, which does not
 *     fail at all — it takes the machine's memory and the app looks hung.
 *
 * Each of those is cheap to detect here and expensive to diagnose there.
 */
export function meshProblems(m: MeshSpec): string[] {
  const out: string[] = [];
  const axes: [string, number, number][] = [['X', m.x0, m.x1], ['Y', m.y0, m.y1], ['Z', m.z0, m.z1]];

  for (const [axis, lo, hi] of axes) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      out.push(`The ${axis} bounds are not numbers.`);
    } else if (hi === lo) {
      out.push(`The domain has no thickness in ${axis} (both bounds are ${num(lo)}).`);
    } else if (hi < lo) {
      out.push(`The ${axis} bounds are inverted (${num(lo)} to ${num(hi)}), which makes every cell volume negative.`);
    }
  }

  if (!Number.isFinite(m.scale) || m.scale <= 0) {
    out.push('scale must be a positive number — it multiplies every vertex.');
  }

  const counts: [string, number][] = [['X', m.nx], ['Y', m.ny], ['Z', m.twoD ? 1 : m.nz]];
  for (const [axis, n] of counts) {
    if (!Number.isFinite(n) || n < 1) out.push(`The ${axis} cell count must be at least 1.`);
  }

  if (m.grading && !m.grading.every(g => Number.isFinite(g) && g > 0)) {
    out.push('Each grading ratio must be a positive number (1 means uniform cells).');
  }

  if (m.patches) {
    const faces = m.twoD ? BOX_FACES.filter(f => f !== 'zMin' && f !== 'zMax') : BOX_FACES;
    const owner = new Map<BoxFace, string[]>();
    for (const p of m.patches) for (const f of p.faces) owner.set(f, [...(owner.get(f) ?? []), p.name]);
    const unassigned = faces.filter(f => !owner.get(f)?.length);
    if (unassigned.length) out.push(`These box faces belong to no patch: ${unassigned.join(', ')}.`);
    const twice = faces.filter(f => (owner.get(f)?.length ?? 0) > 1);
    if (twice.length) out.push(`These box faces are in more than one patch: ${twice.join(', ')}.`);
    const names = m.patches.filter(p => p.faces.some(f => faces.includes(f))).map(p => p.name);
    const bad = names.filter(n => !/^[A-Za-z][A-Za-z0-9_]*$/.test(n));
    if (bad.length) out.push(`Patch names must be a letter followed by letters, digits or underscores: ${bad.join(', ')}.`);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    if (dup.length) out.push(`Two patches are called ${[...new Set(dup)].join(', ')}.`);
    if (m.twoD && names.includes('frontAndBack')) out.push('frontAndBack is the name the 2D empty patch takes; rename that patch.');
    if (!m.twoD && m.patches.some(p => p.type === 'empty' && p.faces.length)) {
      out.push('An empty patch only makes sense in a 2D case: turn on "2D case" or change its type.');
    }
    for (const p of m.patches) {
      const n = p.faces.filter(f => faces.includes(f)).length;
      if (p.type === 'symmetryPlane' && n > 1) {
        out.push(`${p.name}: a symmetryPlane must be one flat face and it spans ${n}; use the symmetry type, or one patch per face.`);
      }
    }
  }

  const total = Math.max(1, Math.round(m.nx)) * Math.max(1, Math.round(m.ny))
    * (m.twoD ? 1 : Math.max(1, Math.round(m.nz)));
  if (Number.isFinite(total) && total > 20_000_000) {
    out.push(`That is ${total.toLocaleString('en-US')} cells — blockMesh will most likely run the machine out of memory.`);
  } else if (Number.isFinite(total) && total > 2_000_000) {
    out.push(`That is ${total.toLocaleString('en-US')} cells, so blockMesh will take a while and the case will be large.`);
  }

  return out;
}

export function generateBlockMeshDict(m: MeshSpec): string {
  const nz = m.twoD ? 1 : Math.max(1, Math.round(m.nz));
  const v = (x: number, y: number, z: number) => `    (${num(x)} ${num(y)} ${num(z)})`;

  // Standard hex vertex order: 0-3 the z0 face counter-clockwise, 4-7 the z1
  // face above it. Every face list below follows from it.
  const vertices = [
    v(m.x0, m.y0, m.z0), v(m.x1, m.y0, m.z0), v(m.x1, m.y1, m.z0), v(m.x0, m.y1, m.z0),
    v(m.x0, m.y0, m.z1), v(m.x1, m.y0, m.z1), v(m.x1, m.y1, m.z1), v(m.x0, m.y1, m.z1),
  ].join('\n');

  const boundary = effectiveBoxPatches(m)
    .map(p => block(p.name, p.type, p.faces.map(f => FACE_VERTICES[f])))
    .join('\n\n');
  const g = (m.grading ?? [1, 1, 1]).map(v => (Number.isFinite(v) && v > 0 ? num(v) : '1')).join(' ');

  return `${header('dictionary', 'blockMeshDict', 'system')}
scale   ${num(m.scale)};

vertices
(
${vertices}
);

blocks
(
    hex (0 1 2 3 4 5 6 7) (${Math.max(1, Math.round(m.nx))} ${Math.max(1, Math.round(m.ny))} ${nz}) simpleGrading (${g})
);

edges
(
);

boundary
(
${boundary}
);

mergePatchPairs
(
);
`;
}

// Standard hex vertex order: 0-3 the z0 face counter-clockwise, 4-7 the z1
// face above it. Each face is wound so its normal points out of the block.
const FACE_VERTICES: Record<BoxFace, string> = {
  xMin: '(0 4 7 3)', xMax: '(1 2 6 5)',
  yMin: '(0 1 5 4)', yMax: '(3 7 6 2)',
  zMin: '(0 3 2 1)', zMax: '(4 5 6 7)',
};

function block(name: string, type: string, faces: string[]): string {
  return `    ${name}
    {
        type ${type};
        faces
        (
${faces.map(f => `            ${f}`).join('\n')}
        );
    }`;
}

// ── File headers ────────────────────────────────────────────────────────────

export function header(cls: string, object: string, location: string, flavour: Flavour = 'modular'): string {
  // `version 2.0;` is only conventional on ≤10; 11+ tutorials dropped it.
  const version = flavour === 'legacy' ? '    version     2.0;\n' : '';
  return `/*--------------------------------*- C++ -*----------------------------------*\\
  =========                 |
  \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox
   \\\\    /   O peration     | Website:  https://openfoam.org
    \\\\  /    A nd           |
     \\\\/     M anipulation  |
\\*---------------------------------------------------------------------------*/
FoamFile
{
${version}    format      ascii;
    class       ${cls};
    location    "${location}";
    object      ${object};
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
`;
}

// ── 0/ fields ───────────────────────────────────────────────────────────────

export interface BoundaryCondition {
  name: string;
  type: string;
  value: string;
  /** Further entries, one `key value;` per line (inletValue, p0, freestreamValue…). */
  extra?: string;
}

export interface FieldConfig {
  fieldName: string;
  dimensions: string;
  internalField: string;
  boundaryConditions: BoundaryCondition[];
  /** The field class, when it cannot be told from the name (seeded fields). */
  cls?: string;
  /** Text written before `dimensions`: #include lines, variables (seeded fields). */
  preamble?: string;
  /** Text written inside boundaryField after the patches: #includeEtc lines. */
  boundaryTail?: string;
  /**
   * Written as 0/<name>.orig: setFields reads it (OpenFOAM falls back to the
   * .orig file) and writes 0/<name> with its initial regions filled in, so the
   * wizard's own file is never the one setFields rewrites.
   */
  orig?: boolean;
}

/**
 * Dimensions, as the exponent list.
 *
 * OpenFOAM 14 also accepts named sets (`[velocity]`, `[kinematicPressure]`) and
 * its own tutorials use them — but 13 does not know those names and dies at
 * startup inside the dimensionSet lookup, which is exactly the kind of silent
 * version drift this module exists to avoid. The numeric form is understood by
 * every version from 9 to 14, so that is what gets written.
 */
const DIMENSIONS: Record<string, string> = {
  U: '[0 1 -1 0 0 0 0]',
  p: '[0 2 -2 0 0 0 0]',
  p_rgh: '[0 2 -2 0 0 0 0]',
  k: '[0 2 -2 0 0 0 0]',
  epsilon: '[0 2 -3 0 0 0 0]',
  omega: '[0 0 -1 0 0 0 0]',
  nut: '[0 2 -1 0 0 0 0]',
  nuTilda: '[0 2 -1 0 0 0 0]',
  T: '[0 0 0 1 0 0 0]',
  alphat: '[1 -1 -1 0 0 0 0]',
};

export function dimensionsFor(fieldName: string): string {
  return DIMENSIONS[fieldName] ?? '[0 0 0 0 0 0 0]';
}

/** A vector field is written with a different class, and OpenFOAM checks it. */
export function fieldClass(f: FieldConfig): string {
  if (f.cls) return f.cls;
  if (f.fieldName === 'U') return 'volVectorField';
  return /^\s*(uniform\s*)?\(/.test(f.internalField) ? 'volVectorField' : 'volScalarField';
}

export function generateFieldFile(f: FieldConfig, flavour: Flavour): string {
  const bcs = f.boundaryConditions
    .filter(bc => bc.name.trim())
    .map(bc =>
      `    ${bc.name}\n    {\n        type            ${bc.type};\n` +
      (bc.extra ?? '').split('\n').map(l => l.trimEnd()).filter(l => l.trim())
        .map((l, i, all) => {
          // A keyword whose sub-dictionary opens on the next line takes no `;`
          // (alphaContactAngle's contactAngleProperties, from a tutorial).
          const done = /[;{}]$/.test(l) || (all[i + 1] ?? '').trim().startsWith('{');
          return `        ${done ? l : `${l};`}\n`;
        }).join('') +
      (bc.value.trim() ? `        value           ${bc.value};\n` : '') +
      `    }`
    )
    .join('\n\n');

  const preamble = f.preamble?.trim() ? `${f.preamble.trim()}\n\n` : '';
  // A zonal (v14) internalField is a dictionary, written without `;`.
  const internal = f.internalField.trim().startsWith('{')
    ? `internalField\n${f.internalField.trim()}`
    : `internalField   ${f.internalField};`;
  const tail = f.boundaryTail?.trim() ? `\n\n    ${f.boundaryTail.trim().split('\n').join('\n    ')}` : '';
  return `${header(fieldClass(f), f.fieldName, '0', flavour)}
${preamble}dimensions      ${f.dimensions};

${internal}

boundaryField
{
${bcs}${tail}
}
`;
}

export interface FieldContext {
  /** Inlet velocity as a vector literal, e.g. "(1 0 0)". */
  inletVelocity: string;
  k: number;
  epsilon: number;
  omega: number;
  nu: number;
  /** The case's model; nut's wall function depends on it. */
  turbulence?: TurbulenceModel;
  /** Velocity of a moving wall (lid), as a vector literal. Default: the inlet velocity. */
  wallVelocity?: string;
}

/**
 * The boundary condition a given field wants on a given kind of patch.
 *
 * Straight out of the incompressibleFluid tutorials: wall functions on walls
 * for the RAS fields, `calculated` for nut, `empty` wherever the mesh is empty.
 */
export function defaultBC(fieldName: string, patch: MeshPatch, ctx: FieldContext): BoundaryCondition {
  const at = (type: string, value = '', extra = '') => (extra ? { name: patch.name, type, value, extra } : { name: patch.name, type, value });
  // A constraint patch type admits exactly its own condition, on every field.
  const constraint = constraintType(patch.type);
  if (patch.role === 'empty' || constraint === 'empty') return at('empty');
  if (constraint) return at(constraint);

  // The roles beyond the classic box. nut is `calculated` wherever there is no
  // wall function; the turbulence quantities take inletOutlet where flow may
  // come back in, as the incompressibleFluid tutorials do.
  const turbulent = ['k', 'epsilon', 'omega', 'nuTilda'].includes(fieldName);
  const internal = internalFor(fieldName, ctx);
  switch (patch.role) {
    case 'symmetry':
      return at('symmetry');
    case 'slipWall':
      if (fieldName === 'U') return at('slip');
      if (fieldName === 'nut') return at('calculated', 'uniform 0');
      return at('zeroGradient');
    case 'movingWall':
      if (fieldName === 'U') return at('movingWallVelocity', `uniform ${ctx.wallVelocity ?? ctx.inletVelocity}`);
      break;   // every other field: as on a wall
    case 'pressureInlet':
    case 'atmosphere':
      if (fieldName === 'U') return at('pressureInletOutletVelocity', 'uniform (0 0 0)');
      if (fieldName === 'p' || fieldName === 'p_rgh') return at('totalPressure', 'uniform 0', 'p0 uniform 0');
      if (fieldName === 'nut') return at('calculated', 'uniform 0');
      if (turbulent) return at('inletOutlet', internal, `inletValue ${internal}`);
      return at('zeroGradient');
    case 'freestream':
      if (fieldName === 'U') return at('freestreamVelocity', `uniform ${ctx.inletVelocity}`, `freestreamValue uniform ${ctx.inletVelocity}`);
      if (fieldName === 'p' || fieldName === 'p_rgh') return at('freestreamPressure', 'uniform 0', 'freestreamValue uniform 0');
      if (fieldName === 'nut') return at('calculated', 'uniform 0');
      if (turbulent) return at('freestream', internal, `freestreamValue ${internal}`);
      return at('zeroGradient');
  }
  const role = patch.role === 'movingWall' ? 'wall' : patch.role;
  if (role !== patch.role) patch = { ...patch, role };

  switch (fieldName) {
    case 'U':
      if (patch.role === 'inlet') return at('fixedValue', `uniform ${ctx.inletVelocity}`);
      if (patch.role === 'outlet') return at('zeroGradient');
      return at('noSlip');
    case 'p':
    case 'p_rgh':
      if (patch.role === 'outlet') return at('fixedValue', 'uniform 0');
      return at('zeroGradient');
    case 'k':
      if (patch.role === 'inlet') return at('fixedValue', `uniform ${ctx.k}`);
      if (patch.role === 'outlet') return at('zeroGradient');
      return at('kqRWallFunction', `uniform ${ctx.k}`);
    case 'epsilon':
      if (patch.role === 'inlet') return at('fixedValue', `uniform ${ctx.epsilon}`);
      if (patch.role === 'outlet') return at('zeroGradient');
      return at('epsilonWallFunction', `uniform ${ctx.epsilon}`);
    case 'omega':
      if (patch.role === 'inlet') return at('fixedValue', `uniform ${ctx.omega}`);
      if (patch.role === 'outlet') return at('zeroGradient');
      return at('omegaWallFunction', `uniform ${ctx.omega}`);
    case 'nut':
      // Spalart-Allmaras has no k (its k() is a zero field), so
      // nutkWallFunction computes y+ = 0 and leaves nut at 0 on every wall:
      // the run goes through with the wrong wall shear and no error. The v13
      // airFoil2D tutorial uses the Spalding law, which works from U alone.
      if (patch.role === 'wall') {
        return at(ctx.turbulence === 'SpalartAllmaras' ? 'nutUSpaldingWallFunction' : 'nutkWallFunction', 'uniform 0');
      }
      return at('calculated', 'uniform 0');
    case 'nuTilda': {
      // Spalart-Allmaras: the usual freestream estimate is 3-5 ν.
      const nuTilda = sig(ctx.nu * 4);
      if (patch.role === 'inlet') return at('fixedValue', `uniform ${nuTilda}`);
      if (patch.role === 'outlet') return at('zeroGradient');
      return at('fixedValue', 'uniform 0');
    }
    case 'T':
      if (patch.role === 'inlet') return at('fixedValue', 'uniform 300');
      return at('zeroGradient');
    default:
      if (patch.role === 'inlet') return at('fixedValue', 'uniform 0');
      return at('zeroGradient');
  }
}

function internalFor(fieldName: string, ctx: FieldContext): string {
  switch (fieldName) {
    case 'U': return 'uniform (0 0 0)';
    case 'k': return `uniform ${ctx.k}`;
    case 'epsilon': return `uniform ${ctx.epsilon}`;
    case 'omega': return `uniform ${ctx.omega}`;
    case 'nuTilda': return `uniform ${sig(ctx.nu * 4)}`;
    case 'T': return 'uniform 300';
    default: return 'uniform 0';
  }
}

export function buildField(
  fieldName: string, patches: MeshPatch[], ctx: FieldContext, flavour: Flavour
): FieldConfig {
  return {
    fieldName,
    dimensions: dimensionsFor(fieldName),
    internalField: internalFor(fieldName, ctx),
    boundaryConditions: patches.map(p => defaultBC(fieldName, p, ctx)),
  };
}

/**
 * Re-apply the mesh's patch list to a field, keeping any boundary condition the
 * user has already customised for a patch of the same name.
 */
export function syncFieldPatches(
  f: FieldConfig, patches: MeshPatch[], ctx: FieldContext
): FieldConfig {
  const existing = new Map(f.boundaryConditions.map(bc => [bc.name, bc]));
  return {
    ...f,
    boundaryConditions: patches.map(p => existing.get(p.name) ?? defaultBC(f.fieldName, p, ctx)),
  };
}

// ── system/ ─────────────────────────────────────────────────────────────────

export interface SystemOptions {
  flavour: Flavour;
  solver: string;
  transient: boolean;
  endTime: string;
  deltaT: string;
  writeInterval: string;
  turbulence: TurbulenceModel;
}

export function generateControlDict(o: SystemOptions): string {
  // 11+ names the solver MODULE here and is launched with `foamRun`; ≤10 names
  // the executable itself.
  const runner = o.flavour === 'modular'
    ? `solver          ${o.solver};`
    : `application     ${o.solver};`;

  return `${header('dictionary', 'controlDict', 'system', o.flavour)}
${runner}

startFrom       latestTime;

startTime       0;

stopAt          endTime;

endTime         ${o.endTime};

deltaT          ${o.deltaT};

writeControl    timeStep;

writeInterval   ${o.writeInterval};

purgeWrite      0;

writeFormat     ascii;

writePrecision  6;

writeCompression off;

timeFormat      general;

timePrecision   6;

runTimeModifiable yes;
`;
}

export function generateFvSchemes(o: SystemOptions): string {
  // Steady runs get `bounded` on the divergence terms: without it the
  // unconverged continuity error acts as a source and the run drifts.
  const bounded = o.transient ? '' : 'bounded ';
  const turb = o.turbulence === 'laminar' ? '' : `
    div(phi,k)      ${bounded}Gauss limitedLinear 1;
    div(phi,epsilon) ${bounded}Gauss limitedLinear 1;
    div(phi,omega)  ${bounded}Gauss limitedLinear 1;
    div(phi,nuTilda) ${bounded}Gauss limitedLinear 1;`;

  // wallDist: kOmegaSST and Spalart-Allmaras compute a wall distance and read
  // this sub-dictionary with no default, so without it they stop at startup
  // (the v13 and v14 pitzDailySteady tutorials both carry it). The other
  // models never read it, so it is always written.
  return `${header('dictionary', 'fvSchemes', 'system', o.flavour)}
ddtSchemes
{
    default         ${o.transient ? 'Euler' : 'steadyState'};
}

gradSchemes
{
    default         Gauss linear;
}

divSchemes
{
    default         none;

    div(phi,U)      ${bounded}Gauss linearUpwind grad(U);${turb}

    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}

laplacianSchemes
{
    default         Gauss linear corrected;
}

interpolationSchemes
{
    default         linear;
}

snGradSchemes
{
    default         corrected;
}

wallDist
{
    method          meshWave;
}
`;
}

export function generateFvSolution(o: SystemOptions): string {
  const solvers = `solvers
{
    p
    {
        solver          GAMG;
        tolerance       1e-06;
        relTol          ${o.transient ? '0.01' : '0.1'};
        smoother        GaussSeidel;
    }

    pFinal
    {
        $p;
        relTol          0;
    }

    "(U|k|epsilon|omega|nuTilda)"
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-05;
        relTol          ${o.transient ? '0.01' : '0.1'};
    }

    "(U|k|epsilon|omega|nuTilda)Final"
    {
        $U;
        relTol          0;
    }
}`;

  // icoFoam and pisoFoam (≤10) drive their loop with pisoControl, which reads a
  // PISO dictionary and stops without one; a PIMPLE block is not read at all.
  const piso = o.flavour === 'legacy' && (o.solver === 'icoFoam' || o.solver === 'pisoFoam');
  const algorithm = piso
    ? `PISO
{
    nCorrectors     2;
    nNonOrthogonalCorrectors 0;
}`
    : o.transient
    ? `PIMPLE
{
    nOuterCorrectors 1;
    nCorrectors     2;
    nNonOrthogonalCorrectors 0;
}`
    : `SIMPLE
{
    nNonOrthogonalCorrectors 0;
    consistent      yes;

    residualControl
    {
        p               1e-3;
        U               1e-4;
        "(k|epsilon|omega|nuTilda)" 1e-4;
    }
}

relaxationFactors
{
    equations
    {
        ".*"            0.9;
    }
}`;

  return `${header('dictionary', 'fvSolution', 'system', o.flavour)}
${solvers}

${algorithm}
`;
}

// ── constant/ ───────────────────────────────────────────────────────────────

/**
 * 11+ renamed both of the constant/ dictionaries the wizard writes.
 *
 * One solver moved earlier: icoFoam on 10 reads physicalProperties directly,
 * with no fallback to the old name, while the other v10 solvers still find
 * transportProperties. `major` is the installation's major version, if known.
 */
export function transportFileName(flavour: Flavour, solver = '', major: number | null = null): string {
  if (flavour === 'modular') return 'physicalProperties';
  return solver === 'icoFoam' && major === 10 ? 'physicalProperties' : 'transportProperties';
}

export function turbulenceFileName(flavour: Flavour): string {
  return flavour === 'modular' ? 'momentumTransport' : 'turbulenceProperties';
}

export function generateTransportProperties(nu: string, flavour: Flavour, object = transportFileName(flavour)): string {
  if (flavour === 'modular') {
    return `${header('dictionary', object, 'constant', flavour)}
viscosityModel  constant;

nu              ${nu} [m^2/s];

// Air 1.5e-05 · Water 1e-06 · Oil 1e-04  (kinematic viscosity, m^2/s)
`;
  }
  return `${header('dictionary', object, 'constant', flavour)}
transportModel  Newtonian;

nu              [0 2 -1 0 0 0 0] ${nu};

// Air 1.5e-05 · Water 1e-06 · Oil 1e-04  (kinematic viscosity, m^2/s)
`;
}

export function generateTurbulenceProperties(model: TurbulenceModel, flavour: Flavour): string {
  const object = turbulenceFileName(flavour);
  if (model === 'laminar') {
    return `${header('dictionary', object, 'constant', flavour)}
simulationType  laminar;
`;
  }
  // The key inside RAS{} was renamed too: RASModel → model.
  const key = flavour === 'modular' ? 'model' : 'RASModel';
  return `${header('dictionary', object, 'constant', flavour)}
simulationType  RAS;

RAS
{
    ${key}           ${model};

    turbulence      on;

    printCoeffs     on;
}
`;
}

export function generateGravity(value: string, flavour: Flavour): string {
  return `${header('uniformDimensionedVectorField', 'g', 'constant', flavour)}
dimensions      [0 1 -2 0 0 0 0];

value           ${value};
`;
}

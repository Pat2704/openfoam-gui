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

/** OpenFOAM 11+ — `foamRun -solver <name>`, names as in `lib*Solver.so`. */
export const SOLVER_MODULES: SolverChoice[] = [
  { value: 'incompressibleFluid', label: 'incompressibleFluid', desc: 'Incompressible, steady or transient (was simpleFoam / pimpleFoam)', transient: false },
  { value: 'isothermalFluid', label: 'isothermalFluid', desc: 'Compressible at fixed temperature (was rhoSimpleFoam)', transient: false, compressible: true },
  { value: 'fluid', label: 'fluid', desc: 'Compressible with energy and buoyancy (was buoyantFoam)', transient: true, compressible: true, buoyant: true },
  { value: 'incompressibleVoF', label: 'incompressibleVoF', desc: 'Two incompressible phases, VoF free surface (was interFoam)', transient: true, multiphase: true, buoyant: true },
  { value: 'compressibleVoF', label: 'compressibleVoF', desc: 'Two compressible phases, VoF (was compressibleInterFoam)', transient: true, multiphase: true, compressible: true, buoyant: true },
  { value: 'multicomponentFluid', label: 'multicomponentFluid', desc: 'Reacting / multi-species flow (was reactingFoam)', transient: true, compressible: true },
  { value: 'shockFluid', label: 'shockFluid', desc: 'High-Mach density-based (was sonicFoam / rhoCentralFoam)', transient: true, compressible: true },
  { value: 'solidDisplacement', label: 'solidDisplacement', desc: 'Linear-elastic stress analysis in a solid', transient: false },
];

/** OpenFOAM ≤ 10 — the solver is an executable named in controlDict. */
export const SOLVER_APPLICATIONS: SolverChoice[] = [
  { value: 'simpleFoam', label: 'simpleFoam', desc: 'Incompressible steady-state (RANS)', transient: false },
  { value: 'pimpleFoam', label: 'pimpleFoam', desc: 'Incompressible transient (PIMPLE)', transient: true },
  { value: 'pisoFoam', label: 'pisoFoam', desc: 'Incompressible transient (PISO)', transient: true },
  { value: 'icoFoam', label: 'icoFoam', desc: 'Incompressible laminar transient', transient: true },
  { value: 'rhoSimpleFoam', label: 'rhoSimpleFoam', desc: 'Compressible steady-state', transient: false, compressible: true },
  { value: 'rhoPimpleFoam', label: 'rhoPimpleFoam', desc: 'Compressible transient', transient: true, compressible: true },
  { value: 'interFoam', label: 'interFoam', desc: 'Incompressible two-phase (VOF)', transient: true, multiphase: true, buoyant: true },
  { value: 'buoyantSimpleFoam', label: 'buoyantSimpleFoam', desc: 'Compressible natural convection', transient: false, compressible: true, buoyant: true },
  { value: 'sonicFoam', label: 'sonicFoam', desc: 'High Mach compressible', transient: true, compressible: true },
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

export type PatchRole = 'inlet' | 'outlet' | 'wall' | 'empty';

export interface MeshPatch { name: string; role: PatchRole }

export interface MeshSpec {
  x0: number; x1: number;
  y0: number; y1: number;
  z0: number; z1: number;
  nx: number; ny: number; nz: number;
  /** blockMesh `scale`: vertices are multiplied by this, so 0.001 means mm. */
  scale: number;
  /** 2D case: the two z faces become an `empty` patch and nz is forced to 1. */
  twoD: boolean;
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
  const patches: MeshPatch[] = [
    { name: 'inlet', role: 'inlet' },
    { name: 'outlet', role: 'outlet' },
    { name: 'walls', role: 'wall' },
  ];
  if (m.twoD) patches.push({ name: 'frontAndBack', role: 'empty' });
  return patches;
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

  const xMin = '(0 4 7 3)';
  const xMax = '(1 2 6 5)';
  const yMin = '(0 1 5 4)';
  const yMax = '(3 7 6 2)';
  const zMin = '(0 3 2 1)';
  const zMax = '(4 5 6 7)';

  const wallFaces = m.twoD ? [yMin, yMax] : [yMin, yMax, zMin, zMax];

  const boundary = [
    block('inlet', 'patch', [xMin]),
    block('outlet', 'patch', [xMax]),
    block('walls', 'wall', wallFaces),
    ...(m.twoD ? [block('frontAndBack', 'empty', [zMin, zMax])] : []),
  ].join('\n\n');

  return `${header('dictionary', 'blockMeshDict', 'system')}
scale   ${num(m.scale)};

vertices
(
${vertices}
);

blocks
(
    hex (0 1 2 3 4 5 6 7) (${Math.max(1, Math.round(m.nx))} ${Math.max(1, Math.round(m.ny))} ${nz}) simpleGrading (1 1 1)
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

export interface BoundaryCondition { name: string; type: string; value: string }

export interface FieldConfig {
  fieldName: string;
  dimensions: string;
  internalField: string;
  boundaryConditions: BoundaryCondition[];
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
  if (f.fieldName === 'U') return 'volVectorField';
  return /^\s*(uniform\s*)?\(/.test(f.internalField) ? 'volVectorField' : 'volScalarField';
}

export function generateFieldFile(f: FieldConfig, flavour: Flavour): string {
  const bcs = f.boundaryConditions
    .filter(bc => bc.name.trim())
    .map(bc =>
      `    ${bc.name}\n    {\n        type            ${bc.type};\n` +
      (bc.value.trim() ? `        value           ${bc.value};\n` : '') +
      `    }`
    )
    .join('\n\n');

  return `${header(fieldClass(f), f.fieldName, '0', flavour)}
dimensions      ${f.dimensions};

internalField   ${f.internalField};

boundaryField
{
${bcs}
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
}

/**
 * The boundary condition a given field wants on a given kind of patch.
 *
 * Straight out of the incompressibleFluid tutorials: wall functions on walls
 * for the RAS fields, `calculated` for nut, `empty` wherever the mesh is empty.
 */
export function defaultBC(fieldName: string, patch: MeshPatch, ctx: FieldContext): BoundaryCondition {
  const at = (type: string, value = '') => ({ name: patch.name, type, value });
  if (patch.role === 'empty') return at('empty');

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
      if (patch.role === 'wall') return at('nutkWallFunction', 'uniform 0');
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

  const algorithm = o.transient
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

/** 11+ renamed both of the constant/ dictionaries the wizard writes. */
export function transportFileName(flavour: Flavour): string {
  return flavour === 'modular' ? 'physicalProperties' : 'transportProperties';
}

export function turbulenceFileName(flavour: Flavour): string {
  return flavour === 'modular' ? 'momentumTransport' : 'turbulenceProperties';
}

export function generateTransportProperties(nu: string, flavour: Flavour): string {
  const object = transportFileName(flavour);
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

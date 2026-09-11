/**
 * The system/ and constant/ files of a complete-guide case (OpenFOAM 13 and
 * 14), from the settings of ./physics.ts. The mesh dictionaries are
 * ../case-templates.ts and ../snappy-templates.ts; the 0/ fields ./boundary.ts.
 *
 * Each module's files follow its simplest tutorial in the installation survey
 * (docs/agent-log/module-spec.md), in the forms both versions accept (section
 * 0.3): exponent dimensions, `method scotch`, `viscosityModel constant`,
 * setFields for initial regions, explicit `value`s. Where the two versions
 * genuinely differ — the LES delta sub-dictionaries, the drift-flux and
 * mixture-viscosity coefficient dictionaries — the file is written for the
 * version in use (`major`).
 */

import { header, type MeshPatch } from '../case-templates';
import type { MeshStep } from '../snappy-templates';
import type { ModuleInfo, PhysicsKind } from './modules';
import { thermoTypeBlock, isRealThermo, type ThermoCombo } from './thermo';
import {
  TURBULENCE_FIELDS, alphaField, comboSupported, fieldNames, hasPrgh, thermoKeys, usesThermo,
  type FullPhysics, type InitialRegion, type ThermoProps,
} from './physics';
import { seedIncludeFiles, seedPhysicsFiles, tutorialPatches } from './seed';

export interface FullCase {
  major: number;
  module: ModuleInfo;
  phys: FullPhysics;
  transient: boolean;
  endTime: string;
  deltaT: string;
  writeInterval: string;
  patches: MeshPatch[];
}

export interface CaseFile { path: string; content: string }

const TWO_PHASE: PhysicsKind[] = ['vof', 'compressibleVof', 'driftFlux'];
const OPEN_ROLES = new Set(['outlet', 'pressureInlet', 'atmosphere', 'freestream']);

/** No patch fixes the pressure level: the solver needs a reference cell. */
export function closedDomain(patches: MeshPatch[]): boolean {
  return !patches.some(p => OPEN_ROLES.has(p.role));
}

function energyFields(c: ThermoCombo): string[] {
  return c.energy === 'sensibleEnthalpy' ? ['h'] : ['e'];
}

/** Fields whose initial values setFields changes: written as `<name>.orig`. */
export function regionFields(phys: FullPhysics): Set<string> {
  return new Set(phys.initialRegions.flatMap(r => Object.keys(r.values)));
}

// ── controlDict and friends ─────────────────────────────────────────────────

export function fullControlDict(c: FullCase): string {
  const t = c.phys.time;
  const twoPhase = TWO_PHASE.includes(c.module.physics);
  const adjust = c.transient && t.adjustTimeStep
    ? `\nadjustTimeStep  yes;\n\nmaxCo           ${t.maxCo};\n${twoPhase ? `\nmaxAlphaCo      ${t.maxAlphaCo};\n` : ''}\nmaxDeltaT       ${t.maxDeltaT};\n`
    : '';
  return `${header('dictionary', 'controlDict', 'system')}
solver          ${c.module.id};

startFrom       latestTime;

startTime       0;

stopAt          endTime;

endTime         ${c.endTime};

deltaT          ${c.deltaT};

writeControl    ${c.transient ? t.writeControl : 'timeStep'};

writeInterval   ${c.writeInterval};

purgeWrite      ${t.purgeWrite};

writeFormat     ${t.writeFormat};

writePrecision  6;

writeCompression off;

timeFormat      general;

timePrecision   6;

runTimeModifiable yes;
${adjust}`;
}

export function fullFunctions(c: FullCase): string | null {
  if (!c.phys.functions.length) return null;
  return `${header('dictionary', 'functions', 'system')}
${c.phys.functions.map(f => `#includeFunc ${f}`).join('\n')}
`;
}

/** The fields the solver solves, for #includeFunc residuals(...). */
export function solvedFields(c: FullCase): string[] {
  const kind = c.module.physics;
  const p = c.phys;
  const turb = p.simulationType === 'laminar' ? [] : (TURBULENCE_FIELDS[p.model] ?? []);
  switch (kind) {
    case 'incompressible': return ['p', 'U', ...turb];
    case 'isothermal': return [hasPrgh(kind, p) ? 'p_rgh' : 'p', 'U', ...turb];
    case 'thermal': case 'multicomponent':
      return [hasPrgh(kind, p) ? 'p_rgh' : 'p', 'U', ...energyFields(kind === 'multicomponent' ? p.mixture : p.fluid.combo), ...turb];
    case 'shock': return ['rho', 'U', 'e'];
    case 'vof': case 'driftFlux': return ['p_rgh', 'U', alphaField(p), ...turb];
    case 'compressibleVof': return ['p_rgh', 'U', 'T', alphaField(p), ...turb];
    case 'solidThermal': return ['e'];
    case 'solidMechanics': return ['D'];
    default: return [];
  }
}

export function fullDecomposeParDict(c: FullCase): string | null {
  if (!c.phys.decompose.enabled) return null;
  return `${header('dictionary', 'decomposeParDict', 'system')}
numberOfSubdomains ${Math.max(2, Math.round(c.phys.decompose.n))};

method          scotch;
`;
}

function vec(v: number[]): string {
  return `(${v.map(x => String(Number(Number(x).toFixed(10)))).join(' ')})`;
}

function zone(r: InitialRegion): string {
  const shape = r.shape === 'sphere'
    ? `        type        sphere;\n        centre      ${vec(r.centre)};\n        radius      ${r.radius};`
    : r.shape === 'cylinder'
      ? `        type        cylinder;\n        point1      ${vec(r.point1)};\n        point2      ${vec(r.point2)};\n        radius      ${r.radius};`
      : `        type        box;\n        box         ${vec(r.min)} ${vec(r.max)};`;
  const values = Object.entries(r.values).map(([f, v]) => `            ${f.padEnd(15)} ${v};`).join('\n');
  return `    ${r.name}\n    {\n${shape}\n\n        values\n        {\n${values}\n        }\n    }`;
}

/**
 * setFieldsDict, in the form the annotated caseDicts/preProcessing file shows
 * on both versions. v14 tutorials use a zonal internalField instead, which v13
 * refuses; setFields works on both (survey 0.3).
 */
export function fullSetFieldsDict(c: FullCase, defaults: Record<string, string>): string | null {
  if (!c.phys.initialRegions.length) return null;
  const fields = [...regionFields(c.phys)];
  return `${header('dictionary', 'setFieldsDict', 'system')}
defaultValues
{
${fields.map(f => `    ${f.padEnd(15)} ${(defaults[f] ?? '0').replace(/^uniform\s+/, '')};`).join('\n')}
}

zones
{
${c.phys.initialRegions.map(zone).join('\n\n')}
}
`;
}

/** Commands to run after the mesh, before the solver. */
export function prepSteps(c: FullCase): MeshStep[] {
  return c.phys.initialRegions.length ? [{ app: 'setFields', args: '', log: 'setFields' }] : [];
}

// ── fvSchemes ───────────────────────────────────────────────────────────────

export function fullFvSchemes(c: FullCase): string {
  const kind = c.module.physics;
  const p = c.phys;
  const steady = !c.transient;
  const b = steady ? 'bounded ' : '';
  const turb = p.simulationType === 'laminar' ? [] : (TURBULENCE_FIELDS[p.model] ?? []);
  const blocks = (ddt: string, div: string[], extra = '', laplacian = 'Gauss linear corrected', snGrad = 'corrected') => `${header('dictionary', 'fvSchemes', 'system')}
ddtSchemes
{
    default         ${ddt};
}

gradSchemes
{
    default         Gauss linear;
}

divSchemes
{
${div.map(l => `    ${l}`).join('\n')}
}

laplacianSchemes
{
    default         ${laplacian};
}

interpolationSchemes
{
    default         linear;
}

snGradSchemes
{
    default         ${snGrad};
}
${extra}`;
  const wallDist = '\nwallDist\n{\n    method          meshWave;\n}\n';
  const ddt = steady ? 'steadyState' : 'Euler';

  switch (kind) {
    case 'incompressible':
      return blocks(ddt, [
        'default         none;',
        `div(phi,U)      ${b}Gauss linearUpwind grad(U);`,
        ...turb.map(f => `div(phi,${f})${' '.repeat(Math.max(1, 8 - f.length))}${b}Gauss limitedLinear 1;`),
        'div((nuEff*dev2(T(grad(U))))) Gauss linear;',
        'div(nonlinearStress) Gauss linear;',
      ], wallDist);
    case 'isothermal': case 'thermal': case 'multicomponent': {
      const energy = kind === 'isothermal' ? [] : ['h', 'e'];
      return blocks(ddt, [
        'default         none;',
        `div(phi,U)      ${b}Gauss linearUpwind grad(U);`,
        ...energy.map(f => `div(phi,${f})      ${b}Gauss limitedLinear 1;`),
        `div(phi,K)      ${b}Gauss linear;`,
        `div(phi,Ekp)    ${b}Gauss linear;`,
        'div(phid,p)     Gauss limitedLinear 1;',
        'div(phi,(p|rho)) Gauss linear;',
        ...(kind === 'multicomponent' ? [`div(phi,Yi_h)   ${b}Gauss limitedLinear 1;`] : []),
        ...turb.map(f => `div(phi,${f})${' '.repeat(Math.max(1, 8 - f.length))}${b}Gauss limitedLinear 1;`),
        'div(((rho*nuEff)*dev2(T(grad(U))))) Gauss linear;',
        'div(nonlinearStress) Gauss linear;',
      ], wallDist);
    }
    case 'shock':
      // Density-based (forwardStep): the fluxes come from reconstruct(), not div().
      return `${header('dictionary', 'fvSchemes', 'system')}
fluxScheme      Kurganov;

ddtSchemes
{
    default         Euler;
}

gradSchemes
{
    default         Gauss linear;
}

divSchemes
{
    default         none;
}

laplacianSchemes
{
    default         Gauss linear corrected;
}

interpolationSchemes
{
    default         linear;

    reconstruct(rho) vanLeer;
    reconstruct(U)  vanLeerV;
    reconstruct(T)  vanLeer;
}

snGradSchemes
{
    default         corrected;
}
`;
    case 'vof':
      return blocks('Euler', [
        'div(phi,alpha)  Gauss interfaceCompression vanLeer 1;',
        'div(rhoPhi,U)   Gauss linearUpwind grad(U);',
        ...turb.map(f => `div(phi,${f})${' '.repeat(Math.max(1, 8 - f.length))}Gauss upwind;`),
        'div(((rho*nuEff)*dev2(T(grad(U))))) Gauss linear;',
      ], wallDist);
    case 'compressibleVof':
      return blocks('Euler', [
        'div(phi,alpha)  Gauss interfaceCompression vanLeer 1;',
        'div(rhoPhi,U)   Gauss linearUpwind grad(U);',
        // Each phase solves its own energy variable (e or h, from its thermoType).
        'div(alphaRhoPhi,e) Gauss upwind;',
        'div(alphaRhoPhi,h) Gauss upwind;',
        'div(alphaRhoPhi,T) Gauss upwind;',
        'div(rhoPhi,K)   Gauss upwind;',
        'div(phi,p)      Gauss upwind;',
        ...turb.map(f => `div(rhoPhi,${f})${' '.repeat(Math.max(1, 5 - f.length))}Gauss upwind;`),
        'div(((rho*nuEff)*dev2(T(grad(U))))) Gauss linear;',
      ], wallDist);
    case 'driftFlux':
      return blocks('Euler', [
        'default         none;',
        'div(rhoPhi,U)   Gauss linearUpwind grad(U);',
        'div(tauDm)      Gauss linear;',
        'div(phi,alpha)  Gauss vanLeer;',
        ...turb.map(f => `div(rhoPhi,${f})${' '.repeat(Math.max(1, 5 - f.length))}Gauss limitedLinear 1;`),
        'div(((rho*nuEff)*dev2(T(grad(U))))) Gauss linear;',
      ], wallDist);
    case 'solidThermal':
      return blocks(ddt, ['default         none;']);
    case 'solidMechanics':
      return `${header('dictionary', 'fvSchemes', 'system')}
d2dt2Schemes
{
    default         ${c.transient ? 'Euler' : 'steadyState'};
}

ddtSchemes
{
    default         Euler;
}

gradSchemes
{
    default         leastSquares;
}

divSchemes
{
    default         none;
    div(sigmaD)     Gauss linear;
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
    default         none;
}
`;
    default:
      return blocks(ddt, ['default         none;']);
  }
}

// ── fvSolution ──────────────────────────────────────────────────────────────

export function fullFvSolution(c: FullCase): string {
  const kind = c.module.physics;
  const p = c.phys;
  const steady = !c.transient;
  const closed = closedDomain(c.patches);
  const turb = p.simulationType === 'laminar' ? [] : (TURBULENCE_FIELDS[p.model] ?? []);
  const head = header('dictionary', 'fvSolution', 'system');

  switch (kind) {
    case 'incompressible': {
      const group = `"(U|${['k', 'epsilon', 'omega', 'nuTilda', 'v2', 'f'].join('|')})"`;
      const ref = closed ? '\n    pRefCell        0;\n    pRefValue       0;' : '';
      const algorithm = steady
        ? `SIMPLE
{
    nNonOrthogonalCorrectors 0;
    consistent      yes;${ref}

    residualControl
    {
        p               1e-3;
        U               1e-4;
        "(k|epsilon|omega|nuTilda|v2|f)" 1e-4;
    }
}

relaxationFactors
{
    equations
    {
        ".*"            0.9;
    }
}`
        : `PIMPLE
{
    nOuterCorrectors 1;
    nCorrectors     2;
    nNonOrthogonalCorrectors 0;${ref}
}`;
      return `${head}
solvers
{
    p
    {
        solver          GAMG;
        smoother        GaussSeidel;
        tolerance       1e-06;
        relTol          ${steady ? '0.1' : '0.01'};
    }

    pFinal
    {
        $p;
        relTol          0;
    }

    "pcorr.*"
    {
        solver          GAMG;
        smoother        GaussSeidel;
        tolerance       1e-06;
        relTol          0;
    }

    ${group}
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-05;
        relTol          ${steady ? '0.1' : '0.01'};
    }

    "(U|k|epsilon|omega|nuTilda|v2|f)Final"
    {
        $U;
        relTol          0;
    }
}

${algorithm}
`;
    }

    case 'isothermal': case 'thermal': case 'multicomponent': {
      const pn = hasPrgh(kind, p) ? 'p_rgh' : 'p';
      const energy = kind === 'isothermal' ? [] : ['h', 'e'];
      const group = `(U|${[...energy, 'k', 'epsilon', 'omega', 'nuTilda', 'v2', 'f'].join('|')})`;
      const ref = steady && closed ? `\n    pRefCell        0;\n    pRefValue       ${pn === 'p_rgh' ? '0' : p.p};` : '';
      const species = kind === 'multicomponent'
        ? `\n\n    "Yi.*"\n    {\n        solver          PBiCGStab;\n        preconditioner  DILU;\n        tolerance       1e-08;\n        relTol          0;\n    }`
        : '';
      const pimple = steady
        ? `PIMPLE
{
    momentumPredictor no;
    nNonOrthogonalCorrectors 0;${ref}

    residualControl
    {
        ${pn.padEnd(15)} 1e-4;
        U               1e-4;
        "(h|e)"         1e-4;
        "(k|epsilon|omega|nuTilda)" 1e-3;
    }
}

relaxationFactors
{
    fields
    {
        rho             1.0;
        ${pn.padEnd(15)} 0.7;
    }
    equations
    {
        U               0.3;
        "(h|e)"         0.3;
        "(k|epsilon|omega|nuTilda|v2|f|Yi.*)" 0.7;
    }
}`
        : `PIMPLE
{
    momentumPredictor yes;
    nOuterCorrectors 1;
    nCorrectors     2;
    nNonOrthogonalCorrectors 0;
}

relaxationFactors
{
    equations
    {
        ".*"            1;
    }
}`;
      return `${head}
solvers
{
    "rho.*"
    {
        solver          diagonal;
    }

    ${pn}
    {
        solver          GAMG;
        smoother        GaussSeidel;
        tolerance       1e-07;
        relTol          0.01;
    }

    ${pn}Final
    {
        $${pn};
        relTol          0;
    }

    "${group}"
    {
        solver          PBiCGStab;
        preconditioner  DILU;
        tolerance       1e-08;
        relTol          0.1;
    }

    "${group}Final"
    {
        $U;
        relTol          0;
    }${species}
}

${pimple}
`;
    }

    case 'shock':
      return `${head}
solvers
{
    "(rho|rhoU|rhoE).*"
    {
        solver          diagonal;
    }

    "U.*"
    {
        solver          smoothSolver;
        smoother        GaussSeidel;
        nSweeps         2;
        tolerance       1e-09;
        relTol          0.01;
    }

    "e.*"
    {
        $U;
        tolerance       1e-10;
        relTol          0;
    }
}

PIMPLE
{
    nOuterCorrectors 2;
}
`;

    case 'vof': case 'compressibleVof': {
      const alpha = alphaField(p);
      const ref = closed ? '\n    pRefCell        0;\n    pRefValue       0;' : '';
      const rho = kind === 'compressibleVof' ? '\n    ".*(rho|rhoFinal)"\n    {\n        solver          diagonal;\n    }\n' : '';
      return `${head}
solvers
{
    "${alpha.replace(/\./g, '\\.')}.*"
    {
        nCorrectors     2;
        nSubCycles      1;

        MULESCorr       yes;

        MULES
        {
            nIter           10;
            tolerance       1e-2;
        }

        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-8;
        relTol          0;
    }
${rho}
    "pcorr.*"
    {
        solver          PCG;
        preconditioner  DIC;
        tolerance       1e-5;
        relTol          0;
    }

    p_rgh
    {
        solver          PCG;
        preconditioner  DIC;
        tolerance       1e-7;
        relTol          0.05;
    }

    p_rghFinal
    {
        $p_rgh;
        relTol          0;
    }

    "(U|T|k|epsilon|omega|nuTilda).*"
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-6;
        relTol          0;
        minIter         1;
    }
}

PIMPLE
{
    momentumPredictor no;
    nOuterCorrectors 1;
    nCorrectors     3;
    nNonOrthogonalCorrectors 0;${ref}
}

relaxationFactors
{
    equations
    {
        ".*"            1;
    }
}
`;
    }

    case 'driftFlux':
      return `${head}
solvers
{
    "alpha.*"
    {
        nCorrectors     2;
        nSubCycles      1;
        MULESCorr       yes;
        alphaApplyPrevCorr yes;

        MULES
        {
            nIter           3;
            globalBounds    yes;
        }

        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-6;
        relTol          0;
        minIter         1;
    }

    "alpha.*Diffusion"
    {
        solver          PCG;
        preconditioner  DIC;
        tolerance       1e-8;
        relTol          0;
        minIter         1;
    }

    p_rgh
    {
        solver          GAMG;
        smoother        DIC;
        tolerance       1e-7;
        relTol          0.01;
    }

    p_rghFinal
    {
        $p_rgh;
        relTol          0;
    }

    pcorr
    {
        $p_rghFinal;
        tolerance       1e-3;
    }

    "(U|k|epsilon|omega)"
    {
        solver          PBiCGStab;
        preconditioner  DILU;
        tolerance       1e-6;
        relTol          0;
        minIter         1;
    }

    "(U|k|epsilon|omega)Final"
    {
        $U;
        relTol          0;
    }
}

PIMPLE
{
    momentumPredictor no;
    nCorrectors     3;
    nNonOrthogonalCorrectors 0;${closed ? '\n    pRefCell        0;\n    pRefValue       0;' : ''}
}

relaxationFactors
{
    equations
    {
        ".*"            1;
    }
}
`;

    case 'solidThermal':
      return `${head}
solvers
{
    e
    {
        solver          PCG;
        preconditioner  DIC;
        tolerance       1e-06;
        relTol          ${steady ? '0.01' : '0.1'};
    }

    eFinal
    {
        $e;
        relTol          0;
    }
}

PIMPLE
{
    nNonOrthogonalCorrectors 0;
}

relaxationFactors
{
    equations
    {
        ".*"            1;
    }
}
`;

    case 'solidMechanics':
      return `${head}
solvers
{
    "(D|e)"
    {
        solver          GAMG;
        tolerance       1e-06;
        relTol          0.9;
        smoother        GaussSeidel;
    }
}

PIMPLE
{
    compactNormalStress yes;
}
`;

    default:
      return `${head}\nsolvers\n{\n}\n`;
  }
}

// ── constant/ ───────────────────────────────────────────────────────────────

function coeffBlock(name: string, keys: string[], coeffs: Record<string, string>, indent: string): string {
  if (!keys.length) return '';
  return `${indent}${name}\n${indent}{\n${keys.map(k => `${indent}    ${k.padEnd(12)}${coeffs[k] ?? '0'};`).join('\n')}\n${indent}}\n`;
}

/** The body a pure fluid's (or specie's) properties need: specie, eos, thermodynamics, transport. */
function propertyBlocks(combo: ThermoCombo, coeffs: Record<string, string>, indent = '    '): string {
  const k = thermoKeys(combo);
  return [
    coeffBlock('specie', k.specie, coeffs, indent),
    coeffBlock('equationOfState', k.equationOfState, coeffs, indent),
    coeffBlock('thermodynamics', k.thermodynamics, coeffs, indent),
    coeffBlock('transport', k.transport, coeffs, indent),
  ].filter(Boolean).join('');
}

export function thermoPhysicalProperties(t: ThermoProps, object = 'physicalProperties', extra = ''): string {
  const body = t.combo.properties
    ? `mixture\n{\n    ${t.liquid || 'H2O'};\n}\n`
    : `mixture\n{\n${propertyBlocks(t.combo, t.coeffs)}}\n`;
  return `${header('dictionary', object, 'constant')}
${thermoTypeBlock(t.combo)}
${extra}
${body}`;
}

function uniformScalar(name: string, value: string): string {
  return `${name}\n{\n    type        uniform;\n    value       ${value};\n}\n`;
}

function momentumTransport(c: FullCase): string {
  const p = c.phys;
  const head = header('dictionary', 'momentumTransport', 'constant');
  if (p.simulationType === 'laminar') return `${head}\nsimulationType  laminar;\n`;
  const v14 = c.major >= 14;
  const sub = (n: string) => (v14 ? n : `${n}Coeffs`);
  if (p.simulationType === 'RAS') {
    const buoyant = p.model === 'buoyantKEpsilon' ? `\n    ${sub('buoyantKEpsilon')}\n    {\n        Cg              0.85;\n    }\n` : '';
    return `${head}
simulationType  RAS;

RAS
{
    model           ${p.model};

    turbulence      on;

    printCoeffs     on;
${buoyant}}
`;
  }
  // LES: every delta's sub-dictionary, as pitzDailyLES writes them, named for
  // the version in use (v13 <name>Coeffs, v14 <name>).
  const cube = `${sub('cubeRootVol')}\n        {\n            deltaCoeff      1;\n        }`;
  const dynamic = p.model === 'dynamicKEqn' ? `\n    ${sub('dynamicKEqn')}\n    {\n        filter          simple;\n    }\n` : '';
  return `${head}
simulationType  LES;

LES
{
    model           ${p.model};

    turbulence      on;

    printCoeffs     on;

    delta           ${p.delta};
${dynamic}
    ${sub('cubeRootVol')}
    {
        deltaCoeff      1;
    }

    ${sub('maxDeltaxyz')}
    {
        deltaCoeff      2;
    }

    ${sub('Prandtl')}
    {
        delta           cubeRootVol;
        ${cube}
        Cdelta          0.158;
    }

    ${sub('vanDriest')}
    {
        delta           cubeRootVol;
        ${cube}
        Aplus           26;
        Cdelta          0.158;
    }

    ${sub('smooth')}
    {
        delta           cubeRootVol;
        ${cube}
        maxDeltaRatio   1.1;
    }
}
`;
}

function uniformDimensioned(cls: string, name: string, dims: string, value: string): string {
  return `${header(cls, name, 'constant')}
dimensions      ${dims};

value           ${value};
`;
}

export function fullConstantFiles(c: FullCase): CaseFile[] {
  const p = c.phys;
  const kind = c.module.physics;
  const out: CaseFile[] = [];
  const add = (path: string, content: string) => out.push({ path, content });
  const gravity = () => add('constant/g', uniformDimensioned('uniformDimensionedVectorField', 'g', '[0 1 -2 0 0 0 0]', p.gravity));
  const pRef = () => add('constant/pRef', uniformDimensioned('uniformDimensionedScalarField', 'pRef', '[1 -1 -2 0 0 0 0]', p.p));
  const v14 = c.major >= 14;

  switch (kind) {
    case 'incompressible':
      add('constant/physicalProperties', `${header('dictionary', 'physicalProperties', 'constant')}\nviscosityModel  constant;\n\nnu              ${p.nu};\n`);
      break;
    case 'isothermal': case 'thermal': case 'shock':
      add('constant/physicalProperties', thermoPhysicalProperties(p.fluid, 'physicalProperties', hasPrgh(kind, p) ? `pRef            ${p.p};\n` : ''));
      if (hasPrgh(kind, p)) { gravity(); pRef(); }
      break;
    case 'multicomponent': {
      const species = p.species.map(s => `${s.name}\n{\n${propertyBlocks(p.mixture, s.coeffs)}}\n`).join('\n');
      add('constant/physicalProperties', `${header('dictionary', 'physicalProperties', 'constant')}
${thermoTypeBlock(p.mixture)}

species (${p.species.map(s => s.name).join(' ')});

defaultSpecie ${p.defaultSpecie};
${hasPrgh(kind, p) ? `\npRef            ${p.p};\n` : ''}
${species}`);
      if (hasPrgh(kind, p)) { gravity(); pRef(); }
      break;
    }
    case 'vof':
      add('constant/phaseProperties', `${header('dictionary', 'phaseProperties', 'constant')}\nphases          (${p.phases[0].name} ${p.phases[1].name});\n\nsigma           ${p.sigma};\n`);
      for (const ph of p.phases) {
        add(`constant/physicalProperties.${ph.name}`, `${header('dictionary', `physicalProperties.${ph.name}`, 'constant')}\nviscosityModel  constant;\n\nnu              ${ph.nu};\n\nrho             ${ph.rho};\n`);
      }
      gravity();
      break;
    case 'compressibleVof': {
      const liquid = p.phases[0].thermo.combo.properties === 'liquid';
      const sigma = liquid ? `sigma\n{\n    type    liquidProperties;\n    phase   ${p.phases[0].name};\n}\n` : `sigma           ${p.sigma};\n`;
      add('constant/phaseProperties', `${header('dictionary', 'phaseProperties', 'constant')}\nphases (${p.phases[0].name} ${p.phases[1].name});\n\n${sigma}`);
      for (const ph of p.phases) add(`constant/physicalProperties.${ph.name}`, thermoPhysicalProperties(ph.thermo, `physicalProperties.${ph.name}`));
      gravity();
      break;
    }
    case 'driftFlux': {
      const d = p.drift;
      const [disp, cont] = p.phases;
      const coeffName = v14 ? '"simple|general"' : '"(simple|general)Coeffs"';
      add('constant/phaseProperties', `${header('dictionary', 'phaseProperties', 'constant')}
phases (${disp.name} ${cont.name});

relativeVelocityModel ${d.model};

${coeffName}
{
    Vc              ${d.Vc};
    a               ${d.a};
    a1              ${d.a1};
    residualAlpha   ${d.residualAlpha};
}
`);
      const viscName = v14 ? '"plastic|BinghamPlastic"' : '"(plastic|BinghamPlastic)Coeffs"';
      const bingham = d.viscosity === 'BinghamPlastic'
        ? `\n    BinghamCoeff    ${d.BinghamCoeff};\n    BinghamExponent ${d.BinghamExponent};\n    BinghamOffset   ${d.BinghamOffset};\n` : '';
      add(`constant/physicalProperties.${disp.name}`, `${header('dictionary', `physicalProperties.${disp.name}`, 'constant')}
viscosityModel  ${d.viscosity};

${viscName}
{
    coeff           ${d.coeff};
    exponent        ${d.exponent};
${bingham}
    muMax           ${d.muMax};
}

rho             ${disp.rho};
`);
      add(`constant/physicalProperties.${cont.name}`, `${header('dictionary', `physicalProperties.${cont.name}`, 'constant')}\nviscosityModel  constant;\n\nnu              ${cont.nu};\n\nrho             ${cont.rho};\n`);
      gravity();
      break;
    }
    case 'solidThermal':
      add('constant/physicalProperties', `${header('dictionary', 'physicalProperties', 'constant')}
thermoType      constSolidThermo;

${uniformScalar('rho', p.solid.rho)}
${uniformScalar('Cv', p.solid.Cv)}
${uniformScalar('kappa', p.solid.kappa)}`);
      if (p.solid.heatSource.trim()) {
        add('constant/fvModels', `${header('dictionary', 'fvModels', 'constant')}
heatSource
{
    type            heatSource;

    cellZone        all;

    q               ${p.solid.heatSource};
}
`);
      }
      break;
    case 'solidMechanics': {
      const e = p.elastic;
      add('constant/physicalProperties', `${header('dictionary', 'physicalProperties', 'constant')}
${uniformScalar('rho', e.rho)}
${uniformScalar('nu', e.nu)}
${uniformScalar('E', e.E)}
${uniformScalar('Cv', e.Cv)}
${uniformScalar('kappa', e.kappa)}
${uniformScalar('alphav', e.alphav)}
planeStress     ${e.planeStress ? 'yes' : 'no'};
thermalStress   ${e.thermalStress ? 'yes' : 'no'};
`);
      break;
    }
  }

  if (!['solidThermal', 'solidMechanics'].includes(kind)) add('constant/momentumTransport', momentumTransport(c));
  return out;
}

export function fullFvConstraints(c: FullCase): string | null {
  if (!c.phys.limitPressure || !['isothermal', 'thermal', 'multicomponent'].includes(c.module.physics)) return null;
  return `${header('dictionary', 'fvConstraints', 'system')}
limitp
{
    type            limitPressure;

    minFactor       0.5;
    maxFactor       2;
}
`;
}

// ── Checks ──────────────────────────────────────────────────────────────────

const WORD = /^[A-Za-z][A-Za-z0-9_]*$/;
const isNum = (v: string | undefined) => v !== undefined && v.trim() !== '' && Number.isFinite(Number(v));

/**
 * What is wrong with the physics, in words. `tables` are the installation's
 * thermo tables (null before the index answers: nothing is claimed).
 */
export function fullProblems(c: FullCase, tables: Record<string, ThermoCombo[]> | null): string[] {
  const out: string[] = [];
  const p = c.phys;
  const kind = c.module.physics;
  if (c.module.transientOnly && !c.transient) out.push(`${c.module.id} only runs transient: choose a transient run.`);
  if (!c.module.steady && !c.transient) out.push(`${c.module.id} has no steady form.`);

  const checkThermo = (t: ThermoProps, what: string, table: string) => {
    const list = tables?.[table];
    if (list?.length && !isRealThermo(list, t.combo)) out.push(`${what}: this thermoType is not one the installation provides (${table}).`);
    if (!t.combo.properties && !comboSupported(t.combo)) out.push(`${what}: the wizard does not know the coefficients of this thermoType; choose another or edit the file by hand.`);
    for (const [, keys] of Object.entries(thermoKeys(t.combo))) {
      for (const k of keys) if (!isNum(t.coeffs[k])) out.push(`${what}: ${k} must be a number.`);
    }
  };
  if (usesThermo(kind) && kind !== 'multicomponent' && kind !== 'compressibleVof') {
    checkThermo(p.fluid, 'Fluid', kind === 'shock' ? 'psiThermo' : 'fluidThermo');
  }
  if (kind === 'compressibleVof') p.phases.forEach((ph, i) => checkThermo(ph.thermo, `Phase ${ph.name || i + 1}`, 'fluidThermo'));
  if (usesThermo(kind)) {
    if (!isNum(p.p) || Number(p.p) <= 0) out.push('The pressure must be a positive number of pascals.');
    if (!isNum(p.T) || Number(p.T) <= 0) out.push('The temperature must be a positive number of kelvin.');
  }
  if (kind === 'multicomponent') {
    const list = tables?.fluidMulticomponentThermo;
    if (list?.length && !isRealThermo(list, p.mixture)) out.push('Mixture: this thermoType is not one the installation provides (fluidMulticomponentThermo).');
    if (p.species.length < 2) out.push('A multicomponent mixture needs at least two species.');
    const names = p.species.map(s => s.name);
    if (names.some(n => !WORD.test(n))) out.push('Species names must be a letter followed by letters, digits or underscores.');
    if (new Set(names).size !== names.length) out.push('Two species have the same name.');
    if (!names.includes(p.defaultSpecie)) out.push('The default (inert) specie must be one of the species.');
    const sum = p.species.reduce((s, x) => s + (Number(x.initial) || 0), 0);
    if (Math.abs(sum - 1) > 1e-6) out.push(`The initial mass fractions add up to ${Number(sum.toPrecision(4))}, not 1.`);
    for (const s of p.species) for (const k of Object.values(thermoKeys(p.mixture)).flat()) if (!isNum(s.coeffs[k])) out.push(`${s.name}: ${k} must be a number.`);
  }
  if (TWO_PHASE.includes(kind)) {
    const [a, b] = p.phases;
    if (!WORD.test(a.name) || !WORD.test(b.name)) out.push('Phase names must be a letter followed by letters, digits or underscores.');
    if (a.name === b.name) out.push('The two phases need different names.');
    if (kind !== 'compressibleVof') for (const ph of p.phases) if (!isNum(ph.nu) || !isNum(ph.rho)) out.push(`${ph.name}: ν and ρ must be numbers.`);
  }
  if (kind === 'incompressible' && !isNum(p.nu)) out.push('The kinematic viscosity must be a number.');
  if (c.module.gravity !== 'none' && (hasPrgh(kind, p) || c.module.gravity === 'required') && !/^\(\s*-?[\d.eE+-]+\s+-?[\d.eE+-]+\s+-?[\d.eE+-]+\s*\)$/.test(p.gravity)) {
    out.push('Gravity must be a vector such as (0 -9.81 0).');
  }

  const fields = new Set(fieldNames(kind, p));
  for (const r of p.initialRegions) {
    if (!WORD.test(r.name)) out.push(`Initial region "${r.name}" must be a letter followed by letters, digits or underscores.`);
    if (!Object.keys(r.values).length) out.push(`Initial region ${r.name} sets no field.`);
    for (const f of Object.keys(r.values)) if (!fields.has(f)) out.push(`Initial region ${r.name} sets ${f}, which this case does not have.`);
  }

  const family = c.module.family;
  const allowed: Record<string, string[]> = {
    flow: ['inlet', 'outlet', 'wall', 'slipWall', 'movingWall', 'pressureInlet', 'atmosphere', 'freestream', 'symmetry', 'empty'],
    solidThermal: ['fixedTemperature', 'heatFlux', 'adiabatic', 'convection', 'symmetry', 'empty'],
    solidMechanics: ['fixedSupport', 'traction', 'tractionFree', 'fixedTemperature', 'adiabatic', 'symmetry', 'empty'],
  };
  const wrong = c.patches.filter(x => !allowed[family].includes(x.role));
  if (wrong.length) out.push(`These patches have a role ${c.module.id} cannot use: ${wrong.map(x => x.name).join(', ')}.`);
  if (family === 'flow' && c.patches.length && !c.patches.some(x => x.role === 'inlet' || x.role === 'pressureInlet' || x.role === 'movingWall' || x.role === 'atmosphere' || x.role === 'freestream')
    && !p.initialRegions.length && kind !== 'multicomponent' && !hasPrgh(kind, p)) {
    out.push('Nothing drives the flow: no inlet, moving wall or pressure boundary, no gravity-driven setup and no initial region.');
  }
  if (family === 'solidMechanics' && !c.patches.some(x => x.role === 'fixedSupport' || x.role === 'symmetry')) {
    out.push('Nothing holds the solid in place: give at least one patch a fixed support (or a symmetry plane).');
  }
  if (p.decompose.enabled && !(p.decompose.n >= 2)) out.push('Parallel decomposition needs at least 2 subdomains.');
  return out;
}

// ── Seeded from a tutorial ──────────────────────────────────────────────────

/** The physics files of a seeded case, with the user's edits applied. */
export function seededFiles(c: FullCase): { files: CaseFile[]; mentions: Record<string, string[]> } {
  const seed = c.phys.seed;
  if (!seed) return { files: [], mentions: {} };
  // Scan what will be written (with the user's edits), and only for tutorial
  // patch names this mesh does not have too.
  const own = new Set(c.patches.map(p => p.name));
  const names = tutorialPatches(seed.files).map(p => p.name).filter(n => !own.has(n));
  const edited = seed.files.map(f => ({ path: f.path, content: seed.overrides[f.path] ?? f.content }));
  const { keep, mentionsPatches } = seedPhysicsFiles(edited, names);
  const includes = seedIncludeFiles(seed.files).map(f => ({ path: f.path, content: seed.overrides[f.path] ?? f.content }));
  return { files: [...keep, ...includes], mentions: mentionsPatches };
}

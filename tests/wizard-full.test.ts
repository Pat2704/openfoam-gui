/**
 * The complete guide for OpenFOAM 13 and 14: which guide a version gets, the
 * modules offered, the fields and conditions each module's physics implies,
 * and the dictionaries written for it.
 *
 * Every module's defaults were also run end to end on both installations
 * (blockMesh + setFields + foamRun, sixteen variants); these tests pin the
 * rules those runs depend on, so a regression shows here rather than as a
 * FATAL error in someone's case.
 *
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MESH, meshPatches, typeForRole, type MeshPatch } from '../src/lib/case-templates.ts';
import { findModule, guideForVersion, modulesOffered } from '../src/lib/wizard/modules.ts';
import { fieldNames, physicsForModule, turbulenceChoices, turbulenceValues, type FullPhysics } from '../src/lib/wizard/physics.ts';
import { bcFor, buildFullField, internalValue } from '../src/lib/wizard/boundary.ts';
import {
  closedDomain, fullConstantFiles, fullControlDict, fullDecomposeParDict, fullFvSchemes, fullFvSolution,
  fullProblems, fullSetFieldsDict, prepSteps, regionFields, type FullCase,
} from '../src/lib/wizard/generate.ts';

const BOX = { min: [0, 0, 0] as [number, number, number], max: [1, 0.2, 0.02] as [number, number, number] };
const P = (name: string, role: MeshPatch['role']): MeshPatch => ({ name, role, type: typeForRole(role) });
const CHANNEL = meshPatches(DEFAULT_MESH);

function kase(module: string, over: Partial<FullCase> = {}, tweak?: (p: FullPhysics) => void): FullCase {
  const m = findModule(module)!;
  const phys = physicsForModule(m, BOX);
  tweak?.(phys);
  return { major: 14, module: m, phys, transient: m.transientOnly, endTime: '1', deltaT: '0.1', writeInterval: '1', patches: CHANNEL, ...over };
}

function ctxOf(c: FullCase) {
  return { kind: c.module.physics, phys: c.phys, turb: turbulenceValues(c.phys, 1, 0.014, 1e-5) };
}

describe('guide and modules', () => {
  test('the version decides the guide; the user does not', () => {
    assert.equal(guideForVersion(14), 'full');
    assert.equal(guideForVersion(13), 'full');
    assert.equal(guideForVersion(12), 'basic-modular');
    assert.equal(guideForVersion(11), 'basic-modular');
    assert.equal(guideForVersion(10), 'basic-legacy');
    assert.equal(guideForVersion(9), 'basic-legacy');
    assert.equal(guideForVersion(null), 'none');
    assert.equal(guideForVersion(8), 'none');
  });

  test('the installation\'s modules are offered; base classes are not, unknown ones start from a tutorial', () => {
    const offered = modulesOffered(['incompressibleFluid', 'fluid', 'VoFSolver', 'newModule']);
    assert.deepEqual(offered.map(m => m.id), ['incompressibleFluid', 'fluid', 'newModule']);
    assert.equal(offered[2].physics, 'tutorial');
    assert.ok(modulesOffered(null).length >= 19);
  });

  test('turbulence models: the known ones the installation also lists, per family', () => {
    const inc = turbulenceChoices('incompressible', { ras: ['kEpsilon', 'kOmegaSST', 'qZeta'], les: ['Smagorinsky'] });
    assert.deepEqual(inc.ras, ['kEpsilon', 'kOmegaSST']);
    assert.ok(turbulenceChoices('thermal', null).ras.includes('buoyantKEpsilon'));
    assert.ok(!turbulenceChoices('incompressible', null).ras.includes('buoyantKEpsilon'));
  });
});

describe('fields per module', () => {
  test('each physics names its fields', () => {
    const f = (m: string, t?: (p: FullPhysics) => void) => fieldNames(findModule(m)!.physics, (() => { const p = physicsForModule(findModule(m)!, BOX); t?.(p); return p; })());
    assert.deepEqual(f('incompressibleFluid'), ['U', 'p']);
    assert.deepEqual(f('fluid'), ['U', 'p', 'T', 'k', 'epsilon', 'nut', 'alphat']);
    assert.deepEqual(f('fluid', p => { p.buoyant = true; p.simulationType = 'laminar'; }), ['U', 'p', 'p_rgh', 'T']);
    assert.deepEqual(f('incompressibleVoF'), ['U', 'p_rgh', 'alpha.water']);
    assert.deepEqual(f('compressibleVoF'), ['U', 'p', 'p_rgh', 'T', 'alpha.water']);
    assert.deepEqual(f('incompressibleDriftFlux'), ['U', 'p_rgh', 'alpha.sludge', 'k', 'epsilon', 'nut']);
    assert.deepEqual(f('multicomponentFluid'), ['U', 'p', 'T', 'air', 'CO2', 'Ydefault']);
    assert.deepEqual(f('solid'), ['T']);
    assert.deepEqual(f('solidDisplacement'), ['D', 'T']);
    assert.deepEqual(f('incompressibleFluid', p => { p.simulationType = 'RAS'; p.model = 'v2f'; }), ['U', 'p', 'k', 'epsilon', 'v2', 'f', 'nut']);
  });
});

describe('boundary conditions', () => {
  test('incompressible channel: velocity inlet, pressure outlet, no-slip walls', () => {
    const c = kase('incompressibleFluid');
    const U = buildFullField('U', CHANNEL, ctxOf(c));
    const by = Object.fromEntries(U.boundaryConditions.map(b => [b.name, b.type]));
    assert.deepEqual(by, { inlet: 'fixedValue', outlet: 'zeroGradient', walls: 'noSlip', frontAndBack: 'empty' });
    assert.equal(bcFor('p', CHANNEL[1], ctxOf(c)).type, 'fixedValue');
  });

  test('every derived condition carries value, which 13 requires', () => {
    const c = kase('compressibleVoF', {}, p => { p.simulationType = 'RAS'; p.model = 'kEpsilon'; });
    const top = P('atmosphere', 'atmosphere');
    for (const f of fieldNames('compressibleVof', c.phys)) {
      const bc = bcFor(f, top, ctxOf(c));
      if (['inletOutlet', 'pressureInletOutletVelocity', 'prghTotalPressure', 'calculated', 'fixedValue'].includes(bc.type)) {
        assert.ok(bc.value, `${f}: ${bc.type} without value`);
      }
    }
    assert.deepEqual(bcFor('p_rgh', top, ctxOf(c)), { name: 'atmosphere', type: 'prghTotalPressure', value: '$internalField', extra: 'p0 $internalField' });
    assert.equal(bcFor('p', top, ctxOf(c)).type, 'calculated');
  });

  test('thermal walls and solids use externalTemperature on 13 and 14', () => {
    const fluid = kase('fluid', {}, p => { p.patchValues = { walls: { thermal: 'flux', q: '1000' } }; });
    assert.deepEqual(bcFor('T', CHANNEL[2], ctxOf(fluid)), { name: 'walls', type: 'externalTemperature', value: '$internalField', extra: 'q uniform 1000' });
    const solid = kase('solid', {}, p => { p.patchValues = { cooled: { h: '50', Ta: '290' } }; });
    assert.match(bcFor('T', P('cooled', 'convection'), ctxOf(solid)).extra ?? '', /h uniform 50\nTa constant 290/);
    assert.equal(bcFor('T', P('hot', 'fixedTemperature'), ctxOf(solid)).type, 'fixedValue');
  });

  test('solid mechanics: fixed supports and loads', () => {
    const c = kase('solidDisplacement', {}, p => { p.patchValues = { load: { traction: '(1e6 0 0)' } }; });
    assert.equal(bcFor('D', P('fixed', 'fixedSupport'), ctxOf(c)).type, 'fixedValue');
    assert.match(bcFor('D', P('load', 'traction'), ctxOf(c)).extra ?? '', /traction uniform \(1e6 0 0\)/);
  });

  test('wall functions for RAS, Spalding for Spalart-Allmaras, and the p_rgh starting level', () => {
    const c = kase('incompressibleFluid', {}, p => { p.simulationType = 'RAS'; p.model = 'SpalartAllmaras'; });
    assert.equal(bcFor('nut', CHANNEL[2], ctxOf(c)).type, 'nutUSpaldingWallFunction');
    assert.equal(bcFor('nuTilda', CHANNEL[2], ctxOf(c)).type, 'fixedValue');
    const k = kase('fluid');
    assert.equal(bcFor('alphat', CHANNEL[2], ctxOf(k)).type, 'compressible::alphatWallFunction');
    assert.equal(internalValue('p_rgh', ctxOf(kase('compressibleVoF'))), 'uniform 1e5');
    assert.equal(internalValue('p_rgh', ctxOf(kase('incompressibleVoF'))), 'uniform 0');
  });
});

describe('dictionaries', () => {
  test('controlDict names the module and carries the Courant limits for VoF', () => {
    const c = kase('incompressibleVoF');
    const d = fullControlDict(c);
    assert.match(d, /^solver\s+incompressibleVoF;$/m);
    assert.match(d, /^maxAlphaCo\s+1;$/m);
    assert.doesNotMatch(fullControlDict(kase('incompressibleFluid', { transient: false })), /adjustTimeStep/);
  });

  test('fvSchemes carries every key the module reads', () => {
    assert.match(fullFvSchemes(kase('compressibleVoF')), /div\(alphaRhoPhi,h\)/);
    assert.match(fullFvSchemes(kase('compressibleVoF')), /div\(alphaRhoPhi,e\)/);
    assert.match(fullFvSchemes(kase('fluid', { transient: false })), /div\(phi,h\)\s+bounded Gauss/);
    assert.match(fullFvSchemes(kase('incompressibleFluid')), /wallDist/);
    assert.match(fullFvSchemes(kase('shockFluid')), /fluxScheme\s+Kurganov;/);
    assert.match(fullFvSchemes(kase('solidDisplacement', { transient: false })), /div\(sigmaD\)/);
  });

  test('a closed incompressible domain gets a pressure reference', () => {
    const closed = [P('lid', 'movingWall'), P('fixedWalls', 'wall')];
    assert.equal(closedDomain(closed), true);
    assert.match(fullFvSolution(kase('incompressibleFluid', { patches: closed, transient: true })), /pRefCell\s+0;/);
    assert.doesNotMatch(fullFvSolution(kase('incompressibleFluid', { transient: true })), /pRefCell/);
  });

  test('the forms that differ between 13 and 14 are written for the version in use', () => {
    const les = (major: number) => fullConstantFiles(kase('incompressibleFluid', { major, transient: true }, p => { p.simulationType = 'LES'; p.model = 'dynamicKEqn'; }))
      .find(f => f.path === 'constant/momentumTransport')!.content;
    assert.match(les(13), /cubeRootVolCoeffs/);
    assert.match(les(13), /dynamicKEqnCoeffs/);
    assert.match(les(14), /^\s+cubeRootVol$/m);
    assert.doesNotMatch(les(14), /\b(cubeRootVol|dynamicKEqn|Prandtl|smooth|vanDriest|maxDeltaxyz)Coeffs\b/);
    const drift = (major: number) => fullConstantFiles(kase('incompressibleDriftFlux', { major })).find(f => f.path === 'constant/phaseProperties')!.content;
    assert.match(drift(13), /"\(simple\|general\)Coeffs"/);
    assert.match(drift(14), /"simple\|general"/);
  });

  test('buoyant compressible cases get g and pRef; VoF gets its phases', () => {
    const buoyant = fullConstantFiles(kase('fluid', {}, p => { p.buoyant = true; })).map(f => f.path);
    assert.ok(buoyant.includes('constant/g') && buoyant.includes('constant/pRef'));
    const vof = fullConstantFiles(kase('incompressibleVoF')).map(f => f.path);
    assert.deepEqual(vof.sort(), ['constant/g', 'constant/momentumTransport', 'constant/phaseProperties', 'constant/physicalProperties.air', 'constant/physicalProperties.water'].sort());
  });

  test('initial regions: setFieldsDict, .orig fields and a setFields step', () => {
    const c = kase('incompressibleVoF');
    assert.deepEqual([...regionFields(c.phys)], ['alpha.water']);
    const d = fullSetFieldsDict(c, { 'alpha.water': 'uniform 0' })!;
    assert.match(d, /defaultValues\s*\{\s*alpha\.water\s+0;/);
    assert.match(d, /waterColumn\s*\{\s*type\s+box;\s*box\s+\(.*\) \(.*\);\s*values\s*\{\s*alpha\.water\s+1;/);
    assert.deepEqual(prepSteps(c).map(s => s.app), ['setFields']);
    assert.equal(fullSetFieldsDict(kase('incompressibleFluid'), {}), null);
  });

  test('parallel runs: scotch, which needs no coefficients on either version', () => {
    assert.match(fullDecomposeParDict(kase('fluid', {}, p => { p.decompose = { enabled: true, n: 4 }; }))!, /numberOfSubdomains 4;\s*method\s+scotch;/);
  });
});

describe('fullProblems', () => {
  test('the defaults of every form module pass', () => {
    for (const id of ['incompressibleFluid', 'isothermalFluid', 'fluid', 'shockFluid', 'multicomponentFluid', 'incompressibleVoF', 'compressibleVoF', 'incompressibleDriftFlux']) {
      const c = kase(id, { transient: true });
      assert.deepEqual(fullProblems(c, null), [], id);
    }
    const solid = kase('solid', { transient: false, patches: [P('hot', 'fixedTemperature'), P('rest', 'adiabatic')] });
    assert.deepEqual(fullProblems(solid, null), []);
  });

  test('mistakes are reported', () => {
    const has = (c: FullCase, re: RegExp) => assert.ok(fullProblems(c, null).some(p => re.test(p)), re.source);
    has(kase('incompressibleVoF', { transient: false }), /only runs transient/);
    has(kase('multicomponentFluid', {}, p => { p.species[0].initial = '0.5'; }), /add up to 0\.5/);
    has(kase('solidDisplacement', { transient: false, patches: [P('load', 'traction')] }), /Nothing holds the solid/);
    has(kase('solid', { patches: CHANNEL }), /role solid cannot use/);
    has(kase('incompressibleVoF', {}, p => { p.phases[1].name = 'water'; }), /different names/);
  });
});

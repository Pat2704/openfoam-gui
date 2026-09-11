/**
 * Seeding a case from a tutorial: the tutorial's physics around the wizard's
 * patches. The sample is shaped like a multiphaseEuler bubble column (inlet,
 * outlet, walls, a regex entry, an #includeEtc) with a blockMeshDict.
 *
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPatch, seedField, seedFields, seedIncludeFiles, seedPhysicsFiles, tutorialPatches } from '../src/lib/wizard/seed.ts';
import { generateFieldFile } from '../src/lib/case-templates.ts';
import { seededFiles } from '../src/lib/wizard/generate.ts';
import { findModule } from '../src/lib/wizard/modules.ts';
import { DEFAULT_PHYSICS } from '../src/lib/wizard/physics.ts';

const BLOCK = `FoamFile { class dictionary; object blockMeshDict; }
vertices ((0 0 0)(1 0 0)(1 1 0)(0 1 0)(0 0 1)(1 0 1)(1 1 1)(0 1 1));
boundary
(
    inlet { type patch; faces ((1 5 4 0)); }
    outlet { type patch; faces ((3 7 6 2)); }
    walls { type wall; faces ((0 4 7 3) (2 6 5 1)); }
    defaultFaces { type empty; faces ((0 3 2 1) (4 5 6 7)); }
);`;

const ALPHA = `FoamFile { format ascii; class volScalarField; object alpha.air; }
dimensions      [0 0 0 0 0 0 0];
internalField   uniform 0;
boundaryField
{
    walls { type zeroGradient; }
    outlet { type inletOutlet; phi phi.air; inletValue uniform 1; value uniform 1; }
    inlet { type fixedValue; value uniform 0.5; }
    defaultFaces { type empty; }
}`;

const U = `FoamFile { format ascii; class volVectorField; object U.air; }
#include "include/initialConditions"
dimensions      [0 1 -1 0 0 0 0];
internalField   uniform (0 0.1 0);
boundaryField
{
    inlet { type fixedValue; value uniform (0 0.1 0); }
    outlet { type pressureInletOutletVelocity; phi phi.air; value $internalField; }
    walls { type fixedValue; value uniform (0 0 0); }
    #includeEtc "caseDicts/setConstraintTypes"
}`;

const FILES = [
  { path: 'system/blockMeshDict', content: BLOCK },
  { path: 'system/controlDict', content: 'solver multiphaseEuler;' },
  { path: 'system/fvSolution', content: 'solvers {}' },
  { path: 'system/setFieldsDict', content: 'regions ( boxToCell { box (0 0 0) (1 1 1); } );' },
  { path: 'constant/phaseProperties', content: 'phases (air water); type basicMultiphaseSystem;' },
  { path: 'constant/fvModels', content: 'massSource { patch inlet; }' },
  { path: '0/alpha.air', content: ALPHA },
  { path: '0/U.air', content: U },
  { path: '0/include/initialConditions', content: 'U0 (0 0.1 0);' },
];

const PATCHES = [
  { name: 'bottom', role: 'inlet' as const, type: 'patch' as const },
  { name: 'top', role: 'outlet' as const, type: 'patch' as const },
  { name: 'sides', role: 'wall' as const, type: 'wall' as const },
  { name: 'frontAndBack', role: 'empty' as const, type: 'empty' as const },
  { name: 'mirror', role: 'symmetry' as const, type: 'symmetryPlane' as const },
];

describe('seeding from a tutorial', () => {
  test('the tutorial patches and their roles', () => {
    assert.deepEqual(tutorialPatches(FILES), [
      { name: 'inlet', type: 'patch' }, { name: 'outlet', type: 'patch' },
      { name: 'walls', type: 'wall' }, { name: 'defaultFaces', type: 'empty' },
    ]);
    assert.equal(classifyPatch('inlet'), 'inlet');
    assert.equal(classifyPatch('movingWall', 'wall'), 'movingWall');
    assert.equal(classifyPatch('"(front|back)"', 'symmetryPlane'), 'symmetry');
    assert.equal(classifyPatch('mystery', 'patch'), null);
  });

  test('physics files are kept, mesh dictionaries dropped, patch mentions flagged', () => {
    const { keep, mentionsPatches } = seedPhysicsFiles(FILES, ['inlet', 'outlet', 'walls']);
    assert.deepEqual(keep.map(f => f.path), ['system/controlDict', 'system/fvSolution', 'system/setFieldsDict', 'constant/phaseProperties', 'constant/fvModels']);
    assert.deepEqual(mentionsPatches, { 'constant/fvModels': ['inlet'] });
    assert.deepEqual(seedIncludeFiles(FILES).map(f => f.path), ['0/include/initialConditions']);
  });

  test('each wizard patch takes the tutorial condition for its role', () => {
    const f = seedField(FILES[6], PATCHES, tutorialPatches(FILES))!;
    const by = Object.fromEntries(f.boundaryConditions.map(bc => [bc.name, bc]));
    assert.deepEqual(by.bottom, { name: 'bottom', type: 'fixedValue', value: 'uniform 0.5' });
    assert.equal(by.top.type, 'inletOutlet');
    assert.match(by.top.extra ?? '', /phi\s+phi\.air;[\s\S]*inletValue\s+uniform 1;/);
    assert.equal(by.sides.type, 'zeroGradient');
    assert.equal(by.frontAndBack.type, 'empty');
    assert.equal(by.mirror.type, 'symmetryPlane');
  });

  test('the field keeps its class, preamble and #includeEtc, and renders', () => {
    const [alpha, u] = seedFields(FILES, PATCHES);
    assert.equal(alpha.fieldName, 'alpha.air');
    assert.equal(u.cls, 'volVectorField');
    assert.match(u.preamble ?? '', /#include "include\/initialConditions"/);
    const text = generateFieldFile(u, 'modular');
    assert.match(text, /class\s+volVectorField;/);
    assert.match(text, /^#include "include\/initialConditions"$/m);
    assert.match(text, /#includeEtc "caseDicts\/setConstraintTypes"\n\}/);
    assert.match(text, /sides\n\s+\{\n\s+type\s+fixedValue;\n\s+value\s+uniform \(0 0 0\);/);
  });

  test('a flagged file is no longer flagged once edited; a patch name the mesh shares never is', () => {
    const base = { major: 14, module: findModule('multiphaseEuler')!, transient: true, endTime: '1', deltaT: '1', writeInterval: '1', patches: PATCHES };
    const withEdits = (overrides: Record<string, string>) => ({ ...base, phys: { ...DEFAULT_PHYSICS, seed: { tutorial: 'multiphaseEuler/x', files: FILES, overrides } } });
    assert.deepEqual(seededFiles(withEdits({})).mentions, { 'constant/fvModels': ['inlet'] });

    const fixed = seededFiles(withEdits({ 'constant/fvModels': 'massSource { patch bottom; }' }));
    assert.deepEqual(fixed.mentions, {});
    assert.match(fixed.files.find(f => f.path === 'constant/fvModels')!.content, /patch bottom/);

    const shared = seededFiles({ ...withEdits({}), patches: [...PATCHES, { name: 'inlet', role: 'inlet' as const, type: 'patch' as const }] });
    assert.deepEqual(shared.mentions, {});
  });
});

/**
 * The case generator writes files OpenFOAM has to accept.
 *
 * A bug here does not throw — it produces a case that dies inside blockMesh or
 * at solver startup with a message about a dictionary the user never wrote. The
 * two things worth pinning down are the version split (11+ reorganised how a
 * case is described, and a case written the old way simply does not run) and
 * the promise that the mesh and the 0/ files never disagree about patch names.
 *
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MESH,
  buildField,
  defaultBC,
  dimensionsFor,
  fieldClass,
  flavourForVersion,
  generateBlockMeshDict,
  generateControlDict,
  generateFieldFile,
  generateTransportProperties,
  generateTurbulenceProperties,
  meshPatches,
  meshProblems,
  runCommand,
  solverChoices,
  syncFieldPatches,
  transportFileName,
  turbulenceFieldNames,
  turbulenceFileName,
  type FieldContext,
  type MeshSpec,
  type SystemOptions,
} from '../src/lib/case-templates.ts';

const CTX: FieldContext = {
  inletVelocity: '(1 0 0)',
  k: 0.00375,
  epsilon: 0.000387,
  omega: 1.03,
  nu: 1e-5,
};

const sysOpts = (over: Partial<SystemOptions> = {}): SystemOptions => ({
  flavour: 'modular',
  solver: 'incompressibleFluid',
  transient: false,
  endTime: '500',
  deltaT: '1',
  writeInterval: '100',
  ...over,
} as SystemOptions);

describe('flavourForVersion', () => {
  test('11 and above are modular; 10 and below are legacy', () => {
    for (const v of [11, 12, 13, 14, 20]) assert.equal(flavourForVersion(v), 'modular');
    for (const v of [2, 7, 9, 10]) assert.equal(flavourForVersion(v), 'legacy');
  });

  test('an unknown version does not silently pick the layout that cannot run', () => {
    // Guessing wrong towards legacy writes `application simpleFoam;`, which 11+
    // ignores entirely; guessing modular at least matches every supported release.
    assert.equal(flavourForVersion(null), 'modular');
    assert.equal(flavourForVersion(undefined), 'modular');
    assert.equal(flavourForVersion(NaN), 'modular');
  });
});

describe('the version split', () => {
  test('the properties files are named differently on each side of 11', () => {
    assert.equal(transportFileName('modular'), 'physicalProperties');
    assert.equal(transportFileName('legacy'), 'transportProperties');
    assert.equal(turbulenceFileName('modular'), 'momentumTransport');
    assert.equal(turbulenceFileName('legacy'), 'turbulenceProperties');
  });

  test('controlDict names a solver on 11+ and an application on <=10', () => {
    const modular = generateControlDict(sysOpts({ flavour: 'modular', solver: 'incompressibleFluid' }));
    assert.match(modular, /^\s*solver\s+incompressibleFluid;/m);
    assert.doesNotMatch(modular, /^\s*application\s/m);

    const legacy = generateControlDict(sysOpts({ flavour: 'legacy', solver: 'simpleFoam' }));
    assert.match(legacy, /^\s*application\s+simpleFoam;/m);
    assert.doesNotMatch(legacy, /^\s*solver\s/m);
  });

  test('the RAS key is `model` on 11+ and `RASModel` on <=10', () => {
    assert.match(generateTurbulenceProperties('kEpsilon', 'modular'), /\bmodel\s+kEpsilon;/);
    assert.match(generateTurbulenceProperties('kEpsilon', 'legacy'), /\bRASModel\s+kEpsilon;/);
  });

  test('runCommand is foamRun on 11+ and the bare application on <=10', () => {
    // `foamRun` takes the solver from controlDict's `solver` entry, which the
    // generated controlDict always writes — so no -solver flag is needed.
    assert.equal(runCommand('modular', 'incompressibleFluid'), 'foamRun');
    assert.equal(runCommand('legacy', 'simpleFoam'), 'simpleFoam');
  });

  test('the controlDict a modular case gets is the one foamRun reads its solver from', () => {
    const d = generateControlDict(sysOpts({ flavour: 'modular', solver: 'incompressibleFluid' }));
    assert.match(d, /^\s*solver\s+incompressibleFluid;/m);
  });

  test('solverChoices offers each flavour its own list, and they do not overlap', () => {
    const modular = solverChoices('modular').map(s => s.value);
    const legacy = solverChoices('legacy').map(s => s.value);
    assert.ok(modular.length > 0 && legacy.length > 0);
    assert.ok(modular.includes('incompressibleFluid'));
    assert.ok(legacy.includes('simpleFoam'));
    assert.equal(modular.filter(v => legacy.includes(v)).length, 0);
  });
});

describe('dimensions are always written numerically', () => {
  // OpenFOAM 14 accepts named sets like [velocity] and its own tutorials use
  // them, but 13 dies in the dimensionSet lookup. The numeric form works on
  // every version from 9 to 14, so nothing generated here may use a name.
  test('every known field has a seven-exponent numeric set', () => {
    for (const f of ['U', 'p', 'p_rgh', 'k', 'epsilon', 'omega', 'nut', 'nuTilda', 'T', 'alphat']) {
      const d = dimensionsFor(f);
      assert.match(d, /^\[(-?\d+ ){6}-?\d+\]$/, `${f} -> ${d}`);
    }
  });

  test('an unknown field is dimensionless rather than undefined', () => {
    assert.equal(dimensionsFor('somethingElse'), '[0 0 0 0 0 0 0]');
  });

  test('no generated field file contains a named dimension set', () => {
    for (const name of ['U', 'p', 'k', 'epsilon', 'omega', 'nut']) {
      const f = buildField(name, meshPatches(DEFAULT_MESH), CTX, 'modular');
      const text = generateFieldFile(f, 'modular');
      assert.doesNotMatch(text, /dimensions\s+\[[a-zA-Z]/, `${name} used a named dimension set`);
    }
  });
});

describe('generateBlockMeshDict', () => {
  test('a 2D mesh forces nz to 1 and adds the empty patch', () => {
    const dict = generateBlockMeshDict({ ...DEFAULT_MESH, twoD: true, nz: 17 });
    assert.match(dict, /hex \(0 1 2 3 4 5 6 7\) \(60 20 1\)/);
    assert.match(dict, /frontAndBack[\s\S]*?type\s+empty;/);
  });

  test('a 3D mesh keeps nz, drops frontAndBack, and puts the z faces on the walls', () => {
    const dict = generateBlockMeshDict({ ...DEFAULT_MESH, twoD: false, nz: 8 });
    assert.match(dict, /hex \(0 1 2 3 4 5 6 7\) \(60 20 8\)/);
    assert.doesNotMatch(dict, /frontAndBack/);
    // walls must now carry four faces, not two.
    const walls = dict.slice(dict.indexOf('walls'));
    const faces = walls.slice(0, walls.indexOf('}')).match(/\(\d \d \d \d\)/g) ?? [];
    assert.equal(faces.length, 4);
  });

  test('every boundary face is wound so its normal points out of the block', () => {
    // The single most common hand-written blockMeshDict error, and one that
    // blockMesh reports only as "negative volume" much later.
    const dict = generateBlockMeshDict({ ...DEFAULT_MESH, twoD: false });
    const V: Record<number, [number, number, number]> = {
      0: [0, 0, 0], 1: [1, 0, 0], 2: [1, 1, 0], 3: [0, 1, 0],
      4: [0, 0, 1], 5: [1, 0, 1], 6: [1, 1, 1], 7: [0, 1, 1],
    };
    const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
    const cross = (a: number[], b: number[]) => [
      a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
    ];
    const centre = [0.5, 0.5, 0.5];

    const faces = [...dict.matchAll(/\((\d) (\d) (\d) (\d)\)/g)]
      .map(m => [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])])
      // The `hex (0 1 2 3 4 5 6 7)` line is eight numbers, not four, so it does
      // not match; every match here is a boundary face.
      .filter(f => f.length === 4);

    assert.ok(faces.length >= 6, 'expected at least the six box faces');
    for (const f of faces) {
      const p = f.map(i => V[i]);
      const n = cross(sub(p[1], p[0]), sub(p[2], p[1]));
      const faceCentre = [0, 1, 2].map(k => (p[0][k] + p[1][k] + p[2][k] + p[3][k]) / 4);
      const outward = sub(faceCentre, centre);
      const dot = n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2];
      assert.ok(dot > 0, `face (${f.join(' ')}) is wound inwards`);
    }
  });

  test('cell counts are coerced to at least one, so a cleared field cannot emit 0', () => {
    const dict = generateBlockMeshDict({ ...DEFAULT_MESH, twoD: false, nx: 0, ny: -5, nz: 0.4 });
    assert.match(dict, /hex \(0 1 2 3 4 5 6 7\) \(1 1 1\)/);
  });

  test('coordinates are written without floating-point noise', () => {
    const dict = generateBlockMeshDict({ ...DEFAULT_MESH, x1: 0.1 + 0.2 });
    assert.ok(dict.includes('0.3'), 'expected 0.3');
    assert.doesNotMatch(dict, /0\.30000000000000004/);
  });

  test('the declared patches are exactly what meshPatches promises', () => {
    for (const twoD of [true, false]) {
      const m: MeshSpec = { ...DEFAULT_MESH, twoD };
      const dict = generateBlockMeshDict(m);
      for (const p of meshPatches(m)) {
        assert.match(dict, new RegExp(`\\b${p.name}\\b`), `${p.name} missing from a ${twoD ? '2D' : '3D'} dict`);
      }
    }
  });
});

describe('fields and boundary conditions', () => {
  test('a built field carries one condition per mesh patch, in order', () => {
    for (const twoD of [true, false]) {
      const patches = meshPatches({ ...DEFAULT_MESH, twoD });
      const f = buildField('U', patches, CTX, 'modular');
      assert.deepEqual(f.boundaryConditions.map(bc => bc.name), patches.map(p => p.name));
    }
  });

  test('an empty patch gets the empty condition on every field', () => {
    const patches = meshPatches({ ...DEFAULT_MESH, twoD: true });
    for (const name of ['U', 'p', 'k', 'epsilon', 'omega', 'nut', 'T', 'unknownField']) {
      const bc = defaultBC(name, patches[patches.length - 1], CTX);
      assert.equal(bc.name, 'frontAndBack');
      assert.equal(bc.type, 'empty', `${name} on an empty patch`);
      assert.equal(bc.value, '', 'an empty patch must not carry a value');
    }
  });

  test('U is a vector field and p is a scalar field', () => {
    const patches = meshPatches(DEFAULT_MESH);
    assert.equal(fieldClass(buildField('U', patches, CTX, 'modular')), 'volVectorField');
    assert.equal(fieldClass(buildField('p', patches, CTX, 'modular')), 'volScalarField');
    assert.equal(fieldClass(buildField('k', patches, CTX, 'modular')), 'volScalarField');
  });

  test('U takes the inlet velocity and no-slip walls', () => {
    const patches = meshPatches(DEFAULT_MESH);
    const f = buildField('U', patches, CTX, 'modular');
    const by = Object.fromEntries(f.boundaryConditions.map(bc => [bc.name, bc]));
    assert.equal(by.inlet.type, 'fixedValue');
    assert.equal(by.inlet.value, 'uniform (1 0 0)');
    assert.equal(by.outlet.type, 'zeroGradient');
    assert.equal(by.walls.type, 'noSlip');
  });

  test('the RAS fields get wall functions on the walls', () => {
    const patches = meshPatches(DEFAULT_MESH);
    const wall = patches.find(p => p.role === 'wall')!;
    assert.equal(defaultBC('k', wall, CTX).type, 'kqRWallFunction');
    assert.equal(defaultBC('epsilon', wall, CTX).type, 'epsilonWallFunction');
    assert.equal(defaultBC('omega', wall, CTX).type, 'omegaWallFunction');
    assert.equal(defaultBC('nut', wall, CTX).type, 'nutkWallFunction');
  });

  test('turbulenceFieldNames matches what each model actually needs', () => {
    assert.deepEqual(turbulenceFieldNames('laminar'), []);
    for (const n of ['k', 'epsilon', 'nut']) assert.ok(turbulenceFieldNames('kEpsilon').includes(n));
    for (const n of ['k', 'omega', 'nut']) assert.ok(turbulenceFieldNames('kOmegaSST').includes(n));
    assert.ok(turbulenceFieldNames('SpalartAllmaras').includes('nuTilda'));
  });

  test('a generated field file is a complete dictionary', () => {
    const f = buildField('U', meshPatches(DEFAULT_MESH), CTX, 'modular');
    const text = generateFieldFile(f, 'modular');
    assert.match(text, /FoamFile/);
    assert.match(text, /class\s+volVectorField;/);
    assert.match(text, /object\s+U;/);
    assert.match(text, /dimensions\s+\[0 1 -1 0 0 0 0\];/);
    assert.match(text, /internalField\s+uniform \(0 0 0\);/);
    assert.match(text, /boundaryField\s*\{/);
    // Every brace closed.
    assert.equal((text.match(/\{/g) ?? []).length, (text.match(/\}/g) ?? []).length);
  });

  test('a condition with a blank name is dropped rather than written empty', () => {
    const f = buildField('p', meshPatches(DEFAULT_MESH), CTX, 'modular');
    f.boundaryConditions.push({ name: '   ', type: 'zeroGradient', value: '' });
    const text = generateFieldFile(f, 'modular');
    assert.doesNotMatch(text, /^\s{4}\s*$\n\s{4}\{/m);
  });
});

describe('syncFieldPatches', () => {
  test('keeps a condition the user edited for a patch that still exists', () => {
    const patches = meshPatches(DEFAULT_MESH);
    const f = buildField('U', patches, CTX, 'modular');
    f.boundaryConditions[0] = { name: 'inlet', type: 'flowRateInletVelocity', value: 'uniform 0.1' };

    const synced = syncFieldPatches(f, patches, CTX);
    const inlet = synced.boundaryConditions.find(bc => bc.name === 'inlet')!;
    assert.equal(inlet.type, 'flowRateInletVelocity', 'the user edit was overwritten');
  });

  test('adds a default for a new patch and drops one the mesh no longer has', () => {
    const threeD = meshPatches({ ...DEFAULT_MESH, twoD: false });
    const twoD = meshPatches({ ...DEFAULT_MESH, twoD: true });

    const f = buildField('U', threeD, CTX, 'modular');
    const toTwoD = syncFieldPatches(f, twoD, CTX);
    assert.deepEqual(toTwoD.boundaryConditions.map(bc => bc.name), twoD.map(p => p.name));
    assert.equal(toTwoD.boundaryConditions.find(bc => bc.name === 'frontAndBack')!.type, 'empty');

    const backTo3D = syncFieldPatches(toTwoD, threeD, CTX);
    assert.deepEqual(backTo3D.boundaryConditions.map(bc => bc.name), threeD.map(p => p.name));
    assert.doesNotMatch(JSON.stringify(backTo3D), /frontAndBack/);
  });

  test('the mesh and the field can never disagree about patch names', () => {
    // The invariant the wizard rests on: whatever the mesh becomes, every field
    // ends up with exactly that patch set.
    let f = buildField('k', meshPatches(DEFAULT_MESH), CTX, 'modular');
    for (const twoD of [false, true, false, true]) {
      const patches = meshPatches({ ...DEFAULT_MESH, twoD });
      f = syncFieldPatches(f, patches, CTX);
      assert.deepEqual(f.boundaryConditions.map(bc => bc.name).sort(), patches.map(p => p.name).sort());
    }
  });
});

describe('generateControlDict', () => {
  test('a steady run writes the steady numbers', () => {
    const d = generateControlDict(sysOpts({ transient: false, endTime: '500', deltaT: '1', writeInterval: '100' }));
    assert.match(d, /endTime\s+500;/);
    assert.match(d, /deltaT\s+1;/);
    assert.match(d, /writeInterval\s+100;/);
  });

  test('both flavours produce a balanced dictionary', () => {
    for (const flavour of ['modular', 'legacy'] as const) {
      const d = generateControlDict(sysOpts({ flavour, solver: flavour === 'modular' ? 'incompressibleFluid' : 'simpleFoam' }));
      assert.equal((d.match(/\{/g) ?? []).length, (d.match(/\}/g) ?? []).length, `${flavour} braces`);
      assert.match(d, /FoamFile/);
    }
  });
});

describe('meshProblems', () => {
  // The three ways a box can be nonsense, all of which used to reach blockMesh
  // instead of the wizard's summary step.
  test('a sane default mesh has nothing to report', () => {
    assert.deepEqual(meshProblems(DEFAULT_MESH), []);
  });

  test('catches a domain with no thickness on any axis', () => {
    // An emptied number input reads back as 0, which is how this happens.
    for (const [axis, over] of [['X', { x1: 0 }], ['Y', { y1: 0 }], ['Z', { z1: 0 }]] as const) {
      const problems = meshProblems({ ...DEFAULT_MESH, twoD: false, ...over });
      assert.ok(problems.some(p => p.includes('no thickness') && p.includes(axis)), `${axis}: ${problems.join(' | ')}`);
    }
  });

  test('catches an inverted domain, which makes every cell volume negative', () => {
    const problems = meshProblems({ ...DEFAULT_MESH, x0: 1, x1: 0 });
    assert.ok(problems.some(p => /inverted/.test(p)), problems.join(' | '));
  });

  test('refuses a cell count that would exhaust memory, and warns before that', () => {
    const huge = meshProblems({ ...DEFAULT_MESH, twoD: false, nx: 500, ny: 500, nz: 500 });
    assert.ok(huge.some(p => /out of memory/.test(p)), huge.join(' | '));

    const large = meshProblems({ ...DEFAULT_MESH, twoD: false, nx: 200, ny: 200, nz: 200 });
    assert.ok(large.some(p => /take a while/.test(p)), large.join(' | '));

    // A 2D case is nx*ny however big nz is, so it must not trip either.
    assert.deepEqual(meshProblems({ ...DEFAULT_MESH, twoD: true, nz: 9999 }), []);
  });

  test('rejects a non-positive scale, which multiplies every vertex', () => {
    for (const scale of [0, -1, NaN]) {
      const problems = meshProblems({ ...DEFAULT_MESH, scale });
      assert.ok(problems.some(p => /scale must be a positive number/.test(p)), `scale=${scale}`);
    }
  });

  test('rejects non-numeric bounds and cell counts', () => {
    assert.ok(meshProblems({ ...DEFAULT_MESH, x1: NaN }).some(p => /not numbers/.test(p)));
    assert.ok(meshProblems({ ...DEFAULT_MESH, nx: 0 }).some(p => /at least 1/.test(p)));
    assert.ok(meshProblems({ ...DEFAULT_MESH, ny: -3 }).some(p => /at least 1/.test(p)));
  });

  test('every problem reads as a sentence the user can act on', () => {
    const problems = meshProblems({ ...DEFAULT_MESH, x1: 0, y0: 5, y1: 1, scale: 0 });
    assert.ok(problems.length >= 3);
    for (const p of problems) assert.ok(p.length > 15 && p.endsWith('.'), `unhelpful: ${p}`);
  });
});

describe('generateTransportProperties', () => {
  test('carries the viscosity through in both flavours', () => {
    for (const flavour of ['modular', 'legacy'] as const) {
      assert.match(generateTransportProperties('1e-05', flavour), /nu\b[^;]*1e-05/);
    }
  });
});

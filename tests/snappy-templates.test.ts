/**
 * The snappyHexMesh dictionaries the wizard writes, and the checks around them.
 *
 * What is pinned here was read off the v13 and v14 installations: the utility is
 * surfaceFeatures (surfaceFeatureExtract is only a "superseded" script there),
 * the fluid point is insidePoint, the geometry lives in constant/geometry, the
 * dictionaries include the installation's .cfg and override only the user's
 * choices, and the steps run in a real workflow's order. A regression in any of
 * those produces a case that fails inside snappyHexMesh, minutes in.
 *
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MESH, buildField, meshPatches, type MeshSpec } from '../src/lib/case-templates.ts';
import {
  DEFAULT_SNAPPY,
  SNAPPY_CFG,
  SNAPPY_UNAVAILABLE,
  SURFACE_FEATURES_CFG,
  MESH_QUALITY_CFG,
  dictFile,
  effectiveBbox,
  featureFile,
  generateMeshQualityDict,
  generateSnappyHexMeshDict,
  generateSurfaceFeaturesDict,
  geometryFileName,
  meshStepCommand,
  meshSteps,
  newRefinementRegion,
  proposeBackground,
  proposeInsidePoint,
  proposeRefinementBox,
  referencedFile,
  snappyAvailability,
  snappyPatches,
  snappyProblems,
  surfaceGroupName,
  surfaceNameFromFile,
  type SnappySettings,
  type SnappySurface,
} from '../src/lib/snappy-templates.ts';
import { pointInBox } from '../src/lib/geometry.ts';

// motorBike.obj.gz's bounding box, as read from the v14 resource.
const BIKE = { min: [-0.291665, -0.350289, -4.232e-05], max: [1.75115, 0.332267, 1.35152] } as const;
const bikeBox = { min: [...BIKE.min], max: [...BIKE.max] } as { min: [number, number, number]; max: [number, number, number] };

function surface(over: Partial<SnappySurface> = {}): SnappySurface {
  return {
    name: 'motorBike', file: 'motorBike.obj.gz', units: 'm', minLevel: 2, maxLevel: 3, featureLevel: 3,
    role: 'wall', regionNames: [], regions: [], bbox: bikeBox, triangles: 331653, regionCount: 67, bytes: 3725646,
    ...over,
  };
}

function settings(over: Partial<SnappySettings> = {}): SnappySettings {
  return { ...DEFAULT_SNAPPY, surfaces: [surface()], ...over };
}

function background(): MeshSpec {
  return { ...DEFAULT_MESH, ...proposeBackground(bikeBox), twoD: false, scale: 1 };
}

describe('snappyAvailability', () => {
  test('offered on 13 and 14 when the installation has the .cfg files', () => {
    assert.deepEqual(snappyAvailability(13, []), { available: true, reason: null });
    assert.deepEqual(snappyAvailability(14, []), { available: true, reason: null });
  });

  test('any other or unknown version is refused with the fixed sentence', () => {
    for (const v of [9, 10, 11, 12, 15, null, NaN]) {
      const a = snappyAvailability(v as number | null, []);
      assert.equal(a.available, false, String(v));
      assert.ok(a.reason?.startsWith(SNAPPY_UNAVAILABLE), a.reason ?? '');
    }
  });

  test('a missing .cfg, or a check that could not run, is not "available"', () => {
    const missing = snappyAvailability(14, [SNAPPY_CFG]);
    assert.equal(missing.available, false);
    assert.match(missing.reason ?? '', /snappyHexMeshDict\.cfg/);
    assert.equal(snappyAvailability(14, null).available, false);
  });
});

describe('generateSnappyHexMeshDict', () => {
  const dict = generateSnappyHexMeshDict(settings());

  test('includes the installation .cfg and names the fluid point insidePoint', () => {
    assert.match(dict, new RegExp(`^#includeEtc "${SNAPPY_CFG}"$`, 'm'));
    assert.match(dict, /^\s+insidePoint \(-?[\d.]+ -?[\d.]+ -?[\d.]+\);$/m);
    assert.doesNotMatch(dict, /locationInMesh/);
  });

  test('is short: the .cfg defaults are not restated unless overridden', () => {
    for (const key of ['maxLocalCells', 'maxGlobalCells', 'nSmoothPatch', 'nRelaxIter', 'mergeTolerance', 'meshQualityControls', 'nCellsBetweenLevels']) {
      assert.doesNotMatch(dict, new RegExp(`\\b${key}\\b`), key);
    }
    assert.ok(dict.split('\n').length < 110, `${dict.split('\n').length} lines`);
    const tuned = generateSnappyHexMeshDict(settings({
      castellated: { ...DEFAULT_SNAPPY.castellated, nCellsBetweenLevels: 4 },
      snap: { ...DEFAULT_SNAPPY.snap, tolerance: 4 },
    }));
    assert.match(tuned, /nCellsBetweenLevels\s+4;/);
    assert.match(tuned, /tolerance\s+4;/);
  });

  test('geometry: triSurface named without .gz, features from surfaceFeatures, patches grouped', () => {
    assert.match(dict, /type triSurface;\s+file "motorBike\.obj";/);
    assert.doesNotMatch(dict, /motorBike\.obj\.gz/);
    assert.match(dict, /\{ file "motorBike\.eMesh"; level 3; \}/);
    assert.match(dict, /level \(2 3\);/);
    assert.match(dict, /inGroups \(motorBikeGroup\);/);
    assert.match(dict, /explicitFeatureSnap true;/);
  });

  test('regions become their own groups, types and levels', () => {
    const flange = surface({
      name: 'flange', file: 'flange.stl.gz', regionNames: ['patch1', 'patch2', 'patch3', 'patch4'],
      regions: [{ region: 'patch2', group: 'inlet', role: 'inlet', type: 'patch', minLevel: 3, maxLevel: null }],
    });
    const d = generateSnappyHexMeshDict(settings({ surfaces: [flange] }));
    assert.match(d, /regions\s*\{\s*patch2\s*\{\s*level \(3 3\);\s*patchInfo\s*\{\s*type patch;\s*inGroups \(inlet\);/);
    const patches = snappyPatches(settings({ surfaces: [flange] }));
    assert.deepEqual(patches.map(p => `${p.name}:${p.role}`), ['flangeGroup:wall', 'inlet:inlet']);
  });

  test('refinement regions of every shape, inside or outside', () => {
    const box = proposeRefinementBox(bikeBox, 3);
    const ball = { ...newRefinementRegion('ball', bikeBox, 2), shape: 'sphere' as const, mode: 'outside' as const };
    const tube = { ...newRefinementRegion('tube', bikeBox, 2), shape: 'cylinder' as const };
    const d = generateSnappyHexMeshDict(settings({ refinementRegions: [box, ball, tube] }));
    assert.match(d, /refinementBox\s*\{\s*type box;\s*min\s+\(/);
    assert.match(d, /ball\s*\{\s*type sphere;\s*centre \(.*\);\s*radius [\d.]+;/);
    assert.match(d, /tube\s*\{\s*type cylinder;\s*point1 \(.*\);\s*point2 \(.*\);\s*radius [\d.]+;/);
    assert.match(d, /ball\s*\{\s*mode\s+outside;\s*level\s+2;/);
  });

  test('layers on chosen surfaces and box patches; off by default', () => {
    assert.match(dict, /^addLayers\s+false;$/m);
    assert.doesNotMatch(dict, /nSurfaceLayers/);
    const on = generateSnappyHexMeshDict(settings({ layers: { ...DEFAULT_SNAPPY.layers, enabled: true, patches: ['motorBike', 'lowerWall'], nSurfaceLayers: 4 } }));
    assert.match(on, /^addLayers\s+true;$/m);
    assert.match(on, /"motorBike\(_\.\*\)\?"\s*\{\s*nSurfaceLayers 4;/);
    assert.match(on, /"lowerWall"\s*\{\s*nSurfaceLayers 4;/);
  });

  test('no features means implicit snapping, and snapping can be turned off', () => {
    const plain = generateSnappyHexMeshDict(settings({ surfaces: [surface({ featureLevel: 0 })] }));
    assert.doesNotMatch(plain, /eMesh/);
    assert.match(plain, /implicitFeatureSnap true;/);
    assert.match(generateSnappyHexMeshDict(settings({ snap: { ...DEFAULT_SNAPPY.snap, enabled: false } })), /^snap\s+false;$/m);
  });
});

describe('units and the other dictionaries', () => {
  test('a geometry in millimetres is scaled first and the dictionaries use the copy', () => {
    const mm = surface({ units: 'mm' });
    assert.equal(dictFile(mm), 'motorBike_m.obj');
    assert.equal(featureFile(mm), 'motorBike_m.eMesh');
    assert.deepEqual(effectiveBbox(mm)!.max.map(v => Number(v.toFixed(8))), BIKE.max.map(v => Number((v * 0.001).toFixed(8))));
    const steps = meshSteps(settings({ surfaces: [mm] }));
    assert.equal(meshStepCommand(steps[0]),
      'surfaceTransformPoints "scale=(0.001 0.001 0.001)" constant/geometry/motorBike.obj.gz constant/geometry/motorBike_m.obj');
    assert.match(generateSnappyHexMeshDict(settings({ surfaces: [mm] })), /file "motorBike_m\.obj";/);
  });

  test('surfaceFeaturesDict includes its .cfg and lists the surfaces that want features', () => {
    const d = generateSurfaceFeaturesDict(settings({ surfaces: [surface(), surface({ name: 'wing', file: 'wing.stl', featureLevel: 0 })] }));
    assert.match(d, new RegExp(`#includeEtc "${SURFACE_FEATURES_CFG}"`));
    assert.match(d, /surfaces\s*\(\s*"motorBike\.obj"\s*\);/);
    assert.doesNotMatch(d, /wing/);
    assert.doesNotMatch(d, /surfaceFeatureExtract/);
  });

  test('meshQualityDict includes its .cfg and adds only overrides', () => {
    assert.match(generateMeshQualityDict(), new RegExp(`#includeEtc "${MESH_QUALITY_CFG}"`));
    assert.doesNotMatch(generateMeshQualityDict(settings()), /maxNonOrtho/);
    assert.match(generateMeshQualityDict(settings({ quality: { ...DEFAULT_SNAPPY.quality, maxNonOrtho: 70 } })), /^maxNonOrtho\s+70;$/m);
  });
});

describe('names', () => {
  test('a surface name is an OpenFOAM word, unique', () => {
    assert.equal(surfaceNameFromFile('motorBike.obj.gz'), 'motorBike');
    assert.equal(surfaceNameFromFile('C:\\cad\\3d part (v2).STL'), 'surface_3d_part_v2');
    assert.equal(surfaceNameFromFile('wing.stl', ['wing']), 'wing_2');
    assert.equal(surfaceNameFromFile('wing.stl', ['wing', 'wing_2']), 'wing_3');
  });

  test('file names keep the extension and compression; dictionaries drop .gz', () => {
    assert.equal(geometryFileName('motorBike', 'Motor Bike.OBJ.GZ'), 'motorBike.obj.gz');
    assert.equal(geometryFileName('wing', 'wing.stl'), 'wing.stl');
    assert.equal(referencedFile('motorBike.obj.gz'), 'motorBike.obj');
    assert.equal(featureFile(surface()), 'motorBike.eMesh');
  });

  test('the body patches reach every 0/ file as one group with wall conditions', () => {
    const s = settings();
    const patches = [...meshPatches({ ...DEFAULT_MESH, twoD: false }), ...snappyPatches(s)];
    assert.deepEqual(snappyPatches(s), [{ name: surfaceGroupName('motorBike'), role: 'wall', type: 'wall' }]);
    const ctx = { inletVelocity: '(1 0 0)', k: 0.1, epsilon: 0.1, omega: 1, nu: 1e-5 };
    const U = buildField('U', patches, ctx, 'modular');
    assert.equal(U.boundaryConditions.find(bc => bc.name === 'motorBikeGroup')?.type, 'noSlip');
    assert.equal(snappyPatches(null).length, 0);
  });

  test('the mesh sequence follows the real workflow', () => {
    assert.deepEqual(meshSteps(null).map(s => s.app), ['blockMesh', 'checkMesh']);
    assert.deepEqual(meshSteps(settings()).map(s => s.app), ['surfaceFeatures', 'blockMesh', 'snappyHexMesh', 'checkMesh']);
    assert.deepEqual(meshSteps(settings({ surfaces: [surface({ featureLevel: 0 })] })).map(s => s.app), ['blockMesh', 'snappyHexMesh', 'checkMesh']);
  });
});

describe('proposals', () => {
  test('external: room upstream and a longer wake, in cubic cells', () => {
    const m = background();
    const L = BIKE.max[0] - BIKE.min[0];
    assert.ok(BIKE.min[0] - m.x0 >= L * 0.99, 'one body length upstream');
    assert.ok(m.x1 - BIKE.max[0] >= 3 * L * 0.99, 'three downstream');
    const h = [(m.x1 - m.x0) / m.nx, (m.y1 - m.y0) / m.ny, (m.z1 - m.z0) / m.nz];
    assert.ok(Math.max(...h) / Math.min(...h) < 1.0001, h.join(' '));
  });

  test('internal: a small margin, finer cells, the box still encloses the geometry', () => {
    const m = { ...DEFAULT_MESH, ...proposeBackground(bikeBox, 'internal'), twoD: false };
    for (let a = 0; a < 3; a++) {
      const [lo, hi] = [[m.x0, m.x1], [m.y0, m.y1], [m.z0, m.z1]][a];
      assert.ok(lo < BIKE.min[a] && hi > BIKE.max[a]);
      assert.ok(BIKE.min[a] - lo < 0.25, 'margin stays small');
    }
    assert.ok(m.nx > 20);
  });

  test('the proposed insidePoint: outside the body for external, inside for internal', () => {
    const m = background();
    const p = proposeInsidePoint(m, bikeBox);
    assert.equal(pointInBox(p, { min: [m.x0, m.y0, m.z0], max: [m.x1, m.y1, m.z1] }), true);
    assert.equal(pointInBox(p, bikeBox), false);
    // A ring: the centre of its box is not inside it, the search finds a point that is.
    const ring = (q: number[]) => { const r = Math.hypot(q[0], q[1]); return r > 0.6 && r < 1 && Math.abs(q[2]) < 0.2; };
    const ringBox = { min: [-1, -1, -0.2], max: [1, 1, 0.2] } as { min: [number, number, number]; max: [number, number, number] };
    const inside = proposeInsidePoint(m, ringBox, 'internal', ring);
    assert.equal(ring(inside), true, inside.join(' '));
  });

  test('the refinement box wraps the body and its near wake one level below the surface', () => {
    const r = proposeRefinementBox(bikeBox, 3);
    assert.equal(r.level, 2);
    for (let a = 0; a < 3; a++) assert.ok(r.min[a] < BIKE.min[a] && r.max[a] > BIKE.max[a]);
  });
});

describe('snappyProblems', () => {
  test('the proposed setup passes', () => {
    const m = background();
    assert.deepEqual(snappyProblems(settings({ insidePoint: proposeInsidePoint(m, bikeBox) }), m), []);
  });

  test('each mistake is reported', () => {
    const m = background();
    const ok = settings({ insidePoint: proposeInsidePoint(m, bikeBox) });
    const has = (s: SnappySettings, mesh: MeshSpec, re: RegExp, body: string | null = null, box: string[] = []) =>
      assert.ok(snappyProblems(s, mesh, body, box).some(p => re.test(p)), re.source);

    has(settings({ surfaces: [] }), m, /No geometry/);
    has({ ...ok, insidePoint: [100, 0, 0] }, m, /outside the background box/);
    has(ok, { ...m, twoD: true }, /3D mesh/);
    has(ok, { ...m, scale: 0.001 }, /scale to 1/);
    has({ ...ok, surfaces: [surface({ minLevel: 4, maxLevel: 2 })] }, m, /above the maximum/);
    has({ ...ok, surfaces: [surface({ name: 'my body' })] }, m, /must be a letter/);
    has(ok, { ...m, x1: 1 }, /can only mesh inside it/);
    has({ ...ok, flow: 'internal' }, { ...m, x1: 1 }, /enclose the whole geometry/);
    has(ok, { ...m, nx: m.nx * 4 }, /stretched cells stay stretched/);
    has(ok, m, /inside the geometry/, 'insidePoint is inside the geometry.');
    has({ ...ok, refinementRegions: [{ ...newRefinementRegion('r', null), min: [1, 0, 0], max: [0, 1, 1] }] }, m, /max above min/);
    has({ ...ok, layers: { ...DEFAULT_SNAPPY.layers, enabled: true, patches: [] } }, m, /no surface or patch is chosen/);
    has({ ...ok, surfaces: [surface({ regionNames: ['a'], regions: [{ region: 'b', group: 'inlet', role: 'inlet', type: 'patch', minLevel: null, maxLevel: null }] })] }, m, /no region "b"/);
    has(ok, m, /both a box patch and a surface group/, null, ['motorBikeGroup']);
  });
});

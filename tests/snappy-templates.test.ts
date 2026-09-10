/**
 * The snappyHexMesh dictionaries the wizard writes, and the checks around them.
 *
 * What is pinned here was read off the v13 and v14 installations: the utility is
 * surfaceFeatures (surfaceFeatureExtract is only a "superseded" script there),
 * the fluid point is insidePoint, the geometry lives in constant/geometry, and
 * the dictionaries include the installation's .cfg and override only the user's
 * choices. A regression in any of those produces a case that fails inside
 * snappyHexMesh, minutes in.
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
  featureFile,
  generateMeshQualityDict,
  generateSnappyHexMeshDict,
  generateSurfaceFeaturesDict,
  geometryFileName,
  meshSteps,
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
} from '../src/lib/snappy-templates.ts';
import { pointInBox } from '../src/lib/geometry.ts';

// motorBike.obj.gz's bounding box, as read from the v14 resource.
const BIKE = { min: [-0.291665, -0.350289, -4.232e-05], max: [1.75115, 0.332267, 1.35152] } as const;
const bikeBox = { min: [...BIKE.min], max: [...BIKE.max] } as { min: [number, number, number]; max: [number, number, number] };

function settings(over: Partial<SnappySettings> = {}): SnappySettings {
  return {
    ...DEFAULT_SNAPPY,
    surfaces: [{
      name: 'motorBike', file: 'motorBike.obj.gz', minLevel: 2, maxLevel: 3, featureLevel: 3,
      bbox: bikeBox, triangles: 663306, regions: 67, bytes: 3725646,
    }],
    ...over,
  };
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

  test('is short: the .cfg defaults are not restated', () => {
    for (const key of ['maxLocalCells', 'maxGlobalCells', 'nSmoothPatch', 'nRelaxIter', 'mergeTolerance', 'meshQualityControls']) {
      assert.doesNotMatch(dict, new RegExp(`\\b${key}\\b`), key);
    }
    assert.ok(dict.split('\n').length < 110, `${dict.split('\n').length} lines`);
  });

  test('geometry: triSurface named without .gz, features from surfaceFeatures, patches grouped', () => {
    assert.match(dict, /type triSurface;\s+file "motorBike\.obj";/);
    assert.doesNotMatch(dict, /motorBike\.obj\.gz/);
    assert.match(dict, /\{ file "motorBike\.eMesh"; level 3; \}/);
    assert.match(dict, /level \(2 3\);/);
    assert.match(dict, /inGroups \(motorBikeGroup\);/);
    assert.match(dict, /explicitFeatureSnap true;/);
  });

  test('the user choices: layers, the refinement box, no features', () => {
    const off = generateSnappyHexMeshDict(settings());
    assert.match(off, /^addLayers\s+false;$/m);
    assert.doesNotMatch(off, /nSurfaceLayers/);
    assert.doesNotMatch(off, /refinementBox/);

    const on = generateSnappyHexMeshDict(settings({
      addLayers: true, nSurfaceLayers: 4,
      refinementBox: { enabled: true, min: [-1, -1, 0], max: [5, 1, 2], level: 2 },
    }));
    assert.match(on, /^addLayers\s+true;$/m);
    assert.match(on, /"motorBike\(_\.\*\)\?"\s*\{\s*nSurfaceLayers 4;/);
    assert.match(on, /refinementBox\s*\{\s*type box;\s*min\s+\(-1 -1 0\);\s*max\s+\(5 1 2\);/);
    assert.match(on, /refinementBox\s*\{\s*mode\s+inside;\s*level\s+2;/);

    const plain = generateSnappyHexMeshDict(settings({
      surfaces: [{ ...settings().surfaces[0], featureLevel: 0 }],
    }));
    assert.doesNotMatch(plain, /eMesh/);
    assert.match(plain, /implicitFeatureSnap true;/);
  });
});

describe('the other two dictionaries', () => {
  test('surfaceFeaturesDict includes its .cfg and lists the surfaces by referenced name', () => {
    const d = generateSurfaceFeaturesDict(settings());
    assert.match(d, new RegExp(`#includeEtc "${SURFACE_FEATURES_CFG}"`));
    assert.match(d, /surfaces\s*\(\s*"motorBike\.obj"\s*\);/);
    assert.match(d, /object\s+surfaceFeaturesDict;/);
    assert.doesNotMatch(d, /surfaceFeatureExtract/);
  });

  test('meshQualityDict exists because the snappy .cfg includes it from the case', () => {
    assert.match(generateMeshQualityDict(), new RegExp(`#includeEtc "${MESH_QUALITY_CFG}"`));
  });
});

describe('names', () => {
  test('a surface name is an OpenFOAM word, unique, never the refinement box', () => {
    assert.equal(surfaceNameFromFile('motorBike.obj.gz'), 'motorBike');
    assert.equal(surfaceNameFromFile('C:\\cad\\3d part (v2).STL'), 'surface_3d_part_v2');
    assert.equal(surfaceNameFromFile('wing.stl', ['wing']), 'wing_2');
    assert.equal(surfaceNameFromFile('wing.stl', ['wing', 'wing_2']), 'wing_3');
    assert.equal(surfaceNameFromFile('refinementBox.stl'), 'refinementBox_2');
  });

  test('file names keep the extension and compression; dictionaries drop .gz', () => {
    assert.equal(geometryFileName('motorBike', 'Motor Bike.OBJ.GZ'), 'motorBike.obj.gz');
    assert.equal(geometryFileName('wing', 'wing.stl'), 'wing.stl');
    assert.equal(referencedFile('motorBike.obj.gz'), 'motorBike.obj');
    assert.equal(featureFile('motorBike.obj.gz'), 'motorBike.eMesh');
    assert.equal(featureFile('wing.stlb'), 'wing.eMesh');
  });

  test('the body patches reach every 0/ file as one group with wall conditions', () => {
    const s = settings();
    const patches = [...meshPatches({ ...DEFAULT_MESH, twoD: false }), ...snappyPatches(s)];
    assert.deepEqual(snappyPatches(s), [{ name: surfaceGroupName('motorBike'), role: 'wall' }]);
    const ctx = { inletVelocity: '(1 0 0)', k: 0.1, epsilon: 0.1, omega: 1, nu: 1e-5 };
    const U = buildField('U', patches, ctx, 'modular');
    assert.equal(U.boundaryConditions.find(bc => bc.name === 'motorBikeGroup')?.type, 'noSlip');
    assert.equal(snappyPatches(null).length, 0);
  });

  test('the mesh sequence', () => {
    assert.deepEqual(meshSteps(null), ['blockMesh', 'checkMesh']);
    assert.deepEqual(meshSteps(settings()), ['blockMesh', 'surfaceFeatures', 'snappyHexMesh', 'checkMesh']);
  });
});

describe('proposals', () => {
  test('the background box holds the body with room upstream and a longer wake, in cubic cells', () => {
    const m = background();
    const L = BIKE.max[0] - BIKE.min[0];
    assert.ok(BIKE.min[0] - m.x0 >= L * 0.99, 'one body length upstream');
    assert.ok(m.x1 - BIKE.max[0] >= 3 * L * 0.99, 'three downstream');
    for (const [lo, hi, a] of [[m.y0, m.y1, 1], [m.z0, m.z1, 2]] as const) {
      assert.ok(BIKE.min[a] - lo >= L * 0.99 && hi - BIKE.max[a] >= L * 0.99);
    }
    const h = [(m.x1 - m.x0) / m.nx, (m.y1 - m.y0) / m.ny, (m.z1 - m.z0) / m.nz];
    assert.ok(Math.max(...h) / Math.min(...h) < 1.0001, h.join(' '));
  });

  test('the proposed insidePoint is in the box and clear of the body', () => {
    const m = background();
    const p = proposeInsidePoint(m, bikeBox);
    assert.equal(pointInBox(p, { min: [m.x0, m.y0, m.z0], max: [m.x1, m.y1, m.z1] }), true);
    assert.equal(pointInBox(p, bikeBox), false);
  });

  test('the refinement box wraps the body and its near wake one level below the surface', () => {
    const r = proposeRefinementBox(bikeBox, 3);
    assert.equal(r.level, 2);
    for (let a = 0; a < 3; a++) assert.ok(r.min[a] < BIKE.min[a] && r.max[a] > BIKE.max[a]);
    assert.ok(r.max[0] - BIKE.max[0] > BIKE.max[0] - BIKE.min[0]);
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
    const has = (s: SnappySettings, mesh: MeshSpec, re: RegExp, body: string | null = null) =>
      assert.ok(snappyProblems(s, mesh, body).some(p => re.test(p)), re.source);

    has(settings({ surfaces: [] }), m, /No geometry/);
    has({ ...ok, insidePoint: [100, 0, 0] }, m, /outside the background box/);
    has(ok, { ...m, twoD: true }, /3D mesh/);
    has(ok, { ...m, scale: 0.001 }, /scale to 1/);
    has({ ...ok, surfaces: [{ ...ok.surfaces[0], minLevel: 4, maxLevel: 2 }] }, m, /above the maximum/);
    has({ ...ok, surfaces: [{ ...ok.surfaces[0], name: 'my body' }] }, m, /must be a letter/);
    has(ok, { ...m, x1: 1 }, /outside the background box; snappyHexMesh can only mesh inside/);
    has(ok, { ...m, nx: m.nx * 4 }, /stretched cells stay stretched/);
    has(ok, m, /inside the geometry/, 'insidePoint is inside the geometry.');
    has({ ...ok, refinementBox: { enabled: true, min: [1, 0, 0], max: [0, 1, 1], level: 1 } }, m, /max above min/);
  });
});

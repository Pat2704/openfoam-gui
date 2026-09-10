/**
 * checkMesh's report, as OpenFOAM 13/14 print it (line shapes from the
 * checkMesh sources), and the patch list of constant/polyMesh/boundary as
 * snappyHexMesh writes it.
 *
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCheckMeshOutput } from '../src/lib/check-mesh.ts';
import { parsePolyMeshBoundary } from '../src/lib/wsl.ts';

const REPORT = (verdict: string, extra = '') => `Create time

Create polyMesh for time = 0

Time = 0

Mesh stats
    points:           1681
    faces:            6480
    internal faces:   3120
    cells:            1600
    faces per cell:   6
    boundary patches: 3

Overall number of cells of each type:
    hexahedra:     1600

Checking topology...
    Boundary definition OK.

Checking geometry...
    Overall domain bounding box (0 0 0) (0.1 0.1 0.01)
    Mesh non-orthogonality Max: 75.2 average: 10.1
${extra}
${verdict}
`;

describe('parseCheckMeshOutput', () => {
  test('reads the statistics block and the bounding box', () => {
    const r = parseCheckMeshOutput(REPORT('Mesh OK.'));
    const stats = Object.fromEntries(r.overallStats.map(s => [s.key, s.value]));
    assert.equal(stats.points, '1681');
    assert.equal(stats.cells, '1600');
    assert.equal(stats['boundary patches'], '3');
    assert.equal(stats['domain bounding box'], '(0 0 0) (0.1 0.1 0.01)');
    assert.equal(r.meshOk, true);
    assert.equal(r.verdictFound, true);
    assert.deepEqual(r.failedChecks, []);
  });

  test('reports failed checks and warnings in checkMesh\'s own markers', () => {
    const r = parseCheckMeshOutput(REPORT('Failed 1 mesh checks.',
      '   *Number of severely non-orthogonal (> 70 degrees) faces: 12.\n' +
      ' ***Max skewness = 5.3, 4 highly skew faces detected which may impair the quality of the results'));
    assert.equal(r.meshOk, false);
    assert.deepEqual(r.failedChecks.map(c => c.severity), ['warning', 'fail']);
    assert.match(r.failedChecks[0].message, /^Number of severely non-orthogonal/);
    assert.match(r.failedChecks[1].message, /^Max skewness = 5\.3/);
  });

  test('with one report per mesh time, the last one is the current mesh', () => {
    const first = REPORT('Failed 1 mesh checks.', ' ***Zero or negative cell volume detected.');
    const last = REPORT('Mesh OK.').replace('Time = 0', 'Time = 0.5');
    const r = parseCheckMeshOutput(first + last);
    assert.equal(r.meshOk, true);
    assert.deepEqual(r.failedChecks, []);
  });

  test('a run that never reached a verdict says so', () => {
    const r = parseCheckMeshOutput('--> FOAM FATAL ERROR:\ncannot find file "constant/polyMesh/points"\n');
    assert.equal(r.verdictFound, false);
  });
});

describe('parsePolyMeshBoundary', () => {
  const BOUNDARY = `FoamFile
{
    format      ascii;
    class       polyBoundaryMesh;
    object      boundary;
}

3
(
    lowerWall
    {
        type            wall;
        inGroups        List<word> 1(wall);
        nFaces          40;
        startFace       6320;
    }
    motorBike_frt-fairing:001%1
    {
        type            wall;
        inGroups        List<word> 2(motorBikeGroup wall);
        nFaces          1000;
        startFace       7000;
    }
    inlet
    {
        type            patch;
        nFaces          20;
        startFace       8000;
    }
)
`;

  test('keeps snappyHexMesh names with ":" and "%" and their groups', () => {
    const patches = parsePolyMeshBoundary(BOUNDARY);
    assert.deepEqual(patches.map(p => p.name), ['lowerWall', 'motorBike_frt-fairing:001%1', 'inlet']);
    const bike = patches.find(p => p.name === 'motorBike_frt-fairing:001%1')!;
    assert.ok(bike.groups.includes('motorBikeGroup'));
    assert.equal(bike.type, 'wall');
  });
});

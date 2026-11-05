/**
 * The agent's result and mesh digests (src/lib/case-digest.ts).
 *
 * The pure half — record parsing, aggregation over processors, rendering — is
 * tested directly. The awk that produces the records is tested where it runs:
 * a small fake case is written to /tmp in WSL (a log, a decomposed time
 * directory, a polyMesh) and the real scripts are run over it. Those tests skip
 * when WSL is not available.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  aggregateFields,
  fieldDigestScript,
  isFieldName,
  isTimeName,
  logDigestScript,
  logExcerptScript,
  logFileName,
  meshDigestScript,
  parseBoundaryEntries,
  parseFieldDigest,
  parseLogDigest,
  parseMeshDigest,
  parseMeshNote,
  renderFieldDigest,
  renderLogDigest,
  renderLogExcerpt,
  renderMeshDigest,
  summarizeTimes,
  type FieldFileRecord,
} from '../src/lib/case-digest.ts';
import { buildAnalysisRequest, buildResultsAnalysisRequest } from '../src/lib/agent-analysis.ts';

describe('names and times', () => {
  test('time and field names are what OpenFOAM writes, and nothing a shell could read', () => {
    for (const t of ['0', '0.5', '1e-05', '2000', '-1']) assert.ok(isTimeName(t), t);
    for (const t of ['', 'latest', '0.5;rm', '$(id)', '1/2']) assert.ok(!isTimeName(t), t);
    for (const f of ['U', 'p_rgh', 'alpha.water', 'k:0', 'T']) assert.ok(isFieldName(f), f);
    for (const f of ['', '0U', 'a b', 'U;', '../p', '$p']) assert.ok(!isFieldName(f), f);
  });

  test('a log is named the way the Monitor names it', () => {
    assert.equal(logFileName('foamRun'), 'log.foamRun');
    assert.equal(logFileName('log.foamRun'), 'log.foamRun');
    assert.equal(logFileName('log'), 'log');
  });

  test('time lists sort numerically and stay one line', () => {
    assert.equal(summarizeTimes(['10', '2', '0']), '0, 2, 10');
    const many = Array.from({ length: 101 }, (_, i) => String(i * 0.005));
    assert.equal(summarizeTimes(many), `0, 0.005 … ${many[100]} (101 times)`);
    assert.equal(summarizeTimes([]), 'none');
  });
});

describe('log digest records', () => {
  const records = [
    'LOG\tlog.foamRun\t2048\t3600', 'LOG\tlog.blockMesh\t512\t7200', 'USE\tlog.foamRun\t2048\t3600',
    'H\texec\tfoamRun -parallel', 'H\tnprocs\t4', 'S\tSelecting RAS turbulence model kEpsilon',
    'T\t3\t0.1\t0.3\t0',
    'F\tUx\t3\t1\t0.5\t0.01\t1\t4\t2\t1e-6\t0',
    'F\tp\t3\t1\t2\t0.01\t2\t1000\t1000\t1e-5\t1',
    'F\trho\t3\t0\t0\t0\t0\t0\t0\t0\t0',
    'RF\tUx\tp\trho', 'R\t0.1\t1\t1\t0', 'R\t0.3\t0.5\t2\t0',
    'CO\t3\t0.1\t0.9\t1.4\t0.2', 'DT\t0', 'CE\t3\t1e-8\t1e-6\t-2e-9', 'EX\t12\t13',
    'NC\t2\tPIMPLE: Not converged within 5 iterations', 'CV\t0\t',
    'B\tk\t5\t0.2\t-3e-5', 'WC\t0', 'XC\t1', 'X\t--- line 90', 'X\t--> FOAM FATAL ERROR: Maximum number of iterations exceeded',
    'E\t0', 'L\tlast line',
  ].join('\n');

  test('parses every record and drops always-zero residuals', () => {
    const d = parseLogDigest(records);
    assert.equal(d.found, true);
    assert.equal(d.logs.length, 2);
    assert.equal(d.header.nprocs, '4');
    assert.deepEqual(d.fields.map(f => f.field), ['Ux', 'p']);
    assert.deepEqual(d.trivialFields, ['rho']);
    assert.equal(d.samples.length, 2);
    assert.equal(d.courant?.maxMax, 1.4);
    assert.equal(d.deltaT, undefined, 'no deltaT lines: none reported');
    assert.equal(d.fatals, 1);
  });

  test('the text states the outcome and flags what matters', () => {
    const text = renderLogDigest(parseLogDigest(records));
    assert.match(text, /STATE: STOPPED WITH A FATAL ERROR/);
    assert.match(text, /parallel on 4 processes/);
    assert.match(text, /p: 1 → 2 .*rising/);
    assert.match(text, /hit 1000 iterations/);
    assert.match(text, /1 NaN\/inf solves/);
    assert.match(text, /k 5× from t=0.2/);
    assert.match(text, /Maximum number of iterations exceeded/);
    assert.match(text, /rho: residual always 0/);
  });

  test('a case without logs says so', () => {
    assert.match(renderLogDigest(parseLogDigest('NOLOG\t')), /no log file/);
    assert.match(renderLogDigest(parseLogDigest('LOG\tlog.a\t1\t1\nNOLOG\tlog.foamRun')), /There is no log.foamRun.*log.a/);
  });
});

describe('field digest', () => {
  const file = (over: Partial<FieldFileRecord>): FieldFileRecord => ({
    location: 'processor0/1', field: 'p', className: 'volScalarField', format: 'ascii', kind: 'nonuniform',
    count: 0, nan: 0, min: NaN, max: NaN, sum: NaN, ...over,
  });

  test('processor copies combine into one summary, weighted by their cell counts', () => {
    const [p] = aggregateFields([
      file({ count: 3, min: 1, max: 3, sum: 6 }),
      file({ location: 'processor1/1', count: 1, min: -1, max: -1, sum: -1 }),
    ]);
    assert.equal(p.count, 4);
    assert.equal(p.min, -1);
    assert.equal(p.max, 3);
    assert.equal(p.mean, 5 / 4);
  });

  test('a uniform copy bounds the range, and binary or missing copies are counted', () => {
    const [k] = aggregateFields([
      file({ field: 'k', count: 2, min: 1, max: 2, sum: 3 }),
      file({ field: 'k', kind: 'uniform', uniform: '-0.5' }),
      file({ field: 'k', kind: 'binary' }),
    ]);
    assert.equal(k.min, -0.5);
    assert.equal(k.binary, 1);
    assert.deepEqual(k.uniform, ['-0.5']);
  });

  test('impossible values are flagged by field name', () => {
    const text = renderFieldDigest({
      rootTimes: ['0'], processorCount: 2, processorTimes: ['0', '1'],
      processorLatest: [{ processor: 'processor0', count: 2, latest: '1' }, { processor: 'processor1', count: 1, latest: '0' }],
      time: '1', source: 'processors', locations: 2, alsoInProcessors: false, noTime: false, fieldCount: 2,
      files: [file({ field: 'k', count: 2, min: -1e-3, max: 2, sum: 2 }), file({ field: 'p', count: 2, min: -5, max: 5, sum: 0 })],
      boundary: [{ field: 'k', patch: 'inlet', type: 'fixedValue', value: 'uniform 0.1' }, { field: 'p', patch: 'inlet', type: 'calculated', value: 'nonuniform' }],
      skipped: ['phi'],
    });
    assert.match(text, /k \(Scalar, 2\).*NEGATIVE/);
    assert.doesNotMatch(text, /p \(Scalar, 2\).*NEGATIVE/, 'kinematic pressure may be negative');
    assert.match(text, /do NOT end at the same time/);
    assert.match(text, /exist only in the processor directories/);
    assert.match(text, /inlet: k fixedValue uniform 0.1$/m, 'calculated entries are left out');
    assert.match(text, /not read.*phi/);
  });
});

describe('mesh digest', () => {
  test('reads a boundary file with face counts and groups', () => {
    const entries = parseBoundaryEntries(`FoamFile { version 2.0; class polyBoundaryMesh; }
3
(
    inlet { type patch; nFaces 10; startFace 100; }
    walls
    {
        type            wall;
        inGroups        List<word> 1(wall);
        nFaces          40;
        startFace       110;
    }
    "front.*" { type empty; nFaces 0; startFace 150; }
)`);
    assert.deepEqual(entries.map(e => [e.name, e.type, e.nFaces]), [['inlet', 'patch', 10], ['walls', 'wall', 40], ['front.*', 'empty', 0]]);
    assert.deepEqual(entries[1].groups, ['wall']);
  });

  test('takes the sizes from the owner note', () => {
    assert.deepEqual(parseMeshNote('nPoints:12225  nCells:6000  nFaces:24170  nInternalFaces:11830'),
      { points: 12225, cells: 6000, faces: 24170, internalFaces: 11830 });
    assert.equal(parseMeshNote(''), null);
  });

  test('flags a decomposition of a different mesh', () => {
    const text = renderMeshDigest({
      root: { points: 1, cells: 100, faces: 1, internalFaces: 0 }, hasRoot: true, boundary: [], zones: [], sets: [],
      timeMeshes: [], decomposition: ['numberOfSubdomains 2'],
      processors: [
        { name: 'processor0', counts: { points: 0, cells: 60, faces: 0, internalFaces: 0 }, procPatches: 1, procFaces: 4 },
        { name: 'processor1', counts: { points: 0, cells: 30, faces: 0, internalFaces: 0 }, procPatches: 1, procFaces: 4 },
      ],
    }, null, null);
    assert.match(text, /imbalance 33.33%/);
    assert.match(text, /total 90 ≠ 100 at the root/);
    assert.match(text, /4 shared faces/);
  });
});

describe('analysis requests', () => {
  test('ask in English, for an answer in the language of the conversation or English when it is empty', () => {
    assert.match(buildResultsAnalysisRequest('grp/cavity', false), /^Analyse the results of the run in "grp\/cavity"\..*Reply in English\.$/);
    assert.match(buildAnalysisRequest('mesh', 'cavity', true), /^Analyse the mesh of "cavity"\..*Reply in the language this conversation has been in\.$/);
  });
});

// ── The awk itself, run in WSL over a fake case ─────────────────────────────

function wslAvailable(): boolean {
  try {
    return execFileSync('wsl', ['--exec', 'bash', '-c', 'echo ok'], { encoding: 'utf-8', windowsHide: true, timeout: 20000 }).trim() === 'ok';
  } catch { return false; }
}

function runScript(script: string): string {
  const b64 = Buffer.from(script).toString('base64');
  return execFileSync('wsl', ['--exec', 'bash', '-c', `echo "${b64}" | base64 -d | bash`],
    { encoding: 'utf-8', windowsHide: true, timeout: 60000, maxBuffer: 1 << 24 });
}

const FIXTURE = String.raw`
set -e
c="$1"; rm -rf "$c"; mkdir -p "$c"/0 "$c"/system "$c"/constant/polyMesh "$c"/processor0/1 "$c"/processor1/1 \
  "$c"/processor0/constant/polyMesh "$c"/processor1/constant/polyMesh
cd "$c"
cat > log.foamRun <<'L'
Build  : 14-test
Exec   : foamRun -parallel
nProcs : 2
Selecting RAS turbulence model kEpsilon
Courant Number mean: 0.01 max: 0.1
Time = 0.5s

Courant Number mean: 0.02 max: 0.4
deltaT = 0.5
smoothSolver:  Solving for Ux, Initial residual = 1, Final residual = 0.001, No Iterations 3
diagonal:  Solving for rho, Initial residual = 0, Final residual = 0, No Iterations 0
GAMG:  Solving for p, Initial residual = 1, Final residual = 0.01, No Iterations 12
GAMG:  Solving for p, Initial residual = 0.5, Final residual = 0.001, No Iterations 8
time step continuity errors : sum local = 1e-05, global = 1e-07, cumulative = 1e-07
bounding k, min: -0.002 max: 3 average: 1
Time = 1s

Courant Number mean: 0.03 max: 0.9
deltaT = 0.5
smoothSolver:  Solving for Ux, Initial residual = 0.1, Final residual = 0.0001, No Iterations 2
GAMG:  Solving for p, Initial residual = 0.2, Final residual = 0.002, No Iterations 10
time step continuity errors : sum local = 2e-06, global = 1e-08, cumulative = 1.1e-07
--> FOAM Warning : in something
    the warning text
ExecutionTime = 1.5 s  ClockTime = 2 s

End
L
printf 'only a mesh\n' > log.blockMesh
cat > 0/U <<'F'
FoamFile { format ascii; class volVectorField; object U; }
internalField   uniform (0 0 0);
boundaryField
{
    inlet
    {
        type            fixedValue;
        value           uniform (1 0 0);
    }
    frontAndBack { type empty; }
}
F
cat > processor0/1/p <<'F'
FoamFile
{
    format      ascii;
    class       volScalarField;
}
internalField   nonuniform List<scalar>
3
(
1
2
3
)
;
boundaryField
{
    inlet
    {
        type            totalPressure;
        p0              uniform 0;
        value           nonuniform List<scalar>
2
(
0.1
0.2
)
;
    }
    procBoundary0to1
    {
        type            processor;
        value           nonuniform List<scalar> 2(1 2);
    }
}
F
cat > processor1/1/p <<'F'
FoamFile { format ascii; class volScalarField; }
internalField   nonuniform List<scalar> 2(-1 5);
boundaryField { }
F
cat > processor0/1/U <<'F'
FoamFile { format ascii; class volVectorField; }
internalField   nonuniform List<vector>
2
(
(3 4 0)
(0 0 0)
)
;
F
cat > processor1/1/U <<'F'
FoamFile { format ascii; class volVectorField; }
internalField   uniform (0 0 12);
F
cat > processor0/1/k <<'F'
FoamFile { format ascii; class volScalarField; }
internalField   nonuniform List<scalar> 2(-0.002 nan);
F
cat > processor1/1/k <<'F'
FoamFile { format ascii; class volScalarField; }
internalField   uniform 1;
F
cat > processor0/1/phi <<'F'
FoamFile { format ascii; class surfaceScalarField; }
internalField   nonuniform List<scalar> 1(0);
F
cp processor0/1/phi processor1/1/phi
cat > constant/polyMesh/owner <<'F'
FoamFile { format ascii; class labelList; note "nPoints:8 nCells:5 nFaces:20 nInternalFaces:4"; object owner; }
F
cat > constant/polyMesh/boundary <<'F'
FoamFile { format ascii; class polyBoundaryMesh; }
2
(
    inlet { type patch; nFaces 2; startFace 4; }
    frontAndBack { type empty; inGroups List<word> 1(empty); nFaces 14; startFace 6; }
)
F
cat > constant/polyMesh/points <<'F'
FoamFile { format ascii; class vectorField; }
3
(
(0 0 0)
(2 1 0.1)
(-1 3 0)
)
F
cat > constant/polyMesh/cellZones <<'F'
FoamFile
{
    format      ascii;
    class       regIOobject;
}
1
(
rotor
{
    type cellZone;
    cellLabels      List<label> 3
(
0
1
2
)
;
}
)
F
for p in 0 1; do
  cat > processor$p/constant/polyMesh/owner <<F
FoamFile { format ascii; class labelList; note "nPoints:4 nCells:$((3 - p)) nFaces:10 nInternalFaces:2"; }
F
  cat > processor$p/constant/polyMesh/boundary <<'F'
FoamFile { format ascii; class polyBoundaryMesh; }
2
(
    inlet { type patch; nFaces 1; startFace 2; }
    procBoundary
    {
        type            processor;
        nFaces          2;
        startFace       3;
    }
)
F
done
printf 'numberOfSubdomains 2;\nmethod          simple;\n' > system/decomposeParDict
`;

describe('the digest scripts in WSL', { skip: !wslAvailable() && 'WSL is not available' }, () => {
  const dir = `/tmp/ofstudio_digest_test_${process.pid}`;
  const prepare = () => runScript(`cat > /tmp/ofstudio_fixture_${process.pid}.sh <<'FIXTURE_END'\n${FIXTURE}\nFIXTURE_END\nbash /tmp/ofstudio_fixture_${process.pid}.sh ${dir}; rm -f /tmp/ofstudio_fixture_${process.pid}.sh`);
  const cleanup = () => runScript(`rm -rf ${dir}`);

  test('the log digest takes the solver log and reads every quantity', () => {
    prepare();
    try {
      const d = parseLogDigest(runScript(logDigestScript(dir, '')));
      assert.equal(d.file, 'log.foamRun', 'the log with residuals, not the newest one');
      assert.equal(d.steps, 2);
      assert.equal(d.lastTime, '1');
      assert.equal(d.ended, true);
      const p = d.fields.find(f => f.field === 'p')!;
      assert.deepEqual([p.first, p.last, p.maxIterations], [1, 0.2, 12], 'first solve of each step');
      assert.deepEqual(d.trivialFields, ['rho']);
      assert.equal(d.courant?.maxMax, 0.9);
      assert.equal(d.continuity?.maxLocal, 1e-5);
      assert.deepEqual(d.bounding.map(b => [b.field, b.count, b.worstMin]), [['k', 1, -0.002]]);
      assert.equal(d.warnings, 1);
      assert.equal(d.executionTime, 1.5);
      assert.ok(d.samples.length >= 2);
      const named = parseLogDigest(runScript(logDigestScript(dir, 'log.blockMesh')));
      assert.equal(named.file, 'log.blockMesh');
      assert.equal(parseLogDigest(runScript(logDigestScript(dir, 'log.nothing'))).missing, 'log.nothing');
    } finally { cleanup(); }
  });

  test('a log excerpt finds a literal text with its context', () => {
    prepare();
    try {
      const text = renderLogExcerpt(runScript(logExcerptScript(dir, 'log.foamRun', { match: 'Time = 1s', context: 1 })), 'log.foamRun', { match: 'Time = 1s' });
      assert.match(text, /occurs 1×/);
      assert.match(text, /^\d+: Time = 1s$/m);
      assert.match(renderLogExcerpt(runScript(logExcerptScript(dir, 'log.foamRun', { match: '$(id)' })), 'log.foamRun', { match: '$(id)' }), /does not occur/);
    } finally { cleanup(); }
  });

  test('the field digest combines the processor directories', () => {
    prepare();
    try {
      const d = parseFieldDigest(runScript(fieldDigestScript(dir, '', [])));
      assert.equal(d.time, '1');
      assert.equal(d.source, 'processors');
      assert.equal(d.processorCount, 2);
      assert.deepEqual(d.skipped, ['phi']);
      const fields = Object.fromEntries(aggregateFields(d.files).map(s => [s.field, s]));
      assert.deepEqual([fields.p.count, fields.p.min, fields.p.max, fields.p.mean], [5, -1, 5, 10 / 5]);
      assert.deepEqual([fields.U.min, fields.U.max], [0, 12], 'magnitudes, the uniform copy included');
      assert.equal(fields.k.nan, 1);
      assert.equal(fields.k.min, -0.002);
      assert.deepEqual(d.boundary.map(b => [b.patch, b.type]), [['inlet', 'totalPressure']], 'processor patches left out');
      const zero = parseFieldDigest(runScript(fieldDigestScript(dir, '0', ['U'])));
      assert.equal(zero.source, 'root');
      assert.deepEqual(zero.boundary.map(b => [b.patch, b.type, b.value]), [['inlet', 'fixedValue', 'uniform (1 0 0)'], ['frontAndBack', 'empty', '']]);
      assert.match(renderFieldDigest(d), /k \(Scalar, 1\).*1 NaN\/inf values; NEGATIVE/, 'only the read values are counted');
    } finally { cleanup(); }
  });

  test('the mesh digest reads headers, zones, points and the decomposition', () => {
    prepare();
    try {
      const d = parseMeshDigest(runScript(meshDigestScript(dir)));
      assert.deepEqual(d.root, { points: 8, cells: 5, faces: 20, internalFaces: 4 });
      assert.deepEqual(d.boundary.map(b => [b.name, b.type, b.nFaces]), [['inlet', 'patch', 2], ['frontAndBack', 'empty', 14]]);
      assert.deepEqual(d.zones, [{ kind: 'cellZones', name: 'rotor', size: 3 }]);
      assert.deepEqual(d.boundingBox, { points: 3, min: [-1, 0, 0], max: [2, 3, 0.1] });
      assert.deepEqual(d.processors.map(p => [p.name, p.counts?.cells, p.procPatches, p.procFaces]), [['processor0', 3, 1, 2], ['processor1', 2, 1, 2]]);
      assert.deepEqual(d.decomposition, ['numberOfSubdomains 2', 'method simple']);
      const text = renderMeshDigest(d, null, null);
      assert.match(text, /PATCHES \(2, 2D \(empty patches\)\)/);
      assert.match(text, /size 3 × 3 × 0.1/);
    } finally { cleanup(); }
  });
});

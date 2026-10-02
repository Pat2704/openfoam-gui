import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createComparisonTrace, comparisonSource, comparisonAxisError, comparisonCoverage, sampleComparisonTrace, serializeComparisonCsv,
  type ComparisonTable, type ComparisonTrace,
} from '../src/lib/postprocess-comparison.ts';

function table(overrides: Partial<ComparisonTable> = {}): ComparisonTable {
  return {
    mode: 'series', columns: ['Time', 'p'], rows: [[0, 4], [0.25, null], [1, 9]], totalRows: 3,
    times: [], shownTime: null, truncated: false, timesTruncated: false, runsTruncated: false, incompatible: [], ...overrides,
  };
}
function trace(data = table(), caseName = 'a_test'): ComparisonTrace {
  return createComparisonTrace({ id: caseName, caseName, selection: { kind: 'dataset', dataset: 'history', file: 'p.dat' }, table: data, fieldIndex: 1, loadedAt: '2026-10-02T00:00:00.000Z' });
}

test('comparison keeps independent, repeated and negative coordinates and explicit gaps', () => {
  const first = trace(table({ rows: [[-1, 4], [0.25, null], [0.25, 3], [2, 7]], totalRows: 4 }));
  const second = trace(table({ rows: [[-0.7, 2], [0.6, 8], [3, 1]] }), 'b_test');
  assert.deepEqual(first.points, [{ x: -1, y: 4 }, { x: 0.25, y: null }, { x: 0.25, y: 3 }, { x: 2, y: 7 }]);
  assert.deepEqual(second.points.map(point => point.x), [-0.7, 0.6, 3]);
  assert.equal(comparisonAxisError(first, second), null);
  assert.deepEqual(sampleComparisonTrace(first).points, first.points);
});

test('comparison refuses time/profile and physical-axis mismatches; does not alias distance to x', () => {
  const time = trace();
  const profile = trace(table({ mode: 'profile', columns: ['distance', 'p'], shownTime: '0.1' }));
  assert.match(comparisonAxisError(time, profile) ?? '', /Time series and spatial profiles/);
  assert.match(comparisonAxisError(profile, { mode: 'profile', axis: 'x' }) ?? '', /Independent axes differ/);
  assert.equal(comparisonAxisError(profile, { mode: 'profile', axis: '  Distance ' }), null);
});

test('profile snapshot and residual aggregation are visible in labels and provenance', () => {
  const profile = trace(table({ mode: 'profile', columns: ['x', 'Ux'], shownTime: '0.1' }));
  assert.equal(profile.snapshot, '0.1');
  assert.match(profile.label, /t=0.1.*Ux/);
  const log = createComparisonTrace({ id: 'log', caseName: 'a_test', selection: { kind: 'log', log: 'log.foamRun' }, table: table(), fieldIndex: 1, residualSelection: 'maximum', loadedAt: 'now' });
  assert.match(log.label, /log.foamRun.*maximum initial/);
  assert.equal(log.residualSelection, 'maximum');
});

test('log provenance uses the actual file name without changing API identifiers', () => {
  const selection = { kind: 'log' as const, log: 'foamRun' };
  assert.equal(comparisonSource(selection), 'log.foamRun');
  assert.equal(selection.log, 'foamRun');
  assert.equal(comparisonSource({ kind: 'log', log: 'log' }), 'log');
  assert.equal(comparisonSource({ kind: 'log', log: 'log.foamRun' }), 'log.foamRun');
  const log = createComparisonTrace({ id: 'log', caseName: 'a_test', selection, table: table(), fieldIndex: 1, loadedAt: 'now' });
  assert.equal(log.source, 'log.foamRun');
  assert.match(serializeComparisonCsv([log]), /,a_test,log.foamRun,/);
});

test('envelope preview retains off-stride extrema, endpoints and gap boundaries under the cap', () => {
  const rows = Array.from({ length: 10000 }, (_, index) => [index / 10, Math.sin(index / 20)] as (number | null)[]);
  rows[317][1] = 1000;
  rows[5231][1] = -900;
  rows[6500][1] = null;
  const original = trace(table({ rows, totalRows: rows.length }));
  const sampled = sampleComparisonTrace(original, false, 1200);
  assert.equal(sampled.blocked, false);
  assert.ok(sampled.points.length <= 1200);
  for (const index of [0, 317, 5231, 6499, 6500, 6501, 9999]) assert.ok(sampled.points.some(point => point.x === rows[index][0]), `sample ${index} retained`);
  assert.equal(sampled.points.find(point => point.x === 650)?.y, null);
  assert.equal(original.points.length, 10000);
  assert.ok(sampled.points.every(point => original.points.some(original => original.x === point.x && original.y === point.y)));
});

test('insufficient budget and source omissions withhold preview rather than bridge gaps', () => {
  const original = trace(table({ rows: [[0, 1], [1, null], [2, 3], [3, null], [4, 2]], totalRows: 5 }));
  assert.deepEqual(sampleComparisonTrace(original, false, 3), { points: [], blocked: true });
  assert.deepEqual(sampleComparisonTrace({ ...original, sourceOmissions: 1 }), { points: [], blocked: true });
  assert.throws(() => sampleComparisonTrace(original, false, 0), /positive finite/);
});

test('log preview creates gaps for zero and negative values without changing CSV source rows', () => {
  const original = trace(table({ rows: [[0, 1], [0.1, 0], [0.2, -3], [1, 5]], totalRows: 4 }));
  assert.deepEqual(sampleComparisonTrace(original, true).points, [{ x: 0, y: 1 }, { x: 0.1, y: null }, { x: 0.2, y: null }, { x: 1, y: 5 }]);
  assert.match(serializeComparisonCsv([original]), /,Time,0.2,p,-3,/);
});

test('long CSV retains unequal grids and gaps, escapes provenance and declares source sampling', () => {
  const first = trace(table({ rows: [[0, 4], [0.25, null]], totalRows: 100, truncated: true }), 'a,"test');
  const second = trace(table({ rows: [[0.7, 2], [3, 1]], totalRows: 2 }), 'b_test');
  const csv = serializeComparisonCsv([first, second]);
  assert.equal(csv.trim().split('\n').length, 5);
  assert.match(csv, /"a,""test"/);
  assert.match(csv, /,Time,0.25,p,,/);
  assert.match(csv, /,Time,0.7,p,2,/);
  assert.match(csv, /2\/100 retained rows; read cap 200000; source sampled; source read truncated/);
  assert.ok(!csv.includes(',Time,0.7,p,4,'));
});

test('coverage records missing inventories, skipped files, malformed rows and log limits', () => {
  const coverage = comparisonCoverage(table({ timesTruncated: true, runsTruncated: true, incompatible: ['bad.dat'], diagnostics: { skippedRows: 7, nonFiniteCells: 2 }, omittedFeatures: 3, logCoverage: { returnedLines: 99, maxLines: 50000, maxBytes: 8000000 } }));
  for (const part of ['time inventory truncated', 'restart inventory truncated', '1 incompatible', '7 malformed', '2 non-finite', '3 source features omitted', 'log 99 lines; caps 50000 lines/8000000 bytes']) assert.ok(coverage.includes(part));
});

test('invalid axes and independent coordinates are refused; non-finite values stay gaps', () => {
  assert.throws(() => trace(table({ columns: ['', 'p'] })), /coordinate has no name/);
  assert.throws(() => trace(table({ rows: [[null, 3]] })), /Invalid independent coordinate/);
  assert.throws(() => trace(table({ rows: [[Infinity, 3]] })), /Invalid independent coordinate/);
  assert.deepEqual(trace(table({ rows: [[0, NaN], [1, Infinity]] })).points, [{ x: 0, y: null }, { x: 1, y: null }]);
  assert.throws(() => createComparisonTrace({ id: 'bad', caseName: 'a_test', selection: { kind: 'log', log: 'log.x' }, table: table(), fieldIndex: NaN, loadedAt: 'now' }), /value column/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analysisCurveStatistics, buildPostProcessAnalysisReport, CAPTURED_ANALYSIS_POINT_LIMIT,
  parsePostProcessAnalysis, replayPostProcessAnalysis, validateCapturedAnalysisTrace,
  type AnalysisDisplayCurve, type SavedPostProcessAnalysis,
} from '../src/lib/postprocess-analysis.ts';
import { createComparisonTrace, type ComparisonTable } from '../src/lib/postprocess-comparison.ts';

function table(overrides: Partial<ComparisonTable> = {}): ComparisonTable {
  return { mode: 'series', columns: ['Time', 'p'], rows: [[0, 1], [0.25, null], [1, 3]], totalRows: 3, times: [], shownTime: null, truncated: false, timesTruncated: false, runsTruncated: false, incompatible: [], ...overrides };
}
function recipe(): SavedPostProcessAnalysis {
  return { version: 1, logScale: true, tableView: false, curves: [{ color: '#3b82f6', visible: true, origin: {
    kind: 'source', caseName: 'a_test', selection: { kind: 'dataset', dataset: 'history', file: 'p.dat' }, time: null,
    residualSelection: 'first', field: 'p', mode: 'series', axis: 'Time',
  } }] };
}
function captured(data = table()): AnalysisDisplayCurve {
  const trace = createComparisonTrace({ id: 'captured', caseName: 'a_test', selection: { kind: 'dataset', dataset: 'history', file: 'p.dat' }, table: data, fieldIndex: 1, loadedAt: '2026-10-02T00:00:00.000Z' });
  return { trace, origin: { kind: 'captured', trace }, color: '#22c55e', visible: true };
}

test('saved recipes persist display options and reread current source rows by field name', async () => {
  const saved = recipe();
  const calls: unknown[] = [];
  const restored = await replayPostProcessAnalysis(saved, async (...args) => {
    calls.push(args);
    return table({ columns: ['Time', 'other', 'p'], rows: [[0.1, 20, 9], [0.7, 21, null]], totalRows: 2 });
  }, 'later');
  assert.deepEqual(calls, [['a_test', { kind: 'dataset', dataset: 'history', file: 'p.dat' }, undefined, 200000, 'first']]);
  assert.equal(restored.analysis.logScale, true);
  assert.equal(restored.analysis.tableView, false);
  assert.deepEqual(restored.curves[0].trace.points, [{ x: 0.1, y: 9 }, { x: 0.7, y: null }]);
  assert.equal(restored.curves[0].trace.loadedAt, 'later');
  assert.deepEqual(restored.warnings, []);
  assert.ok(!JSON.stringify(saved).includes('points'));
});

test('exact profile snapshots and residual modes are replayed rather than latest defaults', async () => {
  const profile = recipe();
  profile.curves[0].origin = { kind: 'source', caseName: 'a_test', selection: { kind: 'dataset', dataset: 'profile', file: 'line.xy' }, time: '0.1', residualSelection: 'maximum', field: 'p', mode: 'profile', axis: 'x' };
  const calls: unknown[] = [];
  const restored = await replayPostProcessAnalysis(profile, async (...args) => {
    calls.push(args);
    return table({ mode: 'profile', columns: ['x', 'p'], shownTime: '0.1' });
  }, 'later');
  assert.equal(restored.curves[0].trace.snapshot, '0.1');
  assert.equal((calls[0] as unknown[])[2], '0.1');
  const missing = await replayPostProcessAnalysis(profile, async () => table({ mode: 'profile', columns: ['x', 'p'], shownTime: '0.2' }), 'later');
  assert.equal(missing.curves.length, 0);
  assert.match(missing.warnings[0], /Snapshot 0.1 is no longer available/);
  const log = recipe();
  const source = log.curves[0].origin;
  assert.equal(source.kind, 'source');
  if (source.kind === 'source') { source.selection = { kind: 'log', log: 'foamRun' }; source.residualSelection = 'maximum'; }
  const residual = await replayPostProcessAnalysis(log, async (...args) => {
    assert.equal(args[4], 'maximum'); return table();
  }, 'later');
  assert.equal(residual.curves[0].trace.residualSelection, 'maximum');
});

test('missing/ambiguous fields and changed axes fail visibly while unaffected curves reopen', async () => {
  const saved = recipe();
  saved.curves.push({ ...saved.curves[0], origin: { ...(saved.curves[0].origin as object), caseName: 'b_test' } as typeof saved.curves[0]['origin'] });
  const restored = await replayPostProcessAnalysis(saved, async caseName => caseName === 'a_test' ? table({ columns: ['Time', 'q'] }) : table(), 'later');
  assert.equal(restored.curves.length, 1);
  assert.equal(restored.curves[0].trace.caseName, 'b_test');
  assert.match(restored.warnings[0], /a_test.*p.*missing or ambiguous/);
  const changed = await replayPostProcessAnalysis(recipe(), async () => table({ columns: ['distance', 'p'] }), 'later');
  assert.match(changed.warnings[0], /coordinate or data mode has changed/);
  const duplicate = await replayPostProcessAnalysis(recipe(), async () => table({ columns: ['Time', 'p', 'p'] }), 'later');
  assert.match(duplicate.warnings[0], /ambiguous/);
  const failed = await replayPostProcessAnalysis(recipe(), async () => { throw new Error('Case was removed'); }, 'later');
  assert.match(failed.warnings[0], /Case was removed/);
});

test('captured traces survive replay without a source read or a new capture timestamp', async () => {
  const entry = captured();
  const saved = { ...recipe(), curves: [entry] };
  const parsed = parsePostProcessAnalysis(JSON.parse(JSON.stringify(saved)));
  const restored = await replayPostProcessAnalysis(parsed, async () => { throw new Error('Captured data must not be read'); }, 'later');
  assert.deepEqual(restored.curves[0].trace.points, entry.trace.points);
  assert.equal(restored.curves[0].trace.loadedAt, '2026-10-02T00:00:00.000Z');
  assert.deepEqual(restored.warnings, []);
});

test('validation rejects unsupported versions, unsafe values, mismatched axes and unbounded captures', () => {
  assert.throws(() => parsePostProcessAnalysis({ ...recipe(), version: 2 }), /version/);
  assert.throws(() => parsePostProcessAnalysis({ ...recipe(), curves: [] }), /1–6/);
  assert.throws(() => parsePostProcessAnalysis({ ...recipe(), curves: Array(7).fill(recipe().curves[0]) }), /1–6/);
  const color = recipe(); color.curves[0].color = 'red"';
  assert.throws(() => parsePostProcessAnalysis(color), /color/);
  const invalidCase = recipe(); if (invalidCase.curves[0].origin.kind === 'source') invalidCase.curves[0].origin.caseName = '../outside';
  assert.throws(() => parsePostProcessAnalysis(invalidCase), /case name/);
  const incompatible = recipe(); incompatible.curves.push(captured(table({ mode: 'profile', columns: ['x', 'p'], shownTime: '0.1' })));
  assert.throws(() => parsePostProcessAnalysis(incompatible), /Time series and spatial profiles/);
  const trace = captured().trace;
  assert.throws(() => validateCapturedAnalysisTrace({ ...trace, points: [{ x: Infinity, y: 1 }] }), /numerical values/);
  assert.throws(() => validateCapturedAnalysisTrace({ ...trace, points: [{ x: 1, y: NaN }] }), /numerical values/);
  assert.throws(() => validateCapturedAnalysisTrace({ ...trace, points: Array(CAPTURED_ANALYSIS_POINT_LIMIT + 1).fill({ x: 0, y: 1 }) }), /supports/);
  assert.throws(() => validateCapturedAnalysisTrace({ ...trace, totalRows: 1 }), /coverage/);
});

test('report escapes all labels, preserves isolated gap segments and embeds original CSV rows', () => {
  const entry = captured(table({ rows: [[0, 1], [0.25, null], [1, -2]], totalRows: 3 }));
  entry.trace.label = '<img src=x onerror="alert(1)">';
  entry.trace.source = '</td><script>alert(1)</script>';
  const html = buildPostProcessAnalysisReport('Title <script>alert(1)</script>', [entry], false, 'now');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /Captured snapshot \(not re-read\)/);
  assert.match(html, /<td>2 \/ 1<\/td>/);
  assert.match(html, /<td>-0.5<\/td>/);
  assert.equal((html.match(/<circle /g) ?? []).length, 2);
  const csv = decodeURIComponent(html.match(/href="data:text\/csv;charset=utf-8,([^"]+)"/)![1]);
  assert.match(csv, /,Time,0.25,p,,/);
  assert.match(csv, /,Time,1,p,-2,/);
  assert.ok(!html.includes(' L875.000'));
});

test('log report masks non-positive chart values but retains all values in CSV and statistics', () => {
  const entry = captured(table({ rows: [[0, 1], [0.1, 0], [0.2, -3], [1, 5]], totalRows: 4 }));
  const html = buildPostProcessAnalysisReport('Log', [entry], true, 'now');
  assert.match(html, /Value \(log Y\)/);
  assert.match(html, /<td>4 \/ 0<\/td>/);
  const csv = decodeURIComponent(html.match(/href="data:text\/csv;charset=utf-8,([^"]+)"/)![1]);
  assert.match(csv, /,Time,0.2,p,-3,/);
  assert.equal((html.match(/<circle /g) ?? []).length, 2);
});

test('withheld report charts declare omitted features; statistics use all loaded values', () => {
  const entry = captured(); entry.trace.sourceOmissions = 1;
  const html = buildPostProcessAnalysisReport('Limited', [entry], false, 'now');
  assert.match(html, /No curves can be drawn/);
  assert.match(html, /withheld: important boundaries omitted/);
  assert.equal(analysisCurveStatistics(entry.trace).mean, 2);
  const extreme = captured(table({ rows: [[0, Number.MAX_VALUE], [1, -Number.MAX_VALUE]], totalRows: 2 }));
  assert.equal(analysisCurveStatistics(extreme.trace).mean, 0);
  assert.ok(!buildPostProcessAnalysisReport('Extreme', [extreme], false, 'now').includes('NaN'));
  const tiny = captured(table({ rows: [[0, 0], [Number.MIN_VALUE, Number.MIN_VALUE]], totalRows: 2 }));
  assert.ok(!buildPostProcessAnalysisReport('Tiny', [tiny], false, 'now').includes('NaN'));
});

test('report refuses large embedded CSV and hidden-only output with explicit errors', () => {
  const entry = captured(table({ rows: Array.from({ length: 5000 }, (_, index) => [index, index]), totalRows: 5000 }));
  entry.trace.label = 'long '.repeat(500);
  assert.throws(() => buildPostProcessAnalysisReport('Large', [entry], false, 'now'), /CSV exceeds 4 MB/);
  entry.visible = false;
  assert.throws(() => buildPostProcessAnalysisReport('Hidden', [entry], false, 'now'), /Enable at least one/);
});

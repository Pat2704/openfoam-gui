import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultParaViewColumns, isolatedParaViewSample, paraViewChartRows, paraViewDataRequest, paraViewTableCsv } from '../src/lib/pvplots.ts';
import type { ParaViewDataColumn, ParaViewDataTable } from '../src/lib/pvplots.ts';

const columns: ParaViewDataColumn[] = [
  { index: 0, label: 'Row index', name: 'Row index', kind: 'index', component: 0 },
  { index: 1, label: 'Coordinate X', name: 'Coordinate X', kind: 'coordinate', component: 0 },
  { index: 2, label: 'U [0]', name: 'U', kind: 'array', component: 0 },
  { index: 3, label: 'U (Magnitude)', name: 'U', kind: 'array', component: -1 },
  { index: 4, label: 'arc_length', name: 'arc_length', kind: 'array', component: 0 },
];

test('numeric commands accept only bounded typed selectors and drop arbitrary proxy/property data', () => {
  const request = { mode: 'chart', id: 'filter-1', revision: 7, time: 0.1, columns: [1, 3, 3] };
  assert.deepEqual(paraViewDataRequest({ ...request, python: 'unsafe', proxy: 'Unsafe', path: '../escape' }), { ...request, columns: [1, 3] });
  for (const invalid of [null, [], { ...request, mode: 'python' }, { ...request, id: '../escape' },
    { ...request, time: NaN }, { ...request, revision: true }, { ...request, block: -1 }, { ...request, association: 'FIELD' },
    { ...request, columns: [128] }, { ...request, columns: ['U'] }, { ...request, columns: [] }, { ...request, columns: Array(17).fill(0) }]) {
    assert.throws(() => paraViewDataRequest(invalid));
  }
});

test('sampled lines default to arc length and vector magnitude; other meshes use coordinates or row index', () => {
  assert.deepEqual(defaultParaViewColumns(columns), { x: 4, series: [3] });
  assert.deepEqual(defaultParaViewColumns(columns.slice(0, 4)), { x: 1, series: [3] });
  assert.deepEqual(defaultParaViewColumns(columns.filter(column => column.kind !== 'coordinate' && column.name !== 'arc_length')), { x: 0, series: [3] });
  const csvColumns: ParaViewDataColumn[] = [...columns, { index: 5, label: 'time', name: 'time', kind: 'array', component: 0 }];
  assert.equal(defaultParaViewColumns(csvColumns.filter(column => column.name !== 'arc_length')).x, 5);
});

test('non-finite X coordinates break every series without removing the gap row', () => {
  assert.deepEqual(paraViewChartRows([[0, 2], [null, 3], [2, 4]]).rows, [[0, 2], [null, null], [2, 4]]);
  const rows = Array.from({ length: 20000 }, (_, index) => [index, index === 10000 ? 1e6 : index === 10001 ? null : 1]);
  const sampled = paraViewChartRows(rows);
  assert.equal(sampled.omittedFeatures, 0);
  assert.ok(sampled.rows.length <= 4000);
  assert.ok(sampled.rows.some(row => row[1] === 1e6));
  assert.ok(sampled.rows.some(row => row[1] === null));
});

test('CSV quotes metadata and preserves non-finite/missing values as empty fields', () => {
  const data = { columns: [{ index: 0, label: 'a,"b"' }, { index: 1, label: 'value' }], selectedColumns: [0, 1], rows: [[0, 2], [1, null], [2, Infinity]] } as ParaViewDataTable;
  assert.equal(paraViewTableCsv(data), '"a,""b""",value\r\n0,2\r\n1,\r\n2,');
});

test('single integration results and samples isolated between gaps keep visible markers', () => {
  assert.equal(isolatedParaViewSample([[0, 5]], 0, 1), true);
  assert.equal(isolatedParaViewSample([[0, null], [1, 5], [2, null]], 1, 1), true);
  assert.equal(isolatedParaViewSample([[0, 4], [1, 5], [2, null]], 1, 1), false);
  assert.equal(isolatedParaViewSample([[null, 5]], 0, 1), false);
});

test('real pvpython handles bounded points/cells/tables, components, gaps and composite blocks', { skip: !process.env.OFSTUDIO_TEST_PVPYTHON }, () => {
  const args = ['--disable-registry', fileURLToPath(new URL('./pvplots-worker.py', import.meta.url))];
  if (process.env.OFSTUDIO_TEST_PVCASE) args.push(process.env.OFSTUDIO_TEST_PVCASE);
  const output = execFileSync(process.env.OFSTUDIO_TEST_PVPYTHON!, args, { windowsHide: true, timeout: 600_000, encoding: 'utf-8' });
  assert.match(output, /PASS actual PlotOverLine preserves arc length and invalid samples/);
  assert.match(output, /PASS native chart\/export row caps/);
  if (process.env.OFSTUDIO_TEST_PVCASE) assert.match(output, /PASS disposable OpenFOAM reader, sampled U and case-local CSV table/);
});

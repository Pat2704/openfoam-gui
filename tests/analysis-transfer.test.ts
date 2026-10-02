import test from 'node:test';
import assert from 'node:assert/strict';
import { createParaViewAnalysisTransfer } from '../src/lib/analysis-transfer';
import type { ParaViewDataTable } from '../src/lib/pvplots';

const table: ParaViewDataTable = {
  id: 'filter-2', revision: 3, time: 0.1, block: 0, blocks: [{ index: 0, label: 'internalMesh' }], blocksLimited: false,
  association: 'POINTS', associations: ['POINTS'], columns: [
    { index: 0, name: 'arc_length', label: 'arc_length', kind: 'array', component: 0 },
    { index: 1, name: 'U', label: 'U Magnitude', kind: 'array', component: -1 },
  ], columnsLimited: false, nonNumericColumns: 0, selectedColumns: [0, 1],
  rows: [[0, 1], [0.3, null], [0.3, 4], [1, 2]], totalRows: 100, offset: 0,
  limited: true, invalidRows: 1, nonFiniteValues: 1, rowLimit: 20000,
};
const workbench = { caseName: 'cavity_test', selectedId: 'filter-2', dataRevision: 3, time: 0.1 };

test('ParaView transfer preserves repeated coordinates, gaps and explicit snapshot coverage', () => {
  const transfer = createParaViewAnalysisTransfer(workbench, table, 'Plot Over Line', 'capture', '2026-10-02T10:00:00.000Z');
  assert.deepEqual(transfer.traces[0].points, [{ x: 0, y: 1 }, { x: 0.3, y: null }, { x: 0.3, y: 4 }, { x: 1, y: 2 }]);
  assert.equal(transfer.traces[0].mode, 'profile');
  assert.equal(transfer.traces[0].snapshot, '0.1');
  assert.match(transfer.provenance, /internalMesh/);
  assert.match(transfer.provenance, /prefix only/);
  assert.match(transfer.provenance, /units and coordinate frame unknown/);
  table.rows[0][1] = 99;
  assert.equal(transfer.traces[0].points[0].y, 1);
  table.rows[0][1] = 1;
});

test('transfer refuses stale pipeline/time, invalid X and excessive series', () => {
  assert.throws(() => createParaViewAnalysisTransfer({ ...workbench, dataRevision: 4 }, table, 'Line', 'id', 'date'), /pipeline changed/);
  assert.throws(() => createParaViewAnalysisTransfer({ ...workbench, time: 0.2 }, table, 'Line', 'id', 'date'), /pipeline changed/);
  assert.throws(() => createParaViewAnalysisTransfer(workbench, { ...table, rows: [[null, 2]] }, 'Line', 'id', 'date'), /invalid coordinates/);
  assert.throws(() => createParaViewAnalysisTransfer(workbench, { ...table, selectedColumns: [0, 1, 2, 3, 4, 5, 6, 7] }, 'Line', 'id', 'date'), /between 1 and 6/);
  assert.throws(() => createParaViewAnalysisTransfer(workbench, { ...table, offset: 200 }, 'Line', 'id', 'date'), /bounded chart/);
});

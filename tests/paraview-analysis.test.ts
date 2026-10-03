import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { analysisNumber, diagnosticRequest, findDataRequest, probeRequest, resampleRequest, volumeSettings, probeCsv, findDataCsv, currentAnalysisGuard } from '../src/lib/paraview-analysis.ts';
import { parseParaViewWorkspace } from '../src/lib/paraview-workspace.ts';
import { readParaViewRender, sendParaViewCommand, startParaViewSession, stopParaViewSession, type ParaViewWorkbenchState } from '../src/lib/paraview.ts';

const guard = { id: 'reader', revision: 1, time: 0.1 };
test('analysis requests accept only guided fixed settings and bounded finite geometry', () => {
  assert.throws(() => analysisNumber(' ', 'probe X'), /Enter probe X/);
  assert.equal(analysisNumber('0', 'probe X'), 0);
  assert.deepEqual(probeRequest({ ...guard, block: 0, association: 'POINTS', position: [0.25, 0.25, 0.25] }).position, [0.25, 0.25, 0.25]);
  assert.throws(() => probeRequest({ ...guard, block: 0, association: 'POINTS', position: [NaN, 0, 0] }), /probe location/);
  assert.throws(() => probeRequest({ ...guard, block: 0, association: 'POINTS', position: [0, 0, 0], python: 'bad' }), /Unsupported/);
  assert.throws(() => findDataRequest({ ...guard, block: 0, association: 'POINTS', name: 'U', component: -2, lower: 0, upper: 1 }), /component/);
  assert.throws(() => findDataRequest({ ...guard, block: 0, association: 'POINTS', name: 'U', component: 0, lower: 2, upper: 1 }), /lower/);
  assert.throws(() => diagnosticRequest({ ...guard, diagnostic: { association: 'POINTS', name: 'U', prefix: '__proto__' } }), /prefix/);
  assert.throws(() => resampleRequest({ ...guard, dimensions: [160, 160, 160] }), /two million/);
  assert.throws(() => resampleRequest({ ...guard, dimensions: [32, 32, 1] }), /dimension/);
  assert.deepEqual(volumeSettings({ opacityPoints: [[0, 0], [0.5, 0.2], [1, 1]], unitDistance: 0.1 }).opacityPoints[1], [0.5, 0.2]);
  assert.throws(() => volumeSettings({ opacityPoints: [[0, 0], [0, 1]], unitDistance: 1 }), /increase/);
  assert.throws(() => volumeSettings({ opacityPoints: [[0, 0], [1, 2]], unitDistance: 1 }), /zero and one/);
  assert.throws(() => volumeSettings({ opacityPoints: [[0, 0], [1, 1]], unitDistance: 0 }), /positive/);
});

test('analysis CSV retains provenance and outside probes as missing values', () => {
  const result = { ...guard, block: 1, association: 'POINTS' as const, position: [0, 0, 0] as [number, number, number], inside: false, values: [{ name: 'U,"x', components: [null, null, null], magnitude: null }], limited: false, note: 'outside' };
  const csv = probeCsv(result);
  assert.ok(csv.includes('0.1,1,POINTS,0,0,0,false,"U,""x",0,'));
  assert.ok(csv.includes('magnitude,'));
  assert.ok(!csv.includes('NaN'));
  const selected = { ...guard, block: 0, association: 'CELLS' as const, name: 'p', component: 0, lower: 0, upper: 1, rows: [{ index: 42, coordinate: [0.5, null, 0] as [number, null, number], value: 0.75 }], matched: 1, scanned: 100, total: 100, limited: false, scanLimited: false };
  assert.ok(findDataCsv(selected).includes('42,0.5,,0,0.75'));
});

function analyticVtk(): string {
  const points: number[][] = [];
  for (let z = 0; z < 3; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) points.push([x / 2, y / 2, z / 2]);
  return ['# vtk DataFile Version 3.0', 'Phase 4 analytic solid rotation', 'ASCII', 'DATASET STRUCTURED_POINTS', 'DIMENSIONS 3 3 3', 'ORIGIN 0 0 0', 'SPACING 0.5 0.5 0.5', 'POINT_DATA 27', 'VECTORS U double', ...points.map(([x, y]) => `${-y} ${x} 0`), 'SCALARS p double 1', 'LOOKUP_TABLE default', ...points.map(([x, y, z]) => String(x + 2 * y + 3 * z)), 'CELL_DATA 8', 'SCALARS constant double 1', 'LOOKUP_TABLE default', ...Array(8).fill('7'), ''].join('\n');
}

test('native probe, selection, vector CFD diagnostics, resampling and volume are numerically correct and reproducible', {
  skip: !process.env.OFSTUDIO_TEST_PVPYTHON || !process.env.OFSTUDIO_TEST_PVCASE,
  timeout: 600_000,
}, async () => {
  const marker = process.env.OFSTUDIO_TEST_PVCASE!;
  const caseName = path.basename(path.dirname(marker));
  assert.ok(caseName === 'test' || caseName.endsWith('_test'), 'Use a disposable case.');
  const name = `phase4_analytic_test-${randomUUID()}.vtk`;
  const filename = path.join(path.dirname(marker), name);
  let state: ParaViewWorkbenchState;
  const apply = async (action: string, data: Record<string, unknown>) => {
    const result = await sendParaViewCommand(action, data); if (result.state) state = result.state; return result;
  };
  try {
    await fs.writeFile(filename, analyticVtk(), 'utf8');
    state = await startParaViewSession(caseName, marker, process.env.OFSTUDIO_TEST_PVPYTHON!);
    await apply('open_case_file', { path: name });
    const sourceId = state.selectedId;
    const sourceGuard = currentAnalysisGuard(state);
    const point = (await apply('analysis_probe', { ...sourceGuard, block: 0, association: 'POINTS', position: [0.25, 0.25, 0.25] })).probe!;
    assert.equal(point.inside, true);
    assert.ok(Math.abs(point.values.find(array => array.name === 'p')!.components[0]! - 1.5) < 1e-8);
    assert.deepEqual(point.values.find(array => array.name === 'U')!.components, [-0.25, 0.25, 0]);
    const cell = (await apply('analysis_probe', { ...sourceGuard, block: 0, association: 'CELLS', position: [0.25, 0.25, 0.25] })).probe!;
    assert.equal(cell.values.find(array => array.name === 'constant')!.components[0], 7);
    const foundCells = (await apply('find_data', { ...sourceGuard, block: 0, association: 'CELLS', name: 'constant', component: 0, lower: 7, upper: 7 })).selection!;
    assert.equal(foundCells.matched, 8);
    assert.deepEqual(foundCells.rows[0].coordinate, [0.25, 0.25, 0.25]);
    const outside = (await apply('analysis_probe', { ...sourceGuard, block: 0, association: 'POINTS', position: [2, 2, 2] })).probe!;
    assert.equal(outside.inside, false); assert.ok(outside.values.every(array => array.components.every(value => value === null)));
    await assert.rejects(apply('analysis_probe', { ...sourceGuard, revision: sourceGuard.revision - 1, block: 0, association: 'POINTS', position: [0, 0, 0] }), /changed/);
    const find = { ...sourceGuard, block: 0, association: 'POINTS', name: 'p', component: 0, lower: 1, upper: 2 };
    const found = (await apply('find_data', find)).selection!;
    assert.ok(found.rows.length > 0); assert.equal(found.matched, found.rows.length);
    assert.ok(found.rows.every(row => row.value >= 1 && row.value <= 2 && Math.abs(row.coordinate[0]! + 2 * row.coordinate[1]! + 3 * row.coordinate[2]! - row.value) < 1e-8));
    await apply('selection_extract', find);
    assert.equal(state.pipeline.find(node => node.id === state.selectedId)!.type, 'Selection');
    assert.equal(state.points, found.matched);
    await apply('select', { id: sourceId });
    await apply('cfd_diagnostic', { ...currentAnalysisGuard(state), diagnostic: { association: 'POINTS', name: 'U', prefix: 'Rotation' } });
    const diagnosticId = state.selectedId;
    const schema = (await apply('data_table', { ...currentAnalysisGuard(state), mode: 'schema', association: 'POINTS', block: 0 })).table!;
    for (const [name, component, expected] of [['RotationDivergence', 0, 0], ['RotationQCriterion', 0, 1], ['RotationVorticity', 2, 2]] as const) {
      const column = schema.columns.find(item => item.name === name && item.component === component)!;
      assert.ok(column, `Missing ${name}`);
      const rows = (await apply('data_table', { ...currentAnalysisGuard(state), mode: 'page', association: 'POINTS', block: 0, columns: [column.index] })).table!.rows;
      assert.ok(rows.every(row => Math.abs(row[0]! - expected) < 1e-8), `${name} expected ${expected}: ${JSON.stringify(rows)}`);
    }
    await apply('select', { id: sourceId });
    const otherNode = (await apply('data_table', { ...currentAnalysisGuard(state), id: diagnosticId, mode: 'page', association: 'POINTS', block: 0, columns: [0] })).table!;
    assert.equal(otherNode.id, diagnosticId, 'Split charts must read a source independently of the selected 3D node.');
    await apply('resample_to_image', { ...currentAnalysisGuard(state), dimensions: [12, 10, 8] });
    const resampleId = state.selectedId;
    assert.equal(state.points, 960);
    assert.equal(state.pipeline.find(node => node.id === resampleId)!.volumeCapabilities!.supported, true);
    const opacity = { opacityPoints: [[0, 0], [3, 0.2], [6, 0.8]], unitDistance: 0.1 };
    await assert.rejects(apply('update', { ...currentAnalysisGuard(state), revision: state.dataRevision - 1, representation: 'Volume', color: { association: 'POINTS', name: 'p', preset: state.presets[0], legend: true }, volume: opacity }), /changed/);
    await apply('update', { ...currentAnalysisGuard(state), representation: 'Volume', color: { association: 'POINTS', name: 'p', preset: state.presets[0], legend: true }, volume: opacity });
    assert.ok((await readParaViewRender(640, 480, 85)).byteLength > 1000);
    const workspace = parseParaViewWorkspace((await apply('workspace_capture', {})).workspace);
    workspace.clientView = { mode: 'split', chartSourceId: diagnosticId };
    assert.deepEqual(parseParaViewWorkspace(workspace).clientView, workspace.clientView);
    const badView = structuredClone(workspace); badView.clientView!.chartSourceId = 'unknown';
    assert.throws(() => parseParaViewWorkspace(badView), /chart source/);
    await apply('workspace_restore', { workspace });
    const expectedWorkspace = structuredClone(workspace); delete expectedWorkspace.clientView;
    assert.deepEqual((await apply('workspace_capture', {})).workspace, expectedWorkspace);
    assert.deepEqual(state.pipeline.find(node => node.id === resampleId)!.volume, opacity);
    assert.ok((await readParaViewRender(640, 480, 85)).byteLength > 1000);
    const snapshot = (await apply('capture_view', {})).view!;
    await apply('apply_view', { view: snapshot });
    assert.deepEqual(state.pipeline.find(node => node.id === resampleId)!.volume, opacity);
    await apply('select', { id: sourceId });
    await apply('resample_to_image', { ...currentAnalysisGuard(state), dimensions: [6, 6, 6] });
    const secondVolumeId = state.selectedId;
    const secondOpacity = { opacityPoints: [[0, 0.3], [3, 0.6], [6, 1]], unitDistance: 0.2 };
    await apply('update', { ...currentAnalysisGuard(state), representation: 'Volume', color: { association: 'POINTS', name: 'p', preset: state.presets[0], legend: false }, volume: secondOpacity });
    const views = (await apply('capture_view', {})).view!.nodes as Record<string, { volume: unknown }>;
    assert.deepEqual(views[resampleId].volume, opacity, 'The first p volume keeps its own actual opacity function.');
    assert.deepEqual(views[secondVolumeId].volume, secondOpacity, 'The second p volume uses an independent opacity function.');
    const twoVolumes = parseParaViewWorkspace((await apply('workspace_capture', {})).workspace);
    await apply('workspace_restore', { workspace: twoVolumes });
    assert.deepEqual((await apply('workspace_capture', {})).workspace, twoVolumes);
  } finally { await stopParaViewSession(); await fs.unlink(filename).catch(() => undefined); }
});

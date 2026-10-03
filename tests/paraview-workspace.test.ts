import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { parseParaViewWorkspace, WORKSPACE_PARAMETER_SCHEMA, type ParaViewWorkspace } from '../src/lib/paraview-workspace.ts';
import { readParaViewRender, sendParaViewCommand, startParaViewSession, stopParaViewSession } from '../src/lib/paraview.ts';

function workspace(): ParaViewWorkspace {
  return {
    format: 'openfoam-studio-paraview', version: 1, caseName: 'workspace_test', paraviewVersion: '6.2.0', selectedId: 'filter-1',
    reader: { caseType: 'Reconstructed Case', regions: ['internalMesh'] }, centerAxes: false,
    nodes: [
      { id: 'reader', type: 'OpenFOAMReader', parent: null, parameters: { lineWidth: 1, pointSize: 3 } },
      { id: 'filter-1', type: 'Slice', parent: 'reader', parameters: { origin: [0, 0, 0], normal: [1, 0, 0], lineWidth: 2, pointSize: 5 } },
    ],
    view: {
      time: 0.1,
      camera: { position: [1, 2, 3], focalPoint: [0, 0, 0], viewUp: [0, 1, 0], viewAngle: 30, parallelScale: 1, parallel: false },
      nodes: Object.fromEntries(['reader', 'filter-1'].map(id => [id, { label: id, visible: true, representation: 'Surface', opacity: 1, color: { association: 'SOLID', name: '', preset: 'Cool to Warm', legend: false, range: null } }])),
      view: { background: 'ParaView Dark', orientationAxes: true },
    },
  };
}

test('workspace parser round-trips independent filter parameters, camera and video snapshots', () => {
  const input = workspace();
  input.video = { start: 0, segments: [{ until: 0.1, transition: 'smooth', view: input.view }], timing: { mode: 'perStep', secondsPerStep: 0.25 }, fps: 30, interpolate: false, resolution: '1080p', format: 'mp4', colorRange: 'captured' };
  assert.deepEqual(parseParaViewWorkspace(input), input);
  const parsed = parseParaViewWorkspace(input); parsed.nodes[0].parameters.lineWidth = 2;
  assert.equal(input.nodes[0].parameters.lineWidth, 1, 'Parsing produces an independent document.');
  assert.equal(Object.keys(WORKSPACE_PARAMETER_SCHEMA).length, 28);
});

test('workspace imports reject unsupported commands, proxy properties, corrupt topology and case escapes', () => {
  for (const mutate of [
    (item: ParaViewWorkspace) => { item.version = 2 as 1; },
    (item: ParaViewWorkspace) => { item.nodes[1].type = 'PythonCalculator' as 'Slice'; },
    (item: ParaViewWorkspace) => { item.nodes[1].parameters.Input = 'reader'; },
    (item: ParaViewWorkspace) => { item.nodes[1].parameters.normal = [NaN, 0, 0]; },
    (item: ParaViewWorkspace) => { item.nodes[1].parent = 'filter-2'; },
    (item: ParaViewWorkspace) => { item.nodes[1].id = 'reader'; },
    (item: ParaViewWorkspace) => { item.selectedId = 'unknown'; },
    (item: ParaViewWorkspace) => { item.view.camera = { position: [1, 2] }; },
    (item: ParaViewWorkspace) => { item.nodes[1] = { id: 'source-1', type: 'CaseFileReader', parent: null, filePath: '../outside.csv', parameters: { lineWidth: 1, pointSize: 3 } }; },
    (item: ParaViewWorkspace) => { item.caseName = '../other'; },
  ]) {
    const item = workspace(); mutate(item);
    assert.throws(() => parseParaViewWorkspace(item));
  }
  const tooMany = workspace(); tooMany.nodes = Array(65).fill(tooMany.nodes[0]);
  assert.throws(() => parseParaViewWorkspace(tooMany), /64/);
});

test('timeline snapshots can predate later filters but cannot refer to deleted items', () => {
  const input = workspace();
  const early = structuredClone(input.view); delete (early.nodes as Record<string, unknown>)['filter-1'];
  input.video = { start: 0, segments: [{ until: 0.1, transition: 'cut', view: early }], timing: { mode: 'realTime', videoSecondsPerSimSecond: 1 }, fps: 30, interpolate: false, resolution: '720p', format: 'ogv', colorRange: 'perFrame' };
  assert.ok(parseParaViewWorkspace(input).video);
  (early.nodes as Record<string, unknown>)['filter-2'] = {};
  assert.throws(() => parseParaViewWorkspace(input), /match/);
});

test('native workspaces rebuild branches and case-file readers across sessions and roll back unavailable fields', {
  skip: !process.env.OFSTUDIO_TEST_PVPYTHON || !process.env.OFSTUDIO_TEST_PVCASE,
  timeout: 600_000,
}, async () => {
  const marker = process.env.OFSTUDIO_TEST_PVCASE!;
  const caseName = path.basename(path.dirname(marker));
  assert.ok(caseName === 'test' || caseName.endsWith('_test'), 'Use a disposable case.');
  const executable = process.env.OFSTUDIO_TEST_PVPYTHON!;
  try {
    const initial = await startParaViewSession(caseName, marker, executable);
    await sendParaViewCommand('update_reader', { regions: ['internalMesh'] });
    await sendParaViewCommand('time', { time: 0.05 });
    const slice = (await sendParaViewCommand('add_filter', { filter: 'Slice' })).state!;
    const sliceId = slice.selectedId;
    await sendParaViewCommand('update', { origin: [0.05, 0.05, 0.005], normal: [0, 0, 1], opacity: 0.65, lineWidth: 4, pointSize: 6, color: { association: 'CELLS', name: 'p', preset: initial.presets[1] ?? initial.presets[0], legend: true } });
    await sendParaViewCommand('select', { id: 'reader' });
    const line = (await sendParaViewCommand('add_filter', { filter: 'PlotOverLine' })).state!;
    const lineId = line.selectedId;
    await sendParaViewCommand('update', { plotOverLine: { point1: [0.005, 0.05, 0.005], point2: [0.095, 0.05, 0.005], resolution: 24 } });
    await sendParaViewCommand('open_case_file', { path: 'comparison.csv' });
    await sendParaViewCommand('select', { id: sliceId });
    await sendParaViewCommand('update_view', { centerAxes: true, background: 'White', parallelProjection: true });
    const saved = parseParaViewWorkspace((await sendParaViewCommand('workspace_capture')).workspace);
    assert.equal(saved.nodes.length, 4);
    await stopParaViewSession();
    await startParaViewSession(caseName, marker, executable);
    const restored = (await sendParaViewCommand('workspace_restore', { workspace: saved })).state!;
    assert.equal(restored.time, 0.05);
    assert.equal(restored.selectedId, sliceId);
    assert.equal(restored.pipeline.length, 4);
    assert.deepEqual(restored.pipeline.find(node => node.id === lineId)?.plotOverLine, { point1: [0.005, 0.05, 0.005], point2: [0.095, 0.05, 0.005], resolution: 24 });
    assert.equal(restored.pipeline.find(node => node.id === sliceId)?.lineWidth, 4);
    assert.equal(restored.pipeline.find(node => node.type === 'CaseFileReader')?.renderable, false);
    assert.equal(restored.view.centerAxes, true);
    const recaptured = parseParaViewWorkspace((await sendParaViewCommand('workspace_capture')).workspace);
    assert.deepEqual(recaptured, saved);
    const invalid = structuredClone(saved);
    const display = (invalid.view.nodes as Record<string, { color: { name: string } }>)[sliceId];
    display.color.name = 'missing_field';
    await assert.rejects(sendParaViewCommand('workspace_restore', { workspace: invalid }), /array it no longer has/);
    assert.deepEqual((await sendParaViewCommand('workspace_capture')).workspace, recaptured);
    const invalidTime = structuredClone(saved); invalidTime.view.time = 0.033333;
    await assert.rejects(sendParaViewCommand('workspace_restore', { workspace: invalidTime }), /timestep is no longer available/);
    assert.deepEqual((await sendParaViewCommand('workspace_capture')).workspace, recaptured);
    const video = structuredClone(saved);
    video.video = { start: 0.033333, segments: [{ until: 0.1, transition: 'smooth', view: saved.view }], timing: { mode: 'perStep', secondsPerStep: 0.25 }, fps: 30, interpolate: false, resolution: '1080p', format: 'mp4', colorRange: 'captured' };
    await assert.rejects(sendParaViewCommand('workspace_restore', { workspace: video }), /video start timestep/);
    assert.deepEqual((await sendParaViewCommand('workspace_capture')).workspace, recaptured);
    video.video.start = 0.005;
    await sendParaViewCommand('workspace_restore', { workspace: video });
    assert.deepEqual((await sendParaViewCommand('workspace_capture')).workspace, recaptured);
    await sendParaViewCommand('select', { id: 'reader' });
    const calculated = (await sendParaViewCommand('add_filter', { filter: 'Calculator' })).state!;
    const calculation = parseParaViewWorkspace((await sendParaViewCommand('workspace_capture')).workspace);
    const badCalculation = structuredClone(calculation);
    (badCalculation.nodes.find(node => node.id === calculated.selectedId)!.parameters.calculator as Record<string, unknown>).expression = 'missing_workspace_field';
    await assert.rejects(sendParaViewCommand('workspace_restore', { workspace: badCalculation }), /could not produce its result array/);
    assert.deepEqual((await sendParaViewCommand('workspace_capture')).workspace, calculation);
    await sendParaViewCommand('workspace_restore', { workspace: saved });
    const invalidFile = structuredClone(saved); invalidFile.nodes.find(node => node.type === 'CaseFileReader')!.filePath = 'missing.csv';
    await assert.rejects(sendParaViewCommand('workspace_restore', { workspace: invalidFile }), /inside the active case/);
    assert.deepEqual((await sendParaViewCommand('workspace_capture')).workspace, recaptured);
    const malformed = structuredClone(saved); malformed.nodes[1].parameters.Input = 'browser-proxy';
    await assert.rejects(sendParaViewCommand('workspace_restore', { workspace: malformed }), /Unsupported/);
    assert.ok((await readParaViewRender(640, 480, 85)).byteLength > 1000);
  } finally { await stopParaViewSession(); }
});

test('native workspace allowlist reproduces every available workbench filter and conversion input', {
  skip: !process.env.OFSTUDIO_TEST_PVPYTHON || !process.env.OFSTUDIO_TEST_PVCASE,
  timeout: 600_000,
}, async () => {
  const marker = process.env.OFSTUDIO_TEST_PVCASE!;
  const caseName = path.basename(path.dirname(marker));
  assert.ok(caseName === 'test' || caseName.endsWith('_test'), 'Use a disposable case.');
  try {
    const initial = await startParaViewSession(caseName, marker, process.env.OFSTUDIO_TEST_PVPYTHON!);
    await sendParaViewCommand('update_reader', { regions: ['internalMesh'] });
    let lineId = '';
    for (const kind of initial.availableFilters) {
      if (kind === 'Tube') {
        await sendParaViewCommand('select', { id: 'reader' });
        lineId = (await sendParaViewCommand('add_filter', { filter: 'PlotOverLine' })).state!.selectedId;
      }
      await sendParaViewCommand('select', { id: kind === 'Tube' ? lineId : 'reader' });
      await sendParaViewCommand('add_filter', { filter: kind });
    }
    const saved = parseParaViewWorkspace((await sendParaViewCommand('workspace_capture')).workspace);
    assert.ok(saved.nodes.length > initial.availableFilters.length);
    const restored = (await sendParaViewCommand('workspace_restore', { workspace: saved })).state!;
    assert.equal(restored.pipeline.length, saved.nodes.length);
    assert.deepEqual((await sendParaViewCommand('workspace_capture')).workspace, saved);
  } finally { await stopParaViewSession(); }
});

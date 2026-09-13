import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAgentTranscriptEvent, type AgentTranscriptBlock } from '../src/lib/agent-transcript';

function fold(events: Record<string, unknown>[]): AgentTranscriptBlock[] {
  return events.reduce(applyAgentTranscriptEvent, [] as AgentTranscriptBlock[]);
}

test('an authoritative agent snapshot replaces its streamed deltas', () => {
  const blocks = fold([
    { t: 'block_start', channel: 'text', id: 'answer-1' },
    { t: 'delta', channel: 'text', id: 'answer-1', text: 'Half' },
    { t: 'block_end', channel: 'text', id: 'answer-1', text: 'Complete answer' },
  ]);
  assert.deepEqual(blocks, [{ kind: 'text', id: 'answer-1', text: 'Complete answer', live: false }]);
});

test('growing live snapshots do not duplicate Markdown list items', () => {
  const one = '- mesh fully 3D';
  const two = `${one}\n- resolution to dissipative scales`;
  const three = `${two}\n- smaller timestep`;
  const blocks = fold([
    { t: 'block_start', channel: 'text', id: 'answer-1' },
    { t: 'delta', channel: 'text', id: 'answer-1', text: one },
    { t: 'delta', channel: 'text', id: 'answer-1', text: two },
    { t: 'delta', channel: 'text', id: 'answer-1', text: three },
    { t: 'block_end', channel: 'text', id: 'answer-1', text: three },
  ]);
  assert.deepEqual(blocks, [{ kind: 'text', id: 'answer-1', text: three, live: false }]);
});

test('equal incremental deltas remain intentional repeated text', () => {
  const blocks = fold([
    { t: 'block_start', channel: 'text', id: 'answer-1' },
    { t: 'delta', channel: 'text', id: 'answer-1', text: 'ha' },
    { t: 'delta', channel: 'text', id: 'answer-1', text: 'ha' },
  ]);
  assert.deepEqual(blocks, [{ kind: 'text', id: 'answer-1', text: 'haha', live: true }]);
});

test('replayed snapshots and tool calls do not duplicate the transcript', () => {
  const blocks = fold([
    { t: 'block_end', channel: 'text', id: 'answer-1', text: 'Complete answer' },
    { t: 'tool_use', id: 'call-1', name: 'case_info', input: { case: 'test' } },
    { t: 'block_end', channel: 'text', id: 'answer-1', text: 'Complete answer' },
    { t: 'tool_use', id: 'call-1', name: 'case_info', input: { case: 'test' } },
  ]);
  assert.equal(blocks.filter(block => block.kind === 'text').length, 1);
  assert.equal(blocks.filter(block => block.kind === 'tool').length, 1);
});

test('equal text from different agent blocks remains distinct', () => {
  const blocks = fold([
    { t: 'block_end', channel: 'text', id: 'answer-1', text: 'Done.' },
    { t: 'block_end', channel: 'text', id: 'answer-2', text: 'Done.' },
  ]);
  assert.equal(blocks.length, 2);
});

test('directly repeated legacy snapshots without IDs are collapsed', () => {
  const blocks = fold([
    { t: 'block_end', channel: 'text', text: 'One answer' },
    { t: 'block_end', channel: 'text', text: 'One answer' },
  ]);
  assert.equal(blocks.length, 1);
});

test('growing snapshots with fresh IDs replace an adjacent earlier answer', () => {
  const blocks = fold([
    { t: 'block_end', channel: 'text', id: 'answer-1', text: '1. blockMesh' },
    { t: 'block_end', channel: 'text', id: 'answer-2', text: '1. blockMesh\n2. decomposePar' },
    { t: 'block_end', channel: 'text', id: 'answer-3', text: '1. blockMesh\n2. decomposePar\n3. foamRun' },
  ]);
  assert.deepEqual(blocks, [
    { kind: 'text', id: 'answer-3', text: '1. blockMesh\n2. decomposePar\n3. foamRun', live: false },
  ]);
});

test('growing snapshots around tools keep order and render only each new suffix', () => {
  const blocks = fold([
    { t: 'block_end', channel: 'text', id: 'answer-1', text: '1. blockMesh' },
    { t: 'tool_use', id: 'call-1', name: 'run_openfoam', input: { command: 'blockMesh' } },
    { t: 'block_start', channel: 'text', id: 'answer-2' },
    { t: 'delta', channel: 'text', id: 'answer-2', text: '2. decomposePar' },
    { t: 'block_end', channel: 'text', id: 'answer-2', text: '1. blockMesh\n2. decomposePar' },
    { t: 'tool_use', id: 'call-2', name: 'run_openfoam', input: { command: 'decomposePar' } },
    { t: 'block_end', channel: 'text', id: 'answer-3', text: '1. blockMesh\n2. decomposePar\n3. foamRun' },
  ]);
  assert.deepEqual(blocks.map(block => block.kind === 'tool' ? block.name : block.text), [
    '1. blockMesh', 'run_openfoam', '2. decomposePar', 'run_openfoam', '3. foamRun',
  ]);
});

test('a fresh live block hides the cumulative summary before its final snapshot arrives', () => {
  const first = '- Profile: 32 grooves\n- Radius: 0.2 m';
  const second = `${first}\n- Depth: 0.015 m`;
  const events = [
    { t: 'block_start', channel: 'text', id: 'answer-1' },
    { t: 'delta', channel: 'text', id: 'answer-1', text: first },
    { t: 'block_end', channel: 'text', id: 'answer-1', text: first },
    { t: 'tool_use', id: 'call-1', name: 'read_case_file', input: { case: 'test', path: 'system/blockMeshDict' } },
    { t: 'tool_result', id: 'call-1', ok: true, text: 'file' },
    { t: 'block_start', channel: 'text', id: 'answer-2' },
    // Reproduce the real trace: ordinary token chunks reconstruct the complete
    // earlier summary before the provider adds the new bullet.
    ...['- Pro', 'file: 32 ', 'grooves\n', '- Radius:', ' 0.2 m', '\n- Dep', 'th: 0.015 m']
      .map(text => ({ t: 'delta', channel: 'text', id: 'answer-2', text })),
  ];
  const blocks = fold(events);
  assert.deepEqual(blocks.map(block => block.kind === 'tool' ? block.name : block.text), [
    first, 'read_case_file', '- Depth: 0.015 m',
  ]);
  assert.equal((blocks.at(-1) as Extract<AgentTranscriptBlock, { kind: 'text' }>).snapshot, second);
});

test('the authoritative done result replaces every cumulative preview', () => {
  const one = '\\(U_\\infty=10\\)';
  const two = `${one}\n\\(D=0.4\\)\n\\(\\nu=1.5e-5\\)`;
  const final = `${two}\ntherefore \\(Re_D=2.7e5\\)`;
  const blocks = fold([
    { t: 'block_start', channel: 'text', id: 'preview-1' },
    { t: 'delta', channel: 'text', id: 'preview-1', text: one },
    // Deliberately omit block_end: this reproduces the worst provider preview.
    { t: 'block_start', channel: 'text', id: 'preview-2' },
    { t: 'delta', channel: 'text', id: 'preview-2', text: two },
    { t: 'tool_use', id: 'call-1', name: 'foam_help', input: {} },
    { t: 'tool_result', id: 'call-1', ok: true, text: 'result' },
    { t: 'block_start', channel: 'text', id: 'preview-3' },
    { t: 'delta', channel: 'text', id: 'preview-3', text: final },
    { t: 'done', ok: true, text: final },
  ]);
  assert.deepEqual(blocks.map(block => block.kind === 'tool' ? block.name : block.text), [
    'foam_help', final,
  ]);
  assert.equal(blocks.filter(block => block.kind === 'text').length, 1);
});

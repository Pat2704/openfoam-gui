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

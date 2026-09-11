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

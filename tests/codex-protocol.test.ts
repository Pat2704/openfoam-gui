import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Rpc } from '../src/lib/codex-rpc';
import { modelChoices, panelEvents } from '../src/lib/codex-protocol';

test('Codex models use account catalog ids and each model’s actual reasoning levels', () => {
  const result = modelChoices([{ model: 'available', displayName: 'Available', isDefault: true,
    defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Thorough' }] },
    { model: 'hidden', hidden: true }, { id: 'invalid' }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'available');
  assert.deepEqual(result[0].efforts, [{ id: 'high', label: 'high', hint: 'Thorough' }]);
  assert.deepEqual(modelChoices(null), []);
});

test('Codex streams public summaries and authoritative text without exposing raw reasoning', () => {
  assert.deepEqual(panelEvents('item/reasoning/textDelta', { delta: 'private' }), []);
  assert.deepEqual(panelEvents('item/reasoning/summaryTextDelta', { itemId: 'reason-1', delta: 'Checking' }), [{ t: 'delta', channel: 'thinking', text: 'Checking', id: 'reason-1' }]);
  assert.deepEqual(panelEvents('item/completed', { item: { id: 'answer-1', type: 'agentMessage', text: 'Complete' } }), [{ t: 'block_end', channel: 'text', text: 'Complete', id: 'answer-1' }]);
  assert.deepEqual(panelEvents('error', { willRetry: true, error: { message: 'transient' } }), []);
});

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const writes: any[] = []; const notices: any[] = []; const failures: Error[] = [];
  child.stdin.on('data', data => writes.push(JSON.parse(data.toString())));
  const rpc = new Rpc(child as unknown as ChildProcessWithoutNullStreams, m => notices.push(m), e => failures.push(e));
  return { child, rpc, writes, notices, failures };
}

test('Codex RPC correlates out-of-order replies and reconstructs split UTF-8 frames', async () => {
  const f = fixture();
  const a = f.rpc.request('first'); const b = f.rpc.request('second');
  const frame = Buffer.from(JSON.stringify({ id: f.writes[1].id, result: 'è' }) + '\n');
  const cut = frame.indexOf(Buffer.from('è')) + 1;
  f.child.stdout.write(frame.subarray(0, cut)); f.child.stdout.write(frame.subarray(cut));
  f.child.stdout.write(JSON.stringify({ method: 'item/started', params: {} }) + '\n');
  f.child.stdout.write(JSON.stringify({ id: f.writes[0].id, result: 'one' }) + '\n');
  assert.equal(await b, 'è'); assert.equal(await a, 'one');
  assert.equal(f.notices.length, 1); f.rpc.close();
});

test('Codex RPC fails pending requests once when a process exits', async () => {
  const f = fixture(); const request = f.rpc.request('waiting');
  f.child.emit('exit', 1, null); f.child.emit('error', new Error('second event'));
  await assert.rejects(request, /Codex stopped/);
  await assert.rejects(f.rpc.request('after'), /not connected/);
  assert.equal(f.failures.length, 1);
});

test('Codex RPC timeout leaves the transport usable for the next request', async () => {
  const f = fixture(); await assert.rejects(f.rpc.request('slow', {}, 5), /timed out/);
  const next = f.rpc.request('retry');
  f.child.stdout.write(JSON.stringify({ id: f.writes.at(-1).id, result: true }) + '\n');
  assert.equal(await next, true); f.rpc.close();
});

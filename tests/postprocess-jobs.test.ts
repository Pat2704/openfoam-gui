import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { PostProcessJobs, type PostProcessTask } from '../src/lib/postprocess-jobs';

function deferredTask() {
  let finish!: (result: { exitCode: number; command: string }) => void;
  let fail!: (error: Error) => void;
  let cancellations = 0;
  const completion = new Promise<{ exitCode: number; command: string }>((resolve, reject) => { finish = resolve; fail = reject; });
  const task: PostProcessTask = { completion, cancel: async () => { cancellations += 1; } };
  return { task, finish, fail, cancellations: () => cancellations };
}

test('a job streams output and finishes without blocking another case', async () => {
  const jobs = new PostProcessJobs();
  const first = deferredTask();
  let output!: (chunk: string) => void;
  const job = jobs.start('first_test', 'foam14', 'mag(U)', emit => { output = emit; return first.task; });
  const other = deferredTask();
  const second = jobs.start('second_test', 'foam14', 'mag(U)', () => other.task);
  output('Time = 1\n');
  assert.equal(jobs.get('first_test', 'foam14', job.id)?.output, 'Time = 1\n');
  assert.equal(jobs.get('second_test', 'foam14', second.id)?.status, 'running');
  first.finish({ exitCode: 0, command: 'foamPostProcess' });
  await setImmediate();
  assert.equal(jobs.get('first_test', 'foam14', job.id)?.status, 'done');
  assert.ok(jobs.get('first_test', 'foam14', job.id)?.finishedAt);
  assert.equal(jobs.get('second_test', 'foam14', second.id)?.status, 'running');
  other.finish({ exitCode: 0, command: 'foamPostProcess' });
});

test('duplicate launches and cross-case or cross-installation cancellation are refused', async () => {
  const jobs = new PostProcessJobs();
  const pending = deferredTask();
  const job = jobs.start('first_test', 'foam14', 'mag(U)', () => pending.task);
  assert.throws(() => jobs.start('first_test', 'foam14', 'mag(U)', () => pending.task), /already running/);
  assert.throws(() => jobs.get('second_test', 'foam14', job.id), /another case/);
  await assert.rejects(jobs.cancel('first_test', 'foam13', job.id), /installation/);
  assert.equal(pending.cancellations(), 0);
  await jobs.cancel('first_test', 'foam14', job.id);
  await jobs.cancel('first_test', 'foam14', job.id);
  assert.equal(pending.cancellations(), 1);
  assert.equal(jobs.get('first_test', 'foam14', job.id)?.status, 'cancelling');
  pending.finish({ exitCode: 143, command: 'foamPostProcess' });
  await setImmediate();
  assert.equal(jobs.get('first_test', 'foam14', job.id)?.status, 'cancelled');
});

test('output is bounded and failure retains useful diagnostics', async () => {
  const jobs = new PostProcessJobs();
  const pending = deferredTask();
  let output!: (chunk: string) => void;
  const job = jobs.start('first_test', 'foam14', 'mag(U)', emit => { output = emit; return pending.task; });
  output('old\n' + 'x'.repeat(300000));
  output('\nlast timestep\n');
  const snapshot = jobs.get('first_test', 'foam14', job.id)!;
  assert.equal(snapshot.output.length, 256 * 1024);
  assert.equal(snapshot.outputTruncated, true);
  assert.ok(snapshot.output.endsWith('last timestep\n'));
  snapshot.output = 'a caller cannot change the stored job';
  assert.notEqual(jobs.get('first_test', 'foam14', job.id)?.output, snapshot.output);
  pending.fail(new Error('WSL unavailable'));
  await setImmediate();
  assert.equal(jobs.get('first_test', 'foam14', job.id)?.status, 'failed');
  assert.match(jobs.get('first_test', 'foam14', job.id)!.output, /WSL unavailable/);
});

test('a failed cancellation keeps the running job available for a retry', async () => {
  const jobs = new PostProcessJobs();
  const pending = deferredTask();
  let attempts = 0;
  pending.task.cancel = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('WSL temporarily unavailable');
  };
  const job = jobs.start('first_test', 'foam14', 'mag(U)', () => pending.task);
  await assert.rejects(jobs.cancel('first_test', 'foam14', job.id), /temporarily unavailable/);
  assert.equal(jobs.get('first_test', 'foam14', job.id)?.status, 'running');
  await jobs.cancel('first_test', 'foam14', job.id);
  pending.finish({ exitCode: 143, command: 'foamPostProcess' });
  await setImmediate();
  assert.equal(attempts, 2);
  assert.equal(jobs.get('first_test', 'foam14', job.id)?.status, 'cancelled');
});

test('launch failures leave no phantom job and old finished jobs are retired', async () => {
  const jobs = new PostProcessJobs();
  assert.throws(() => jobs.start('first_test', 'foam14', 'mag(U)', () => { throw new Error('invalid options'); }), /invalid options/);
  assert.equal(jobs.get('first_test', 'foam14'), null);
  let oldest = '';
  for (let index = 0; index < 33; index += 1) {
    const job = jobs.start('first_test', 'foam14', 'mag(U)', () => ({
      completion: Promise.resolve({ exitCode: 0, command: 'foamPostProcess' }), cancel: async () => {},
    }));
    if (index === 0) oldest = job.id;
    await setImmediate();
  }
  assert.equal(jobs.get('first_test', 'foam14', oldest), null);
  assert.equal(jobs.get('first_test', 'foam14')?.status, 'done');
});

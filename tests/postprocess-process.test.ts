import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Exercise the production runner with controlled process and timer boundaries,
// without sourcing OpenFOAM or launching WSL against a real case.
const source = readFileSync(new URL('../src/lib/wsl.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('wsl.ts', source, ts.ScriptTarget.Latest, true);
const runner = parsed.statements.find(statement => ts.isFunctionDeclaration(statement)
  && statement.name?.text === 'startPostProcessFunction');
assert.ok(runner, 'the production post-processing runner must exist');
const compiled = ts.transpileModule(runner.getText(parsed), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

class FakeStream extends EventEmitter {
  input = '';
  setEncoding() {}
  end(value: string | Buffer) { this.input = String(value); }
}

class FakeChild extends EventEmitter {
  stdin = new FakeStream();
  stdout = new FakeStream();
  stderr = new FakeStream();
  kills = 0;
  kill() { this.kills += 1; return true; }
}

interface Task {
  completion: Promise<{ exitCode: number; command: string }>;
  cancel(): Promise<void>;
}

function fixture() {
  const children: FakeChild[] = [];
  const timers = new Map<number, { callback: () => void; milliseconds: number }>();
  let timerId = 0;
  const output: string[] = [];
  const exports: { startPostProcessFunction?: (caseName: string, spec: string, options: object, output: (chunk: string) => void) => Task } = {};
  runInNewContext(compiled, {
    exports, Buffer, process: { env: {} },
    postProcessScript: () => 'echo validated-case-script',
    getDistro: () => 'Foundation-test-distro',
    randomBytes: () => Buffer.alloc(24, 0xab),
    spawn: (executable: string, args: string[], options: { windowsHide: boolean }) => {
      assert.equal(executable, 'wsl');
      assert.deepEqual(Array.from(args).slice(0, 2), ['-d', 'Foundation-test-distro']);
      assert.equal(options.windowsHide, true);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    setTimeout: (callback: () => void, milliseconds: number) => {
      const id = ++timerId;
      timers.set(id, { callback, milliseconds });
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  const task = exports.startPostProcessFunction!('lifecycle_test', 'mag(U)', {}, chunk => output.push(chunk));
  const child = children[0];
  const script = Buffer.from(child.stdin.input, 'base64').toString('utf8');
  const marker = script.match(/__OFSTUDIO_JOB_[a-f0-9]+:/)?.[0];
  assert.ok(marker);
  return {
    task, child, children, output, timers,
    handshake: () => child.stdout.emit('data', `${marker}1234\n`),
    fire: (milliseconds: number) => {
      const pending = [...timers].filter(([, timer]) => timer.milliseconds === milliseconds);
      assert.ok(pending.length, `expected a ${milliseconds}ms timer`);
      for (const [id, timer] of pending) { timers.delete(id); timer.callback(); }
    },
  };
}

test('cancellation waits for the PID handshake, propagates killer failure and permits retry', async () => {
  const f = fixture();
  let settled = false;
  const cancellation = f.task.cancel();
  void cancellation.then(() => { settled = true; }, () => { settled = true; });
  await setImmediate();
  assert.equal(settled, false);
  assert.equal(f.children.length, 1, 'no signal process is started without an owned PID');
  f.handshake();
  await setImmediate();
  assert.equal(f.children.length, 2);
  const rejected = assert.rejects(cancellation, /killer unavailable/);
  f.children[1].emit('error', new Error('killer unavailable'));
  await rejected;

  const retry = f.task.cancel();
  await setImmediate();
  assert.equal(f.children.length, 3, 'a rejected cancellation is not permanently cached');
  const signalScript = Buffer.from(f.children[2].stdin.input, 'base64').toString('utf8');
  assert.match(signalScript, /pid=1234/);
  assert.match(signalScript, /OFSTUDIO_POSTPROCESS_JOB=/);
  f.children[2].emit('close', 0);
  await retry;
  f.child.stdout.emit('data', 'OFSTUDIO_EXIT=143\n');
  f.child.emit('close', 0);
  assert.equal((await f.task.completion).exitCode, 143);
  assert.equal(f.timers.size, 0);
});

test('a close before the PID handshake resolves waiting cancellation without launching a killer', async () => {
  const f = fixture();
  const cancellation = f.task.cancel();
  f.child.emit('close', 1);
  await cancellation;
  assert.equal((await f.task.completion).exitCode, 1);
  assert.equal(f.children.length, 1);
  assert.equal(f.timers.size, 0);
});

test('startup cancellation has a bounded wait and can be retried after the handshake', async () => {
  const f = fixture();
  const rejected = assert.rejects(f.task.cancel(), /has not started yet; retry cancellation/);
  f.fire(10000);
  await rejected;
  assert.equal(f.children.length, 1);
  f.handshake();
  const retry = f.task.cancel();
  await setImmediate();
  f.children[1].emit('close', 0);
  await retry;
  f.child.emit('close', 143);
  assert.equal((await f.task.completion).exitCode, 143);
});

test('timeout without a PID settles completion and kills the host even without a close event', async () => {
  const f = fixture();
  const rejected = assert.rejects(f.task.completion, /timed out after ten minutes/);
  f.fire(600000);
  await rejected;
  assert.equal(f.child.kills, 1);
  assert.equal(f.children.length, 1);
});

test('timeout with an owned PID reports cleanup failure and always settles completion', async () => {
  const f = fixture();
  f.handshake();
  const rejected = assert.rejects(f.task.completion, /timed out after ten minutes/);
  f.fire(600000);
  assert.equal(f.children.length, 2);
  f.children[1].stderr.emit('data', 'WSL signal transport failed');
  f.children[1].emit('close', 1);
  await rejected;
  assert.equal(f.child.kills, 1);
  assert.match(f.output.join(''), /WSL signal transport failed/);
  assert.match(f.output.join(''), /cleanup could not be confirmed/);
});

test('an unresponsive killer is bounded and timeout still kills the host and rejects completion', async () => {
  const f = fixture();
  f.handshake();
  const rejected = assert.rejects(f.task.completion, /timed out after ten minutes/);
  f.fire(600000);
  f.fire(10000);
  await rejected;
  assert.equal(f.children[1].kills, 1);
  assert.equal(f.child.kills, 1);
  assert.match(f.output.join(''), /Cancelling the WSL job timed out/);
});

test('chunked protocol markers stay private and trailing output and real exit status survive', async () => {
  const f = fixture();
  f.handshake();
  f.child.stdout.emit('data', 'OFSTUDIO_UTI');
  f.child.stdout.emit('data', 'LITY=foamPostProcess\nTime = 1\r\nOFSTUDIO_EXIT=7\ntrailing diagnostics');
  f.child.stderr.emit('data', 'stderr diagnostics\n');
  f.child.emit('close', 0);
  const result = await f.task.completion;
  assert.equal(result.exitCode, 7);
  assert.equal(result.command, 'foamPostProcess');
  assert.equal(f.output.join(''), 'Time = 1\nstderr diagnostics\ntrailing diagnostics\n');
  assert.doesNotMatch(f.output.join(''), /OFSTUDIO_|__OFSTUDIO_JOB/);
  assert.equal(f.timers.size, 0);
});

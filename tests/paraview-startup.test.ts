import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  abortParaViewStartup, getParaViewSession, getParaViewWarmup,
  readParaViewRender, startParaViewSession,
  stopParaViewSession, stopParaViewWarmup, warmParaView,
} from '../src/lib/paraview.ts';

test('a prepared native ParaView engine activates once, renders and recovers after cancellation', {
  skip: !process.env.OFSTUDIO_TEST_PVPYTHON || !process.env.OFSTUDIO_TEST_PVCASE,
  timeout: 600_000,
}, async () => {
  const marker = process.env.OFSTUDIO_TEST_PVCASE!;
  const caseName = path.basename(path.dirname(marker));
  assert.ok(caseName === 'test' || caseName.endsWith('_test'), 'Use a disposable case.');
  const executable = process.env.OFSTUDIO_TEST_PVPYTHON!;
  try {
    const warm = await warmParaView(executable);
    assert.equal(warm?.state, 'warming');
    assert.equal(getParaViewSession(), null);
    await stopParaViewWarmup();
    assert.equal(getParaViewWarmup(), null);
    await warmParaView(executable);
    const interrupted = startParaViewSession(caseName, marker, executable);
    const interruptedResult = assert.rejects(interrupted, /cancelled|stopped/i);
    await new Promise(resolve => setTimeout(resolve, 50));
    await abortParaViewStartup();
    await interruptedResult;
    assert.equal(getParaViewSession(), null);
    await warmParaView(executable);
    const first = startParaViewSession(caseName, marker, executable);
    const joined = startParaViewSession(caseName, marker, executable);
    assert.equal(first, joined, 'Concurrent starts must join the same activation.');
    const state = await first;
    assert.equal(state.caseName, caseName);
    assert.ok(state.cells > 0);
    assert.equal(getParaViewWarmup()?.state, 'warm');
    const image = await readParaViewRender(640, 480, 85);
    assert.ok(image.byteLength > 1000);
    await stopParaViewWarmup();
    assert.equal(getParaViewSession()?.caseName, caseName, 'Disabling warm-up must preserve the active case.');
    await stopParaViewSession();
    assert.equal(getParaViewSession(), null);

    // Warm-up has been consumed. A normal start must still be cancellable and
    // a later fresh start must recover without adopting a dead process.
    const cancelled = startParaViewSession(caseName, marker, executable);
    const rejected = assert.rejects(cancelled, /cancelled|stopped/i);
    await abortParaViewStartup();
    await rejected;
    const restarted = await startParaViewSession(caseName, marker, executable);
    assert.equal(restarted.caseName, caseName);
    assert.ok(restarted.cells > 0);
  } finally {
    await stopParaViewSession();
    await stopParaViewWarmup();
  }
});

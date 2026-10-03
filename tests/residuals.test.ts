import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAllResiduals, parseResidualEvents, residualLogDomain, residualsToTable } from '../src/lib/residuals.ts';

// The shape `foamRun` writes, which is what almost every log looks like.
const FOAM_RUN_LOG = `
Starting time loop

Time = 0.005

Courant Number mean: 0 max: 0
smoothSolver:  Solving for Ux, Initial residual = 1, Final residual = 8.9e-06, No Iterations 19
smoothSolver:  Solving for Uy, Initial residual = 0, Final residual = 0, No Iterations 0
GAMG:  Solving for p, Initial residual = 1, Final residual = 7.5e-07, No Iterations 12
time step continuity errors : sum local = 4e-09

Time = 0.01

smoothSolver:  Solving for Ux, Initial residual = 0.522, Final residual = 5.2e-06, No Iterations 18
smoothSolver:  Solving for Uy, Initial residual = 0.213, Final residual = 4.1e-06, No Iterations 17
GAMG:  Solving for p, Initial residual = 0.363, Final residual = 8.8e-07, No Iterations 10

End
`;

test('the initial residual of each field is read for every timestep', () => {
  const { data, fields } = parseAllResiduals(FOAM_RUN_LOG);
  assert.deepEqual(fields.sort(), ['Ux', 'Uy', 'p']);
  assert.equal(data.length, 2);
  assert.equal(data[0].time, 0.005);
  // The INITIAL residual, not the final one: it is the error the solver started
  // the step with, which is what a convergence plot means.
  assert.equal(data[0].Ux, 1);
  assert.equal(data[1].p, 0.363);
});

test('real Foundation pressure correctors use first initial and last final, never last initial', () => {
  const log = `Time = 0.005s
GAMG:  Solving for p, Initial residual = 1, Final residual = 0.0378382, No Iterations 2
GAMG:  Solving for p, Initial residual = 0.0371368, Final residual = 6.05335e-07, No Iterations 10
Time = 0.01s
GAMG:  Solving for p, Initial residual = 0.142047, Final residual = 0.0132983, No Iterations 1
GAMG:  Solving for p, Initial residual = 0.0132778, Final residual = 8.78146e-07, No Iterations 7
`;
  assert.deepEqual(parseAllResiduals(log).data.map(point => point.p), [1, 0.142047]);
  assert.deepEqual(parseAllResiduals(log, { kind: 'final' }).data.map(point => point.p), [6.05335e-7, 8.78146e-7]);
  assert.deepEqual(residualsToTable(log, { kind: 'final' }).rows, [[0.005, 6.05335e-7], [0.01, 8.78146e-7]]);
  const events = parseResidualEvents(log).events;
  assert.equal(events[1].line, 3);
  assert.equal(events[1].iterations, 10);
  assert.equal(events[1].initial, 0.0371368);
  assert.equal(events[1].final, 6.05335e-7);
});

test('each field independently selects its first initial and last final solve', () => {
  const log = `Time = 1
solver: Solving for Ux, Initial residual = .4, Final residual = 4e-5, No Iterations 4
solver: Solving for p, Initial residual = .3, Final residual = 3e-5, No Iterations 3
solver: Solving for p, Initial residual = .8, Final residual = 8e-6, No Iterations 8
solver: Solving for Ux, Initial residual = .1, Final residual = 1e-7, No Iterations 1
solver: Solving for p, Initial residual = .02, Final residual = 2e-8, No Iterations 2
`;
  assert.deepEqual(parseAllResiduals(log).data[0], { time: 1, Ux: .4, p: .3 });
  assert.deepEqual(parseAllResiduals(log, { kind: 'final' }).data[0], { time: 1, Ux: 1e-7, p: 2e-8 });
});

test('recomputed timestep blocks replace all old fields before selecting residuals', () => {
  const log = `Time = 1
solver: Solving for p, Initial residual = .9, Final residual = 9e-6, No Iterations 2
Ux: iter = 1 residual = .6
Time = 2
p: iter = 1 residual = .8
Create time
solver: Solving for T, Initial residual = 1, Final residual = .5, No Iterations 1
Time = 1
solver: Solving for p, Initial residual = .3, Final residual = 3e-7, No Iterations 2
solver: Solving for p, Initial residual = .1, Final residual = 1e-8, No Iterations 1
Time = 2
`;
  const initial = parseAllResiduals(log);
  assert.deepEqual(initial.fields, ['p']);
  assert.deepEqual(initial.data, [{ time: 1, p: .3 }, { time: 2 }]);
  assert.deepEqual(parseAllResiduals(log, { kind: 'final' }).data, [{ time: 1, p: 1e-8 }, { time: 2 }]);
});

test('malformed times reset attribution; negative times and seconds units remain valid', () => {
  const log = 'Time = -2s\np: iter = 1 residual = .4\nTime = 1garbage\np: iter = 1 residual = .9\nTime = 1es\np: iter = 1 residual = .8\nTime = 1e999\np: iter = 1 residual = .7\n  Time = .5 s\np: iter = 1 residual = .2\n';
  assert.deepEqual(parseAllResiduals(log).data.map(point => [point.time, point.p]), [[-2, .4], [.5, .2]]);
});

test('missing or invalid final of the last solve never falls back to an earlier final or an initial', () => {
  for (const final of ['', ', Final residual = NaN', ', Final residual = 1e-7oops', ', Final residual = -1', ', Final residual = 1e999']) {
    const log = `Time = 1\nsolver: Solving for p, Initial residual = .4, Final residual = 4e-8, No Iterations 1\nsolver: Solving for p, Initial residual = .2${final}\n`;
    assert.equal(parseAllResiduals(log, { kind: 'final' }).data[0].p, undefined);
    assert.ok(Number.isNaN(residualsToTable(log, { kind: 'final' }).rows[0][1]));
  }
  const legacy = 'Time = 1\np: iter = 3 residual = .2\n';
  assert.equal(parseAllResiduals(legacy, { kind: 'final' }).data[0].p, undefined);
});

test('malformed first initial stays missing, while zero and scientific final values are preserved', () => {
  const log = 'Time = 1\nsolver: Solving for p, Initial residual = 1garbage, Final residual = 0, No Iterations 0\nsolver: Solving for p, Initial residual = .2, Final residual = +1.2E-10, No Iterations 2\n';
  assert.equal(parseAllResiduals(log).data[0].p, undefined);
  assert.equal(parseAllResiduals(log, { kind: 'final' }).data[0].p, 1.2e-10);
  assert.equal(parseAllResiduals(FOAM_RUN_LOG, { kind: 'final' }).data[0].Uy, 0);
});

test('indented CRLF logs and terminal colours preserve original source line provenance', () => {
  const log = '  \u001b[32mTime = 1e-2s\u001b[0m\r\n    solver: Solving for alpha.water, Initial residual = 1e-3, Final residual = 2e-9, No Iterations 4\r\n';
  assert.deepEqual(parseAllResiduals(log, { kind: 'final' }).data[0], { time: .01, 'alpha.water': 2e-9 });
  assert.equal(parseResidualEvents(log).events[0].line, 2);
});

test('timesteps come back in time order however the log was assembled', () => {
  const outOfOrder = 'Time = 2\nsmoothSolver:  Solving for p, Initial residual = 0.2, Final residual = 1e-8, No Iterations 3\nTime = 1\nsmoothSolver:  Solving for p, Initial residual = 0.9, Final residual = 1e-8, No Iterations 3\n';
  const { data } = parseAllResiduals(outOfOrder);
  assert.deepEqual(data.map(point => point.time), [1, 2]);
});

test('the two older solver output formats are still recognised', () => {
  const iterForm = parseAllResiduals('Time = 1\np: iter = 4 residual = 0.004\n');
  assert.equal(iterForm.data[0].p, 0.004);

  const tabular = parseAllResiduals('Time = 1\nUx  6  0.0021\n');
  assert.equal(tabular.data[0].Ux, 0.0021);
});

test('lines before the first timestep are not attributed to one', () => {
  // A solver banner can mention residuals before the time loop starts; without
  // a current time there is nothing to attach them to.
  const { data } = parseAllResiduals('smoothSolver:  Solving for Ux, Initial residual = 5, Final residual = 1, No Iterations 1\nTime = 1\n');
  assert.equal(data.length, 1);
  assert.equal(data[0].Ux, undefined);
});

test('residuals become the same table shape as a function-object dataset', () => {
  const table = residualsToTable(FOAM_RUN_LOG);
  assert.deepEqual(table.columns, ['Time', 'Ux', 'Uy', 'p']);
  assert.deepEqual(table.rows[0], [0.005, 1, 0, 1]);
  assert.equal(table.rows.length, 2);
});

test('a field with no residual at a timestep is a gap, never a zero', () => {
  // A zero on a logarithmic axis draws a line to the floor and reads as perfect
  // convergence, on a step where the solver simply did not solve for that field.
  const table = residualsToTable('Time = 1\nsmoothSolver:  Solving for Ux, Initial residual = 0.5, Final residual = 1e-9, No Iterations 2\nTime = 2\nsmoothSolver:  Solving for p, Initial residual = 0.2, Final residual = 1e-9, No Iterations 2\n');
  assert.deepEqual(table.columns, ['Time', 'Ux', 'p']);
  assert.ok(Number.isNaN(table.rows[0][2]), 'p has no residual at t=1');
  assert.ok(Number.isNaN(table.rows[1][1]), 'Ux has no residual at t=2');
});

test('a log with no residuals at all yields an empty table rather than a broken one', () => {
  assert.deepEqual(residualsToTable('blockMesh finished\nEnd\n'), { columns: [], rows: [] });
});

test('the residual axis covers the residuals that are there, not a fixed range', () => {
  // Initial residuals above 1 are ordinary at the first timestep, and a
  // converged run goes well below 1e-8. The old axis was pinned to [1e-8, 1]
  // and clipped both ends.
  const big = residualLogDomain([{ time: 1, p: 42 }, { time: 2, p: 3e-11 }], ['p']);
  assert.deepEqual(big.domain, [1e-11, 100]);
  assert.equal(big.ticks[0], 1e-11);
  assert.equal(big.ticks[big.ticks.length - 1], 100);

  // A short, tidy run gets a tick on every decade.
  const small = residualLogDomain([{ time: 1, Ux: 1 }, { time: 2, Ux: 2e-4 }], ['Ux']);
  assert.deepEqual(small.domain, [1e-4, 1]);
  assert.deepEqual(small.ticks, [1e-4, 1e-3, 1e-2, 1e-1, 1]);
});

test('values a logarithmic axis cannot place are left out of the range', () => {
  // OpenFOAM writes `Initial residual = 0` for a field it did not solve, and
  // log10(0) would take the axis to minus infinity.
  const { domain } = residualLogDomain(
    [{ time: 1, Ux: 0.5, Uy: 0 }, { time: 2, Ux: 1e-3, Uy: 0 }],
    ['Ux', 'Uy'],
  );
  assert.deepEqual(domain, [1e-3, 1]);
});

test('a log with no positive residual still yields a usable axis', () => {
  const { domain, ticks } = residualLogDomain([{ time: 1, Ux: 0 }], ['Ux']);
  assert.deepEqual(domain, [1e-8, 1]);
  assert.ok(ticks.length > 1);
});

test('a single residual value still spans a decade', () => {
  // One point is not a flat line on the frame's edge.
  const { domain } = residualLogDomain([{ time: 1, p: 1e-5 }], ['p']);
  assert.equal(domain[0], 1e-5);
  assert.ok(domain[1] > domain[0]);
});

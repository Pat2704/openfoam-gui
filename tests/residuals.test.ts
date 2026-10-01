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

test('repeated solves remain distinct events with explicit first, last and maximum selections', () => {
  const log = 'Time = 1\nGAMG: Solving for p, Initial residual = 0.3, Final residual = 1e-7, No Iterations 4\nGAMG: Solving for p, Initial residual = 0.8, Final residual = 2e-7, No Iterations 9\nGAMG: Solving for p, Initial residual = 0.02, Final residual = 3e-8, No Iterations 2\n';
  const { events } = parseResidualEvents(log);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map(event => event.initial), [0.3, 0.8, 0.02]);
  assert.equal(events[1].final, 2e-7);
  assert.equal(events[1].iterations, 9);
  assert.equal(events[1].line, 3);
  assert.equal(parseAllResiduals(log).data[0].p, 0.3);
  assert.equal(parseAllResiduals(log, { selection: 'last' }).data[0].p, 0.02);
  assert.equal(parseAllResiduals(log, { selection: 'maximum' }).data[0].p, 0.8);
  assert.equal(residualsToTable(log, { selection: 'last' }).rows[0][1], 0.02);
});

test('a later restart replaces the old timestep before selecting its residual event', () => {
  const log = 'Time = 1\np: iter = 1 residual = 0.9\nUx: iter = 1 residual = 0.6\nTime = 2\np: iter = 1 residual = 0.8\nTime = 1\np: iter = 1 residual = 0.3\np: iter = 2 residual = 0.1\nTime = 2\np: iter = 1 residual = 0.2\n';
  assert.deepEqual(parseAllResiduals(log).data.map(point => point.p), [0.3, 0.2]);
  assert.deepEqual(parseAllResiduals(log, { selection: 'last' }).data.map(point => point.p), [0.1, 0.2]);
  assert.deepEqual(parseAllResiduals(log).fields, ['p']);
  const { events } = parseResidualEvents(log);
  assert.equal(events.length, 6);
  assert.equal(events.at(-1)?.run, 1);
});

test('negative simulation times are valid and malformed time markers do not contaminate another step', () => {
  const parsed = parseAllResiduals('Time = -2\np: iter = 1 residual = 0.4\nTime = -1\np: iter = 1 residual = 0.2\nTime = 1e999\np: iter = 1 residual = 0.8\nTime = bad\np: iter = 1 residual = 0.7\n');
  assert.deepEqual(parsed.data.map(point => [point.time, point.p]), [[-2, 0.4], [-1, 0.2]]);
});

test('Foundation time values with a seconds suffix populate residual charts and tables', () => {
  const log = `Time = 0.005s
smoothSolver:  Solving for Ux, Initial residual = 1, Final residual = 1.1324e-06, No Iterations 5
GAMG:  Solving for p, Initial residual = 1, Final residual = 0.0378382, No Iterations 2
GAMG:  Solving for p, Initial residual = 0.0371368, Final residual = 6.05335e-07, No Iterations 10
Time = 1e-2s
smoothSolver:  Solving for Ux, Initial residual = 0.325089, Final residual = 3.0405e-06, No Iterations 4
GAMG:  Solving for p, Initial residual = 0.25, Final residual = 1e-6, No Iterations 3
`;
  assert.deepEqual(residualsToTable(log), {
    columns: ['Time', 'Ux', 'p'], rows: [[0.005, 1, 1], [0.01, 0.325089, 0.25]],
  });
  assert.equal(parseAllResiduals(log, { selection: 'last' }).data[0].p, 0.0371368);
  assert.equal(parseResidualEvents(log).events[0].iterations, 5);
});

test('a seconds suffix does not permit malformed numeric prefixes to reuse a timestep', () => {
  const log = 'Time = -2s\np: iter = 1 residual = 0.4\nTime = 1garbage\np: iter = 1 residual = 0.8\nTime = 1es\np: iter = 1 residual = 0.7\nTime = .5s\np: iter = 1 residual = 0.2\n';
  assert.deepEqual(parseAllResiduals(log).data.map(point => [point.time, point.p]), [[-2, 0.4], [0.5, 0.2]]);
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

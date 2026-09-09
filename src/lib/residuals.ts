/**
 * Reading solver residuals out of an OpenFOAM log.
 *
 * Lifted out of `monitor.tsx`, unchanged in behaviour, because the Post-Process
 * tab needs the same numbers for a different purpose: the Monitor watches a run
 * in progress, while Post-Process charts and exports the converged history
 * alongside the function-object output. Two copies of a parser that has to
 * recognise three solver output formats is exactly the kind of duplication that
 * drifts, so there is one, and it is unit-tested.
 *
 * Pure: no fetch, no React, no WSL.
 */

export interface ResidualPoint {
  time: number;
  [field: string]: number | undefined;
}

/**
 * Parse every timestep in a log.
 *
 * Three shapes are recognised, in the order they are tried:
 *
 *   1. `smoothSolver:  Solving for Ux, Initial residual = 0.01, …`  — by far the
 *      most common, and what `foamRun` writes.
 *   2. `p: iter = 3 residual = 1e-05`
 *   3. `Ux  3  1e-05` — legacy tabular output.
 *
 * The initial residual is the one taken: it is the error the solver STARTED the
 * timestep with, which is what a convergence plot means. The final residual only
 * says how well the linear solver did on that step.
 */
export function parseAllResiduals(log: string): { data: ResidualPoint[]; fields: string[] } {
  const lines = log.split('\n');
  const fieldSet = new Set<string>();
  const dataMap = new Map<number, ResidualPoint>();

  let currentTime = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const timeMatch = line.match(/^Time\s*=\s*([\d.eE+\-]+)/);
    if (timeMatch) {
      currentTime = parseFloat(timeMatch[1]);
      if (!isNaN(currentTime) && !dataMap.has(currentTime)) {
        dataMap.set(currentTime, { time: currentTime });
      }
      continue;
    }
    if (currentTime < 0) continue;

    // ── Format 1 (MOST COMMON): "solverName:  Solving for FIELD, Initial residual = X, ..." ──
    // e.g. "smoothSolver:  Solving for Ux, Initial residual = 0.01, Final residual = 1e-05, No Iterations 3"
    // e.g. "GAMG:  Solving for p, Initial residual = 1, Final residual = 0.001, No Iterations 5"
    const m0 = line.match(/\bSolving\s+for\s+(\S+),\s+Initial\s+residual\s*=\s*([\d.eE+\-]+)/i);
    if (m0) {
      const pt = dataMap.get(currentTime);
      if (pt) { pt[m0[1]] = parseFloat(m0[2]); fieldSet.add(m0[1]); }
      continue;
    }

    // ── Format 2: "field: iter = N residual = VALUE" (some foamRun output) ──
    const m1 = line.match(/^(\S+)\s*:\s*iter\s*=\s*\d+\s*residual\s*=\s*([\d.eE+\-]+)/);
    if (m1) {
      const pt = dataMap.get(currentTime);
      if (pt) { pt[m1[1]] = parseFloat(m1[2]); fieldSet.add(m1[1]); }
      continue;
    }

    // ── Format 3: "field  iters  residual" (legacy tabular solver output) ──
    const m2 = line.match(/^([A-Za-z_][\w.]*)\s+\d+\s+([\d.eE+\-]+)/);
    if (m2 && !line.includes('Time') && !line.includes('PIMPLE') && !line.includes('SIMPLE')) {
      const pt = dataMap.get(currentTime);
      if (pt) { pt[m2[1]] = parseFloat(m2[2]); fieldSet.add(m2[1]); }
    }
  }

  const data = Array.from(dataMap.values()).sort((a, b) => a.time - b.time);
  return { data, fields: Array.from(fieldSet) };
}

/**
 * Reshape parsed residuals into the same columns-and-rows table the
 * function-object datasets use.
 *
 * Doing this means the chart, the table, the CSV and the image export in the
 * Post-Process tab treat a log exactly like any other dataset, instead of
 * needing a second rendering path that would then have to be kept in step.
 *
 * A field missing at a timestep stays a gap (NaN) rather than becoming a zero:
 * a solver that did not solve for `p` on that step has no residual, and a zero
 * would draw a line to the bottom of a logarithmic axis and read as perfect
 * convergence.
 */
export function residualsToTable(log: string): { columns: string[]; rows: number[][] } {
  const { data, fields } = parseAllResiduals(log);
  if (!data.length || !fields.length) return { columns: [], rows: [] };
  return {
    columns: ['Time', ...fields],
    rows: data.map(point => [point.time, ...fields.map(field => {
      const value = point[field];
      return value === undefined ? NaN : value;
    })]),
  };
}

/**
 * The decade range a residual plot has to cover, and the ticks to label it
 * with.
 *
 * The Monitor used to draw its residuals against a fixed `[1e-8, 1]` axis with
 * overflow allowed, which is an assumption rather than a scale: a run whose
 * initial residuals start above 1 had them flattened onto the top edge, and one
 * that converges past 1e-8 had its interesting decades crushed against the
 * bottom, so the curve did not correspond to the numbers in the log.
 *
 * Whole decades keep every gridline meaningful, and values a logarithmic axis
 * cannot place — zero, which OpenFOAM writes for a field it did not solve, and
 * anything negative — are left out of the range rather than dragging it to
 * minus infinity.
 */
export function residualLogDomain(
  data: readonly ResidualPoint[],
  fields: readonly string[],
): { domain: [number, number]; ticks: number[] } {
  let low = Infinity;
  let high = -Infinity;
  for (const point of data) {
    for (const field of fields) {
      const value = point[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
      if (value < low) low = value;
      if (value > high) high = value;
    }
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    return { domain: [1e-8, 1], ticks: [1e-8, 1e-6, 1e-4, 1e-2, 1] };
  }
  const bottom = Math.pow(10, Math.floor(Math.log10(low)));
  const top = Math.max(Math.pow(10, Math.ceil(Math.log10(high))), bottom * 10);
  const decades = Math.round(Math.log10(top / bottom));
  // Label every decade while there is room, then every second or third one.
  const step = decades <= 10 ? 1 : decades <= 20 ? 2 : 3;
  const ticks: number[] = [];
  for (let i = 0; i <= decades; i += step) ticks.push(bottom * Math.pow(10, i));
  if (ticks[ticks.length - 1] !== top) ticks.push(top);
  return { domain: [bottom, top], ticks };
}

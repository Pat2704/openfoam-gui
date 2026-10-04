/** Shared solver-log parser for Monitor and Post-Process. Pure: no fetch or WSL. */
export interface ResidualPoint {
  time: number;
  [field: string]: number | undefined;
}

export type ResidualKind = 'initial' | 'final';

export interface ResidualEvent {
  time: number;
  step: number;
  field: string;
  initial?: number;
  final?: number;
  iterations?: number;
  line: number;
}

function finiteNumber(token: string): number | undefined {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)) return undefined;
  const value = Number(token);
  return Number.isFinite(value) ? value : undefined;
}

function residualNumber(token: string): number | undefined {
  const value = finiteNumber(token);
  return value !== undefined && value >= 0 ? value : undefined;
}

/** Preserve every solve, its order and source line; missing values stay missing. */
export function parseResidualEvents(log: string): {
  events: ResidualEvent[];
  timesteps: { time: number; step: number }[];
} {
  const events: ResidualEvent[] = [];
  const timesteps: { time: number; step: number }[] = [];
  let currentTime: number | undefined;
  let step = -1;
  const lines = log.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
    if (/^(?:Create time|Starting time loop)\b/.test(line)) currentTime = undefined;
    const timeMatch = line.match(/^Time\s*=\s*(.*?)\s*$/);
    if (timeMatch) {
      // Foundation's unit-aware output writes e.g. "Time = 0.005s".
      currentTime = finiteNumber(timeMatch[1].replace(/\s*s$/, ''));
      if (currentTime !== undefined) {
        step += 1;
        timesteps.push({ time: currentTime, step });
      }
      continue;
    }
    if (currentTime === undefined) continue;
    const solve = line.match(/\bSolving\s+for\s+([^,\s]+),\s+Initial\s+residual\s*=\s*([^,\s]*)/i);
    if (solve) {
      const final = line.match(/\bFinal\s+residual\s*=\s*([^,\s]*)/i);
      const iterations = line.match(/\bNo\s+Iterations\s+(\d+)\s*$/i);
      events.push({ time: currentTime, step, field: solve[1], initial: residualNumber(solve[2]),
        final: final ? residualNumber(final[1]) : undefined,
        iterations: iterations ? Number(iterations[1]) : undefined, line: i + 1 });
      continue;
    }
    // Legacy unlabelled residuals have no reported final value; never invent one.
    const legacy = line.match(/^([^\s:]+)\s*:\s*iter\s*=\s*(\d+)\s*residual\s*=\s*(\S+)\s*$/)
      ?? line.match(/^([A-Za-z_][\w.]*)\s+(\d+)\s+(\S+)\s*$/);
    if (legacy && !['Time', 'PIMPLE', 'SIMPLE'].includes(legacy[1])) {
      events.push({ time: currentTime, step, field: legacy[1], initial: residualNumber(legacy[3]),
        iterations: Number(legacy[2]), line: i + 1 });
    }
  }
  return { events, timesteps };
}

/** Initial = first solve's initial; final = last solve's final, per field/timestep. */
export function parseAllResiduals(
  log: string,
  options: { kind?: ResidualKind } = {},
): { data: ResidualPoint[]; fields: string[] } {
  const { events, timesteps } = parseResidualEvents(log);
  const latestSteps = new Map(timesteps.map(({ time, step }) => [time, step]));
  // A recomputed timestep replaces the whole old row, including missing fields.
  const dataMap = new Map<number, ResidualPoint>(timesteps.map(({ time }) => [time, { time }]));
  const fields = new Set<string>();
  const kind = options.kind ?? 'initial';
  for (const event of events) {
    if (latestSteps.get(event.time) !== event.step || event.field === 'time') continue;
    fields.add(event.field);
    const point = dataMap.get(event.time)!;
    if (kind === 'final' || !Object.hasOwn(point, event.field)) {
      Object.defineProperty(point, event.field, {
        value: event[kind], writable: true, enumerable: true, configurable: true,
      });
    }
  }
  return { data: [...dataMap.values()].sort((a, b) => a.time - b.time), fields: [...fields] };
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
export function residualsToTable(log: string, options: { kind?: ResidualKind } = {}): { columns: string[]; rows: number[][] } {
  const { data, fields } = parseAllResiduals(log, options);
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
  // Decades come from their decimal spelling, not Math.pow: on some V8 versions
  // Math.pow(10, -4) is 0.00009999999999999999, and that is the tick's label.
  const decade = (exponent: number) => Number(`1e${exponent}`);
  const bottomExponent = Math.floor(Math.log10(low));
  const topExponent = Math.max(Math.ceil(Math.log10(high)), bottomExponent + 1);
  const bottom = decade(bottomExponent);
  const top = decade(topExponent);
  const decades = topExponent - bottomExponent;
  // Label every decade while there is room, then every second or third one.
  const step = decades <= 10 ? 1 : decades <= 20 ? 2 : 3;
  const ticks: number[] = [];
  for (let i = 0; i <= decades; i += step) ticks.push(decade(bottomExponent + i));
  if (ticks[ticks.length - 1] !== top) ticks.push(top);
  return { domain: [bottom, top], ticks };
}

import { comparisonAxisError, type ComparisonPoint, type ComparisonTrace } from './postprocess-comparison';

export const DSP_SAMPLE_LIMIT = 16384;
export const DERIVED_POINT_LIMIT = 200000;
export interface AnalysisInterval { from: number | null; to: number | null }
export interface GridAlignment { mode: 'exact' | 'linear'; maxGap: number }
export interface QuantityRecipe {
  id: string; name: string; kind: 'difference' | 'magnitude' | 'coefficient' | 'balance';
  operands: string[]; alignment: GridAlignment; units: string;
  signs: number[]; coefficient: 'reference' | 'pressure' | 'force';
  reference: number; scale: number; density: number; velocity: number; area: number;
}
export interface SpectrumSettings {
  curve: string; window: 'hann' | 'rectangular'; detrend: 'mean' | 'none';
  sampling: 'reject' | 'resample'; step: number; maxGap: number; samples: number;
  timeUnit: 's' | 'ms'; valueUnits: string; length: number | null; velocity: number | null;
}
export interface CorrelationSettings {
  first: string; second: string; sampling: 'reject' | 'resample'; step: number; maxGap: number;
  maxLag: number; timeUnit: 's' | 'ms';
}
export interface AdvancedAnalysisConfig {
  interval: AnalysisInterval; quantities: QuantityRecipe[];
  spectrum: SpectrumSettings | null; correlation: CorrelationSettings | null;
}
export const emptyAdvancedAnalysis = (): AdvancedAnalysisConfig => ({ interval: { from: null, to: null }, quantities: [], spectrum: null, correlation: null });

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid advanced analysis settings.');
  return value as Record<string, unknown>;
}
function number(value: unknown, label: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) throw new Error(`${label} must be ${positive ? 'positive and ' : ''}finite.`);
  return value;
}
function text(value: unknown, label: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}
function choice<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (!options.includes(value as T)) throw new Error(`Invalid ${label}.`);
  return value as T;
}
export function validateAdvancedAnalysis(value: unknown): AdvancedAnalysisConfig {
  const input = object(value), bounds = object(input.interval);
  const interval = { from: bounds.from === null ? null : number(bounds.from, 'Interval start'), to: bounds.to === null ? null : number(bounds.to, 'Interval end') };
  if (interval.from !== null && interval.to !== null && interval.from >= interval.to) throw new Error('Interval start must be before its end.');
  if (!Array.isArray(input.quantities) || input.quantities.length > 6) throw new Error('At most six derived quantities are supported.');
  const quantities = input.quantities.map(value => {
    const q = object(value), align = object(q.alignment);
    if (!Array.isArray(q.operands) || !q.operands.length || q.operands.length > 6) throw new Error('Choose 1–6 quantity operands.');
    const operands = q.operands.map(value => text(value, 'operand'));
    if (new Set(operands).size !== operands.length) throw new Error('Quantity operands must be distinct.');
    const kind = choice(q.kind, ['difference', 'magnitude', 'coefficient', 'balance'], 'quantity');
    if ((kind === 'difference' && operands.length !== 2) || (kind === 'magnitude' && (operands.length < 2 || operands.length > 3)) || (kind === 'coefficient' && operands.length !== 1)) throw new Error('Wrong number of quantity operands.');
    if (!Array.isArray(q.signs) || q.signs.length !== operands.length || q.signs.some(value => value !== -1 && value !== 1)) throw new Error('Assign a +1 or −1 orientation to each operand.');
    const recipe: QuantityRecipe = {
      id: text(q.id, 'quantity ID'), name: text(q.name, 'quantity name'), kind, operands,
      alignment: { mode: choice(align.mode, ['exact', 'linear'], 'grid alignment'), maxGap: number(align.maxGap, 'Maximum interpolation gap', true) },
      units: text(q.units, 'declared operand units', 64), signs: q.signs as number[],
      coefficient: choice(q.coefficient, ['reference', 'pressure', 'force'], 'coefficient'),
      reference: number(q.reference, 'Reference value'), scale: number(q.scale, 'Normalization scale', true),
      density: number(q.density, 'Reference density', true), velocity: number(q.velocity, 'Reference speed', true), area: number(q.area, 'Reference area', true),
    };
    if (kind === 'balance' && !['kg/s', 'm3/s'].includes(recipe.units)) throw new Error('A signed flux balance requires declared kg/s or m3/s operands.');
    if (kind === 'coefficient' && recipe.coefficient === 'pressure' && !['Pa', 'm2/s2'].includes(recipe.units)) throw new Error('Pressure coefficients require declared Pa or kinematic m2/s2 pressure.');
    if (kind === 'coefficient' && recipe.coefficient === 'force' && recipe.units !== 'N') throw new Error('Force coefficients require declared N operands.');
    return recipe;
  });
  if (new Set(quantities.map(q => q.id)).size !== quantities.length) throw new Error('Duplicate quantity ID.');
  let spectrum: SpectrumSettings | null = null;
  if (input.spectrum !== null) {
    const s = object(input.spectrum), samples = number(s.samples, 'FFT sample count');
    if (!Number.isInteger(samples) || samples < 8 || samples > DSP_SAMPLE_LIMIT || (samples & (samples - 1)) !== 0) throw new Error('FFT samples must be a power of two from 8 to 16,384.');
    spectrum = { curve: text(s.curve, 'spectrum curve'), window: choice(s.window, ['hann', 'rectangular'], 'window'), detrend: choice(s.detrend, ['mean', 'none'], 'detrending'),
      sampling: choice(s.sampling, ['reject', 'resample'], 'sampling'), step: number(s.step, 'Resample step', true), maxGap: number(s.maxGap, 'Maximum interpolation gap', true), samples,
      timeUnit: choice(s.timeUnit, ['s', 'ms'], 'time unit'), valueUnits: text(s.valueUnits, 'signal units', 64),
      length: s.length === null ? null : number(s.length, 'Strouhal length (m)', true), velocity: s.velocity === null ? null : number(s.velocity, 'Strouhal speed (m/s)', true) };
    if ((spectrum.length === null) !== (spectrum.velocity === null)) throw new Error('Strouhal needs both length and speed.');
  }
  let correlation: CorrelationSettings | null = null;
  if (input.correlation !== null) {
    const c = object(input.correlation), maxLag = number(c.maxLag, 'Maximum lag samples');
    if (!Number.isInteger(maxLag) || maxLag < 0 || maxLag > 512) throw new Error('Maximum correlation lag is 0–512 samples.');
    correlation = { first: text(c.first, 'first curve'), second: text(c.second, 'second curve'), sampling: choice(c.sampling, ['reject', 'resample'], 'sampling'),
      step: number(c.step, 'Resample step', true), maxGap: number(c.maxGap, 'Maximum interpolation gap', true), maxLag, timeUnit: choice(c.timeUnit, ['s', 'ms'], 'time unit') };
    if (correlation.first === correlation.second) throw new Error('Choose two different correlation curves.');
  }
  return { interval, quantities, spectrum, correlation };
}

function selected(points: readonly ComparisonPoint[], interval: AnalysisInterval): ComparisonPoint[] {
  return points.filter(point => (interval.from === null || point.x >= interval.from) && (interval.to === null || point.x <= interval.to));
}
function ordered(points: readonly ComparisonPoint[]) {
  if (points.some((point, index) => !Number.isFinite(point.x) || (point.y !== null && !Number.isFinite(point.y)) || (index > 0 && point.x <= points[index - 1].x))) throw new Error('Analysis requires finite, strictly increasing independent coordinates; repeated coordinates are not merged.');
}
export interface IntervalStatistics {
  samples: number; gaps: number; mean: number; rms: number; fluctuationRms: number; standardDeviation: number;
  min: number; max: number; peakToPeak: number; slope: number | null;
  weightedMean: number | null; weightedRms: number | null; weightedFluctuationRms: number | null; coveredDuration: number; requestedDuration: number;
  integral: number | null;
}
/** Population statistics; time integrals use only adjacent finite samples, never gaps. */
export function intervalStatistics(trace: ComparisonTrace, interval: AnalysisInterval): IntervalStatistics {
  ordered(trace.points);
  const points = selected(trace.points, interval);
  const values = points.filter((point): point is { x: number; y: number } => point.y !== null);
  if (!values.length) throw new Error('No finite samples in the selected interval.');
  let mean = 0, meanX = 0, sumSquare = 0;
  for (const [index, point] of values.entries()) { mean += (point.y - mean) / (index + 1); meanX += (point.x - meanX) / (index + 1); sumSquare += point.y ** 2; }
  let variance = 0, covariance = 0, xVariance = 0, min = Infinity, max = -Infinity;
  for (const point of values) { variance += (point.y - mean) ** 2; covariance += (point.x - meanX) * (point.y - mean); xVariance += (point.x - meanX) ** 2; min = Math.min(min, point.y); max = Math.max(max, point.y); }
  let area = 0, squareArea = 0, coveredDuration = 0;
  // Clip finite adjacent segments to the interval; no endpoint extrapolation.
  for (let index = 1; index < trace.points.length; index += 1) {
    const left = trace.points[index - 1], right = trace.points[index];
    if (left.y === null || right.y === null || right.x <= left.x) continue;
    const from = Math.max(left.x, interval.from ?? left.x), to = Math.min(right.x, interval.to ?? right.x);
    if (to <= from) continue;
    const a = left.y + (right.y - left.y) * (from - left.x) / (right.x - left.x);
    const b = left.y + (right.y - left.y) * (to - left.x) / (right.x - left.x), dt = to - from;
    coveredDuration += dt; area += dt * (a + b) / 2; squareArea += dt * (a * a + a * b + b * b) / 3;
  }
  const weightedMean = trace.mode === 'series' && coveredDuration > 0 ? area / coveredDuration : null;
  const weightedRms = weightedMean !== null ? Math.sqrt(Math.max(0, squareArea / coveredDuration)) : null;
  let fluctuationArea = 0;
  if (weightedMean !== null) for (let index = 1; index < trace.points.length; index += 1) {
    const left = trace.points[index - 1], right = trace.points[index];
    if (left.y === null || right.y === null || right.x <= left.x) continue;
    const from = Math.max(left.x, interval.from ?? left.x), to = Math.min(right.x, interval.to ?? right.x);
    if (to <= from) continue;
    const a = left.y + (right.y - left.y) * (from - left.x) / (right.x - left.x) - weightedMean;
    const b = left.y + (right.y - left.y) * (to - left.x) / (right.x - left.x) - weightedMean;
    fluctuationArea += (to - from) * (a * a + a * b + b * b) / 3;
  }
  const result = { samples: values.length, gaps: points.length - values.length, mean, rms: Math.sqrt(sumSquare / values.length), fluctuationRms: Math.sqrt(variance / values.length), standardDeviation: Math.sqrt(variance / values.length), min, max, peakToPeak: max - min,
    slope: xVariance ? covariance / xVariance : null, weightedMean, weightedRms, weightedFluctuationRms: weightedMean !== null ? Math.sqrt(Math.max(0, fluctuationArea / coveredDuration)) : null,
    coveredDuration: trace.mode === 'series' ? coveredDuration : 0, requestedDuration: Math.max(0, (interval.to ?? trace.points.at(-1)!.x) - (interval.from ?? trace.points[0].x)), integral: weightedMean !== null ? area : null };
  if (Object.values(result).some(value => typeof value === 'number' && !Number.isFinite(value))) throw new Error('The numerical range exceeds safe statistical precision.');
  return result;
}

/** Binary search on a strictly ordered source; null boundaries and long holes stay gaps. */
export function interpolatePoint(points: readonly ComparisonPoint[], x: number, maxGap: number): number | null {
  let low = 0, high = points.length - 1;
  if (!points.length || x < points[0].x || x > points.at(-1)!.x) return null;
  while (low <= high) { const middle = (low + high) >>> 1; if (points[middle].x === x) return points[middle].y; if (points[middle].x < x) low = middle + 1; else high = middle - 1; }
  const a = points[high], b = points[low];
  if (!a || !b || a.y === null || b.y === null || b.x - a.x > maxGap) return null;
  const value = a.y + (b.y - a.y) * ((x - a.x) / (b.x - a.x));
  return Number.isFinite(value) ? value : null;
}
export function alignQuantityOperands(traces: readonly ComparisonTrace[], alignment: GridAlignment): (number | null)[][] {
  if (!traces.length || traces[0].points.length > DERIVED_POINT_LIMIT) throw new Error('Derived quantities support at most 200,000 reference-grid points.');
  for (const trace of traces) {
    const error = comparisonAxisError(traces[0], trace); if (error) throw new Error(error);
    if (trace.sourceOmissions) throw new Error('A source omitted important features; reload a smaller range before deriving values.');
    ordered(trace.points);
  }
  const reference = traces[0].points;
  if (alignment.mode === 'exact') {
    if (traces.some(trace => trace.points.length !== reference.length || trace.points.some((point, index) => point.x !== reference[index].x))) throw new Error('Operand grids differ. Choose explicit linear interpolation onto the first curve or load matching grids.');
    return reference.map((_, index) => traces.map(trace => trace.points[index].y));
  }
  return reference.map(point => traces.map(trace => interpolatePoint(trace.points, point.x, alignment.maxGap)));
}
export function deriveQuantity(recipe: QuantityRecipe, traces: readonly ComparisonTrace[], interval: AnalysisInterval): ComparisonTrace {
  if (traces.length !== recipe.operands.length) throw new Error('A quantity operand is missing.');
  if (recipe.kind === 'balance' && traces.some(trace => trace.mode !== 'series' || trace.caseName !== traces[0].caseName || trace.snapshot !== traces[0].snapshot)) throw new Error('A flux balance requires time-series operands from the same case and capture context.');
  const operands = traces.map((trace, index) => recipe.alignment.mode === 'exact' || index === 0 ? { ...trace, points: selected(trace.points, interval) } : trace);
  if (!operands[0].points.length) throw new Error('No operand samples in the selected interval.');
  const aligned = alignQuantityOperands(operands, recipe.alignment);
  const denominator = recipe.coefficient === 'reference' ? recipe.scale : 0.5 * (recipe.units === 'm2/s2' ? 1 : recipe.density) * recipe.velocity ** 2 * (recipe.coefficient === 'force' ? recipe.area : 1);
  if (recipe.kind === 'coefficient' && (!Number.isFinite(denominator) || denominator <= 0)) throw new Error('The normalization denominator is not finite and positive.');
  const points = operands[0].points.map((point, index): ComparisonPoint => {
    const values = aligned[index];
    if (values.some(value => value === null)) return { x: point.x, y: null };
    const finite = values as number[];
    const y = recipe.kind === 'difference' ? finite[0] - finite[1] : recipe.kind === 'magnitude' ? Math.hypot(...finite) : recipe.kind === 'coefficient' ? (finite[0] - recipe.reference) / denominator : finite.reduce((sum, value, index) => sum + value * recipe.signs[index], 0);
    if (!Number.isFinite(y)) throw new Error(`Derived value exceeds finite precision at coordinate ${point.x}.`);
    return { x: point.x, y };
  });
  const formula = recipe.kind === 'difference' ? 'A − B' : recipe.kind === 'magnitude' ? 'sqrt(sum(component²))' : recipe.kind === 'balance' ? `signed sum (${recipe.signs.join(', ')})` : `(A − ${recipe.reference}) / ${denominator}`;
  return { ...traces[0], id: recipe.id, label: recipe.name, field: `${recipe.name} [${recipe.kind === 'coefficient' ? '1' : recipe.units}]`, source: `${recipe.kind}: ${formula}; declared input units ${recipe.units}`, points, loadedAt: new Date().toISOString(), totalRows: points.length,
    coverage: `${recipe.alignment.mode === 'linear' ? `Explicit linear interpolation onto first curve; max gap ${recipe.alignment.maxGap}; no extrapolation` : 'Exact coordinate matching'}; ${traces.map(trace => `${trace.label}: ${trace.coverage}`).join(' | ')}`, sourceOmissions: 0 };
}

function timeTrace(trace: ComparisonTrace) {
  if (trace.mode !== 'series') throw new Error('Frequency and delay analysis requires a time series, not a spatial profile.');
  if (trace.sourceOmissions) throw new Error('Source sampling omitted features; spectral/delay analysis is unsafe.');
}
function uniformStep(points: readonly ComparisonPoint[]): number {
  ordered(points);
  if (points.length < 8 || points.some(point => point.y === null)) throw new Error('Choose an interval with at least eight contiguous finite samples; gaps cannot be bridged.');
  const step = (points.at(-1)!.x - points[0].x) / (points.length - 1);
  if (points.some((point, index) => index > 0 && Math.abs((point.x - points[index - 1].x) / step - 1) > 1e-6)) throw new Error('Irregular time sampling. Select explicit uniform resampling and a maximum interpolation gap.');
  return step;
}
function uniformize(trace: ComparisonTrace, interval: AnalysisInterval, sampling: 'reject' | 'resample', step: number, maxGap: number, cap: number): { points: ComparisonPoint[]; step: number; notes: string } {
  timeTrace(trace);
  const points = selected(trace.points, interval); ordered(points);
  if (sampling === 'reject') return { points, step: uniformStep(points), notes: 'Uniform source samples; no resampling.' };
  if (points.length < 2 || points.some(point => point.y === null)) throw new Error('Select contiguous finite samples. Resampling does not bridge explicit gaps.');
  const count = Math.floor((points.at(-1)!.x - points[0].x) / step + 1e-9) + 1;
  if (count > cap || count < 8) throw new Error(`Uniform resampling must produce 8–${cap} points. Adjust the interval or step.`);
  const resampled = Array.from({ length: count }, (_, index) => ({ x: points[0].x + index * step, y: interpolatePoint(points, points[0].x + index * step, maxGap) }));
  if (resampled.some(point => point.y === null)) throw new Error('Resampling encounters an unsupported gap or endpoint. Increase the explicitly allowed gap or narrow the interval.');
  return { points: resampled, step, notes: `Explicit linear resampling: step ${step}, max interpolation gap ${maxGap}; no extrapolation.` };
}
function fft(real: Float64Array, imaginary: Float64Array) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i += 1) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]]; } }
  for (let size = 2; size <= n; size *= 2) {
    const angle = -2 * Math.PI / size, cosine = Math.cos(angle), sine = Math.sin(angle);
    for (let offset = 0; offset < n; offset += size) { let wr = 1, wi = 0; for (let j = 0; j < size / 2; j += 1) {
      const a = offset + j, b = a + size / 2, tr = wr * real[b] - wi * imaginary[b], ti = wr * imaginary[b] + wi * real[b];
      real[b] = real[a] - tr; imaginary[b] = imaginary[a] - ti; real[a] += tr; imaginary[a] += ti;
      const next = wr * cosine - wi * sine; wi = wr * sine + wi * cosine; wr = next;
    } }
  }
}
export interface SpectrumResult { points: { frequency: number; psd: number; amplitude: number }[]; dominantFrequency: number | null; strouhal: number | null; frequencyResolution: number; nyquist: number; usedSamples: number; availableSamples: number; from: number; to: number; notes: string }
export function serializeSpectrumCsv(result: SpectrumResult, units: string): string {
  const cell = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return ['Frequency (Hz)', `PSD (${units} squared/Hz)`, `Peak amplitude (${units})`].map(cell).join(',') + '\n' + result.points.map(point => [point.frequency, point.psd, point.amplitude].join(',')).join('\n') + '\n';
}
export function spectrumAnalysis(trace: ComparisonTrace, interval: AnalysisInterval, settings: SpectrumSettings): SpectrumResult {
  const uniform = uniformize(trace, interval, settings.sampling, settings.step, settings.maxGap, DSP_SAMPLE_LIMIT);
  if (uniform.points.length < settings.samples) throw new Error(`FFT requests ${settings.samples} samples but only ${uniform.points.length} are available.`);
  const points = uniform.points.slice(0, settings.samples), n = points.length, values = points.map(point => point.y!);
  const mean = settings.detrend === 'mean' ? values.reduce((sum, value) => sum + value / n, 0) : 0;
  const real = new Float64Array(n), imaginary = new Float64Array(n); let windowSquare = 0, windowSum = 0;
  for (let index = 0; index < n; index += 1) { const window = settings.window === 'hann' ? 0.5 - 0.5 * Math.cos(2 * Math.PI * index / n) : 1; real[index] = (values[index] - mean) * window; windowSquare += window ** 2; windowSum += window; }
  fft(real, imaginary);
  const secondsStep = uniform.step * (settings.timeUnit === 'ms' ? 0.001 : 1), fs = 1 / secondsStep, resolution = fs / n;
  const bins = Array.from({ length: n / 2 + 1 }, (_, index) => {
    const power = real[index] ** 2 + imaginary[index] ** 2, factor = index === 0 || index === n / 2 ? 1 : 2;
    return { frequency: index * resolution, psd: factor * power / (fs * windowSquare), amplitude: factor * Math.sqrt(power) / windowSum };
  });
  if (bins.some(bin => !Number.isFinite(bin.psd) || !Number.isFinite(bin.amplitude))) throw new Error('Signal range exceeds spectral precision.');
  const peak = bins.slice(1).reduce((peak, bin) => bin.psd > peak.psd ? bin : peak, bins[1]);
  const dominantFrequency = peak.psd > 0 ? peak.frequency : null;
  return { points: bins, dominantFrequency, strouhal: dominantFrequency !== null && settings.length !== null && settings.velocity !== null ? dominantFrequency * settings.length / settings.velocity : null,
    frequencyResolution: resolution, nyquist: fs / 2, usedSamples: n, availableSamples: uniform.points.length, from: points[0].x, to: points.at(-1)!.x,
    notes: `${uniform.notes} One-sided periodogram; ${settings.window} window, ${settings.detrend} detrending; PSD ${settings.valueUnits}²/Hz; coherent-gain peak amplitude ${settings.valueUnits}; first ${n}/${uniform.points.length} selected samples, no zero-padding. Frequency peaks are bin estimates; no Welch averaging.` };
}
export interface CorrelationResult { points: { delay: number; correlation: number; pairs: number }[]; delay: number; correlation: number; samples: number; notes: string }
export function crossCorrelation(first: ComparisonTrace, second: ComparisonTrace, interval: AnalysisInterval, settings: CorrelationSettings): CorrelationResult {
  timeTrace(first); timeTrace(second);
  const error = comparisonAxisError(first, second); if (error) throw new Error(error);
  const common = { from: Math.max(interval.from ?? -Infinity, first.points[0]?.x ?? Infinity, second.points[0]?.x ?? Infinity), to: Math.min(interval.to ?? Infinity, first.points.at(-1)?.x ?? -Infinity, second.points.at(-1)?.x ?? -Infinity) };
  if (common.from >= common.to) throw new Error('No common time interval.');
  const a = uniformize(first, common, settings.sampling, settings.step, settings.maxGap, DSP_SAMPLE_LIMIT);
  let b: ComparisonPoint[];
  if (settings.sampling === 'reject') {
    const right = uniformize(second, common, 'reject', settings.step, settings.maxGap, DSP_SAMPLE_LIMIT);
    b = right.points;
    if (b.length !== a.points.length || b.some((point, index) => Math.abs(point.x - a.points[index].x) > a.step * 1e-6)) throw new Error('Correlation grids differ; choose explicit uniform resampling.');
  } else {
    const source = selected(second.points, common); ordered(source);
    if (source.some(point => point.y === null)) throw new Error('Correlation resampling cannot bridge explicit gaps.');
    b = a.points.map(point => ({ x: point.x, y: interpolatePoint(source, point.x, settings.maxGap) }));
    if (b.some(point => point.y === null)) throw new Error('Correlation interpolation meets a gap or would extrapolate.');
  }
  const n = a.points.length;
  if (n > DSP_SAMPLE_LIMIT) throw new Error('Correlation is limited to 16,384 samples; narrow the interval.');
  const lagLimit = Math.min(settings.maxLag, Math.floor(n / 2));
  const meanA = a.points.reduce((sum, point) => sum + point.y! / n, 0), meanB = b.reduce((sum, point) => sum + point.y! / n, 0);
  const firstValues = a.points.map(point => point.y! - meanA), secondValues = b.map(point => point.y! - meanB);
  const seconds = a.step * (settings.timeUnit === 'ms' ? 0.001 : 1);
  const points: CorrelationResult['points'] = [];
  for (let lag = -lagLimit; lag <= lagLimit; lag += 1) {
    let product = 0, aa = 0, bb = 0, pairs = 0;
    for (let index = Math.max(0, -lag); index < Math.min(n, n - lag); index += 1) { const x = firstValues[index], y = secondValues[index + lag]; product += x * y; aa += x * x; bb += y * y; pairs += 1; }
    if (!aa || !bb) continue;
    const correlation = product / Math.sqrt(aa) / Math.sqrt(bb);
    if (!Number.isFinite(correlation)) throw new Error('Signal range exceeds correlation precision.');
    points.push({ delay: lag * seconds, correlation: Math.max(-1, Math.min(1, correlation)), pairs });
  }
  if (!points.length) throw new Error('Delay is undefined for a constant/zero-energy signal.');
  const peak = points.reduce((peak, point) => point.correlation > peak.correlation + 1e-12 || (Math.abs(point.correlation - peak.correlation) < 1e-12 && Math.abs(point.delay) < Math.abs(peak.delay)) ? point : peak, points[0]);
  return { points, delay: peak.delay, correlation: peak.correlation, samples: n,
    notes: `${a.notes} Mean removed over the common interval; overlap-energy normalization, at least ${n - lagLimit} pairs. Positive delay means the second signal follows the first: sum A(t)·B(t+delay). Maximum ${lagLimit} lag samples; dominant positive correlation, no significance estimate.` };
}

export interface AdvancedAnalysisResult {
  statistics: { key: string; label: string; result: IntervalStatistics | null; error?: string }[];
  quantities: ComparisonTrace[]; spectrum: SpectrumResult | null; correlation: CorrelationResult | null; warnings: string[];
  balances: { id: string; finiteSamples: number; lastNet: number | null; maxAbsoluteNet: number | null; maxRelativePercent: number | null }[];
}
export function serializeIntervalStatisticsCsv(statistics: AdvancedAnalysisResult['statistics']): string {
  const cell = (value: string | number | null) => { const text = value === null ? '' : String(value); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; };
  const columns = ['Curve key', 'Curve', 'Finite samples', 'Gaps', 'Sample mean', 'RMS', 'Fluctuation RMS', 'Population SD', 'Min', 'Max', 'Peak-to-peak', 'Slope', 'Time weighted mean', 'Time weighted RMS', 'Time weighted fluctuation RMS', 'Covered duration', 'Requested duration', 'Temporal integral (value times time-axis unit)'];
  return columns.map(cell).join(',') + '\n' + statistics.filter(entry => entry.result).map(entry => {
    const s = entry.result!;
    return [entry.key, entry.label, s.samples, s.gaps, s.mean, s.rms, s.fluctuationRms, s.standardDeviation, s.min, s.max, s.peakToPeak, s.slope, s.weightedMean, s.weightedRms, s.weightedFluctuationRms, s.coveredDuration, s.requestedDuration, s.integral].map(cell).join(',');
  }).join('\n') + '\n';
}
export function computeAdvancedAnalysis(entries: readonly { key: string; trace: ComparisonTrace }[], config: AdvancedAnalysisConfig): AdvancedAnalysisResult {
  const result: AdvancedAnalysisResult = { statistics: [], quantities: [], spectrum: null, correlation: null, warnings: [], balances: [] };
  const find = (key: string) => { const trace = entries.find(entry => entry.key === key)?.trace; if (!trace) throw new Error(`Operand ${key} is unavailable; its source may have been removed.`); return trace; };
  for (const entry of entries) try { result.statistics.push({ key: entry.key, label: entry.trace.label, result: intervalStatistics(entry.trace, config.interval) }); }
  catch (error) { result.statistics.push({ key: entry.key, label: entry.trace.label, result: null, error: error instanceof Error ? error.message : String(error) }); }
  for (const recipe of config.quantities) try {
    const operands = recipe.operands.map(find), trace = deriveQuantity(recipe, operands, config.interval);
    result.quantities.push(trace);
    if (!trace.points.some(point => point.y !== null)) result.warnings.push(`${recipe.name}: no finite derived values; check operand gaps and the explicit interpolation limit.`);
    if (recipe.kind === 'balance') {
      const selectedOperands = operands.map((operand, index) => recipe.alignment.mode === 'exact' || index === 0 ? { ...operand, points: selected(operand.points, config.interval) } : operand);
      const aligned = alignQuantityOperands(selectedOperands, recipe.alignment);
      let finiteSamples = 0, lastNet: number | null = null, maxAbsoluteNet: number | null = null, maxRelativePercent: number | null = null;
      for (const [index, point] of trace.points.entries()) if (point.y !== null) {
        finiteSamples += 1; lastNet = point.y; maxAbsoluteNet = Math.max(maxAbsoluteNet ?? 0, Math.abs(point.y));
        const absoluteFlux = (aligned[index] as number[]).reduce((sum, value) => sum + Math.abs(value), 0);
        if (absoluteFlux > 0) maxRelativePercent = Math.max(maxRelativePercent ?? 0, 100 * Math.abs(point.y) / absoluteFlux);
      }
      result.balances.push({ id: recipe.id, finiteSamples, lastNet, maxAbsoluteNet, maxRelativePercent });
    }
  }
  catch (error) { result.warnings.push(`${recipe.name}: ${error instanceof Error ? error.message : String(error)}`); }
  if (config.spectrum) try { result.spectrum = spectrumAnalysis(find(config.spectrum.curve), config.interval, config.spectrum); }
  catch (error) { result.warnings.push(`Spectrum: ${error instanceof Error ? error.message : String(error)}`); }
  if (config.correlation) try { result.correlation = crossCorrelation(find(config.correlation.first), find(config.correlation.second), config.interval, config.correlation); }
  catch (error) { result.warnings.push(`Correlation: ${error instanceof Error ? error.message : String(error)}`); }
  return result;
}

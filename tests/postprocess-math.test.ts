import test from 'node:test';
import assert from 'node:assert/strict';
import { intervalStatistics, serializeIntervalStatisticsCsv, deriveQuantity, spectrumAnalysis, serializeSpectrumCsv, crossCorrelation, validateAdvancedAnalysis, emptyAdvancedAnalysis, computeAdvancedAnalysis, type QuantityRecipe, type SpectrumSettings, type CorrelationSettings } from '../src/lib/postprocess-math.ts';
import { type ComparisonTrace } from '../src/lib/postprocess-comparison.ts';
import { parsePostProcessAnalysis, replayPostProcessAnalysis, buildPostProcessAnalysisReport, type AnalysisDisplayCurve } from '../src/lib/postprocess-analysis.ts';

const interval = { from: null, to: null };
function trace(points: [number, number | null][], overrides: Partial<ComparisonTrace> = {}): ComparisonTrace {
  return { id: 'a', label: 'Curve A', caseName: 'math_test', source: 'postProcessing/signals/data.dat', snapshot: null, residualSelection: null, mode: 'series', axis: 'Time', field: 'p', loadedAt: 'now', points: points.map(([x, y]) => ({ x, y })), totalRows: points.length, coverage: `${points.length}/${points.length} loaded`, sourceOmissions: 0, ...overrides };
}
const near = (actual: number | null, expected: number, tolerance = 1e-10) => assert.ok(actual !== null && Math.abs(actual - expected) < tolerance, `${actual} ≈ ${expected}`);
function recipe(kind: QuantityRecipe['kind'] = 'difference'): QuantityRecipe {
  return { id: 'derived', name: 'Difference', kind, operands: kind === 'coefficient' ? ['a'] : ['a', 'b'], alignment: { mode: 'exact', maxGap: 1 }, units: 'Pa', signs: kind === 'coefficient' ? [1] : [1, 1], coefficient: 'reference', reference: 0, scale: 1, density: 2, velocity: 3, area: 4 };
}
function spectrum(overrides: Partial<SpectrumSettings> = {}): SpectrumSettings {
  return { curve: 'a', window: 'hann', detrend: 'mean', sampling: 'reject', step: .01, maxGap: .1, samples: 512, timeUnit: 's', valueUnits: 'Pa', length: 2, velocity: 4, ...overrides };
}
function correlation(overrides: Partial<CorrelationSettings> = {}): CorrelationSettings {
  return { first: 'a', second: 'b', sampling: 'reject', step: .01, maxGap: .1, maxLag: 10, timeUnit: 's', ...overrides };
}

test('variable-deltaT statistics distinguish sample and piecewise-linear time weighting; clip interval edges', () => {
  const data = trace([[0, 0], [1, 1], [3, 3]]);
  const stats = intervalStatistics(data, interval);
  near(stats.mean, 4 / 3); near(stats.rms, Math.sqrt(10 / 3)); near(stats.standardDeviation, Math.sqrt(14 / 9));
  near(stats.weightedMean, 1.5); near(stats.weightedRms, Math.sqrt(3)); near(stats.weightedFluctuationRms, Math.sqrt(.75)); near(stats.slope, 1);
  assert.equal(stats.peakToPeak, 3);
  near(stats.integral, 4.5);
  const csv = serializeIntervalStatisticsCsv([{ key: 'a', label: 'Ramp, "value"', result: stats }]);
  assert.match(csv.split('\n')[0], /Temporal integral \(value times time-axis unit\)/);
  assert.match(csv.split('\n')[1], /"Ramp, ""value"""/);
  assert.ok(csv.split('\n')[1].endsWith(',3,3,4.5'));
  const clipped = intervalStatistics(data, { from: .5, to: 2.5 });
  near(clipped.mean, 1); near(clipped.weightedMean, 1.5); near(clipped.weightedRms, Math.sqrt(31 / 12)); near(clipped.weightedFluctuationRms, Math.sqrt(1 / 3));
  assert.equal(clipped.coveredDuration, 2); assert.equal(clipped.requestedDuration, 2);
  near(clipped.integral, 3);
  const offset = trace([[0, 1e12], [1, 1e12 + 1], [3, 1e12 + 3]]);
  near(intervalStatistics(offset, interval).weightedFluctuationRms, Math.sqrt(.75));
});
test('time weighting does not integrate across explicit gaps; profiles have sample statistics only', () => {
  const data = trace([[0, 0], [1, 1], [2, null], [3, 3], [4, 4]]);
  const stats = intervalStatistics(data, interval);
  assert.equal(stats.gaps, 1); assert.equal(stats.coveredDuration, 2); assert.equal(stats.requestedDuration, 4); near(stats.weightedMean, 2);
  near(stats.integral, 4);
  assert.equal(intervalStatistics({ ...data, mode: 'profile' }, interval).weightedMean, null);
  assert.throws(() => intervalStatistics(trace([[0, 1], [0, 2]]), interval), /strictly increasing/);
});
test('derived differences/magnitudes preserve gaps; explicit interpolation neither extrapolates nor crosses holes', () => {
  const a = trace([[0, 5], [1, 7], [2, 9]]), b = trace([[0, 2], [1, null], [2, 4]], { id: 'b' });
  assert.deepEqual(deriveQuantity(recipe(), [a, b], interval).points, [{ x: 0, y: 3 }, { x: 1, y: null }, { x: 2, y: 5 }]);
  const mag = recipe('magnitude'); mag.units = 'm/s';
  near(deriveQuantity(mag, [trace([[0, 3]]), trace([[0, 4]])], interval).points[0].y, 5);
  const different = trace([[.5, 1], [1.5, 3]]);
  assert.throws(() => deriveQuantity(recipe(), [a, different], interval), /grids differ/);
  const linear = recipe(); linear.alignment = { mode: 'linear', maxGap: 1 };
  assert.deepEqual(deriveQuantity(linear, [a, different], interval).points, [{ x: 0, y: null }, { x: 1, y: 5 }, { x: 2, y: null }]);
  linear.alignment.maxGap = .5;
  assert.ok(deriveQuantity(linear, [a, different], interval).points.every(point => point.y === null));
  assert.throws(() => deriveQuantity(recipe(), [a, { ...b, sourceOmissions: 1 }], interval), /omitted important/);
});
test('pressure, force, reference coefficients and explicit signed mass/volume balances use declared references', () => {
  const q = recipe('coefficient'); q.coefficient = 'pressure'; q.reference = 2;
  near(deriveQuantity(q, [trace([[0, 20]])], interval).points[0].y, 2);
  q.units = 'm2/s2'; near(deriveQuantity(q, [trace([[0, 20]])], interval).points[0].y, 4);
  q.coefficient = 'force'; q.units = 'N'; near(deriveQuantity(q, [trace([[0, 74]])], interval).points[0].y, 2);
  q.coefficient = 'reference'; q.scale = 4; near(deriveQuantity(q, [trace([[0, 10]])], interval).points[0].y, 2);
  const balance = recipe('balance'); balance.units = 'kg/s'; balance.signs = [1, -1];
  near(deriveQuantity(balance, [trace([[0, 3]]), trace([[0, 2.5]])], interval).points[0].y, .5);
  balance.units = 'm3/s'; balance.signs = [1, 1]; near(deriveQuantity(balance, [trace([[0, 3]]), trace([[0, -2.5]])], interval).points[0].y, .5);
  assert.throws(() => deriveQuantity(balance, [trace([[0, 3]]), trace([[0, -2.5]], { caseName: 'other_test' })], interval), /same case/);
  const config = emptyAdvancedAnalysis(); config.quantities = [balance]; balance.units = 'Pa';
  assert.throws(() => validateAdvancedAnalysis(config), /kg\/s or m3\/s/);
  const invalid = emptyAdvancedAnalysis(); invalid.quantities = [recipe('coefficient')]; invalid.quantities[0].velocity = 0;
  assert.throws(() => validateAdvancedAnalysis(invalid), /positive/);
});
test('FFT periodogram recovers a sine frequency, coherent amplitude, PSD energy and Strouhal', () => {
  const data = trace(Array.from({ length: 512 }, (_, index) => [index / 128, 10 + 3 * Math.sin(2 * Math.PI * 8 * index / 128)]));
  const result = spectrumAnalysis(data, interval, spectrum());
  near(result.dominantFrequency, 8); near(result.strouhal, 4); near(result.points[32].amplitude, 3); near(result.frequencyResolution, .25);
  near(result.points.reduce((sum, bin) => sum + bin.psd * result.frequencyResolution, 0), 4.5, 1e-9);
  const rect = spectrumAnalysis(data, interval, spectrum({ window: 'rectangular' })); near(rect.points[32].psd, 18);
  const milliseconds = { ...data, points: data.points.map(point => ({ ...point, x: point.x * 1000 })) };
  near(spectrumAnalysis(milliseconds, interval, spectrum({ timeUnit: 'ms' })).dominantFrequency, 8);
  assert.equal(result.usedSamples, 512); assert.equal(result.availableSamples, 512);
  assert.match(result.notes, /Frequency peaks are bin estimates/);
  assert.match(serializeSpectrumCsv(result, 'Pa,"declared"').split('\n')[0], /"PSD \(Pa,""declared"" squared\/Hz\)"/);
});
test('spectra reject profiles, irregular clocks, duplicate coordinates and explicit gaps; resampling is bounded and opt-in', () => {
  const data = trace(Array.from({ length: 32 }, (_, index) => [index * .1 + (index % 2 ? .001 : 0), Math.sin(index * .1)]));
  assert.throws(() => spectrumAnalysis(data, interval, spectrum({ samples: 16 })), /Irregular/);
  const resampled = spectrumAnalysis(data, interval, spectrum({ samples: 16, sampling: 'resample', step: .1, maxGap: .11 }));
  assert.match(resampled.notes, /Explicit linear resampling/);
  const gaps = { ...data, points: data.points.map((point, index) => index === 4 ? { ...point, y: null } : point) };
  assert.throws(() => spectrumAnalysis(gaps, interval, spectrum({ samples: 16, sampling: 'resample' })), /explicit gaps/);
  assert.throws(() => spectrumAnalysis({ ...data, mode: 'profile' }, interval, spectrum({ samples: 16 })), /spatial profile/);
  assert.throws(() => spectrumAnalysis(data, interval, spectrum({ samples: 16, sampling: 'resample', maxGap: .01 })), /gap or endpoint/);
  assert.throws(() => spectrumAnalysis(data, interval, spectrum({ samples: 16, sampling: 'resample', step: 1e-8 })), /16/);
});
test('cross-correlation reports positive delay when the second signal follows the first', () => {
  let seed = 12345;
  const samples = Array.from({ length: 256 }, () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32 - .5; });
  const a = trace(samples.map((value, index) => [index * .01, value]));
  const b = trace(samples.map((_, index) => [index * .01, index >= 3 ? samples[index - 3] : 0]), { id: 'b' });
  const result = crossCorrelation(a, b, interval, correlation());
  near(result.delay, .03); assert.ok(result.correlation > .999); assert.match(result.notes, /Positive delay means the second/);
  near(crossCorrelation(b, a, interval, correlation()).delay, -.03);
  const huge = (data: ComparisonTrace) => ({ ...data, points: data.points.map(point => ({ ...point, y: point.y! * 1e100 })) });
  near(crossCorrelation(huge(a), huge(b), interval, correlation()).delay, .03);
  assert.throws(() => crossCorrelation(a, { ...b, points: b.points.map(point => ({ ...point, y: 1 })) }, interval, correlation()), /constant/);
  assert.throws(() => crossCorrelation(a, { ...b, points: b.points.map(point => ({ ...point, x: point.x + .001 })) }, interval, correlation()), /grids differ/);
});
test('config bounds and missing operands fail visibly instead of executing arbitrary formulas or retargeting', () => {
  const config = emptyAdvancedAnalysis(); config.spectrum = spectrum({ samples: 100 }); assert.throws(() => validateAdvancedAnalysis(config), /power of two/);
  config.spectrum = null; config.correlation = correlation({ maxLag: 1000 }); assert.throws(() => validateAdvancedAnalysis(config), /0–512/);
  config.correlation = null; config.quantities = [recipe()];
  const result = computeAdvancedAnalysis([{ key: 'b', trace: trace([[0, 1]]) }], validateAdvancedAnalysis(config));
  assert.match(result.warnings[0], /Operand a is unavailable/);
  config.quantities[0].kind = 'eval' as QuantityRecipe['kind']; assert.throws(() => validateAdvancedAnalysis(config), /Invalid quantity/);
});
test('version2 persists quantities/reference/interval/DSP with stable operand keys and migrates v1', async () => {
  const q = recipe(); const advanced = emptyAdvancedAnalysis(); advanced.quantities = [q]; advanced.interval = { from: 0, to: 1 };
  const source = { kind: 'source', caseName: 'math_test', selection: { kind: 'dataset', dataset: 'signals', file: 'p.dat' }, time: null, residualSelection: 'first', field: 'p', mode: 'series', axis: 'Time' };
  const saved = { version: 2, curves: [{ key: 'a', origin: source, color: '#3b82f6', visible: true }, { key: 'b', origin: { ...source, caseName: 'missing_test' }, color: '#ef4444', visible: false }], advanced, logScale: false, tableView: false };
  const parsed = parsePostProcessAnalysis(saved); assert.deepEqual(parsed.advanced, advanced); assert.equal(parsed.curves[0].key, 'a');
  const restored = await replayPostProcessAnalysis(parsed, async name => {
    if (name === 'missing_test') throw new Error('case missing');
    return { mode: 'series', columns: ['Time', 'p'], rows: [[0, 1], [1, 2]], totalRows: 2, times: [], shownTime: null, truncated: false, timesTruncated: false, runsTruncated: false, incompatible: [] };
  }, 'updated');
  assert.equal(restored.curves[0].key, 'a'); assert.equal(restored.curves.length, 1);
  const computed = computeAdvancedAnalysis(restored.curves.map(entry => ({ key: entry.key!, trace: entry.trace })), restored.analysis.advanced!);
  assert.match(computed.warnings[0], /Operand b is unavailable/);
  assert.equal(parsePostProcessAnalysis({ ...saved, version: 1 }).advanced?.quantities.length, 0);
  const frozen = trace([[0, 1], [1, 3]]);
  const entry: AnalysisDisplayCurve = { key: 'a', trace: frozen, origin: { kind: 'captured', trace: frozen }, color: '#3b82f6', visible: true };
  const report = buildPostProcessAnalysisReport('Report', [entry], false, 'now', { ...advanced, quantities: [] });
  assert.match(report, /Advanced analysis/); assert.match(report, /Time-weighted/); assert.match(report, /Reproducible settings/);
  assert.match(report, /Temporal integral \(value × time-axis unit\)/);
  assert.match(report, /<td>1\/1<\/td><td>2<\/td>/);
});

test('CFD balance diagnostics define relative error explicitly and empty/overflow intervals fail visibly', () => {
  const advanced = emptyAdvancedAnalysis(); const q = recipe('balance'); q.units = 'kg/s'; advanced.quantities = [q];
  const a = trace([[0, 1], [1, 0]]), b = trace([[0, -.98], [1, 0]], { id: 'b' });
  const result = computeAdvancedAnalysis([{ key: 'a', trace: a }, { key: 'b', trace: b }], advanced);
  near(result.balances[0].maxAbsoluteNet, .02); near(result.balances[0].maxRelativePercent, 100 * .02 / 1.98); assert.equal(result.balances[0].finiteSamples, 2);
  assert.throws(() => deriveQuantity(recipe(), [a, b], { from: 3, to: 4 }), /No operand samples/);
  assert.throws(() => deriveQuantity(recipe(), [trace([[0, Number.MAX_VALUE]]), trace([[0, -Number.MAX_VALUE]])], interval), /exceeds finite precision/);
});

test('advanced HTML contains derived/DSP numeric outputs, declared references and escaped recipe labels', () => {
  const a = trace(Array.from({ length: 64 }, (_, index) => [index / 64, Math.sin(2 * Math.PI * 4 * index / 64)]));
  const b = { ...a, id: 'b', points: a.points.map(point => ({ x: point.x, y: point.y! / 2 })) };
  const entries: AnalysisDisplayCurve[] = [a, b].map(trace => ({ key: trace.id, trace, origin: { kind: 'captured', trace }, color: '#3b82f6', visible: true }));
  const advanced = emptyAdvancedAnalysis(); advanced.quantities = [recipe()]; advanced.quantities[0].name = '<script>alert(1)</script>'; advanced.spectrum = spectrum({ samples: 64 }); advanced.correlation = correlation({ maxLag: 2 });
  const html = buildPostProcessAnalysisReport('Advanced', entries, false, 'now', advanced);
  assert.ok(!html.includes('<script>')); assert.match(html, /&lt;script&gt;/); assert.match(html, /Derived quantities/); assert.match(html, /PSD — dominant 4 Hz/); assert.match(html, /Cross-correlation/); assert.match(html, /Download all numerical output/); assert.match(html, /maxGap/);
});

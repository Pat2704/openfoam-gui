import { isValidCaseName } from './case-name';
import {
  COMPARISON_TRACE_LIMIT, COMPARISON_READ_LIMIT, comparisonAxisError, createComparisonTrace,
  sampleComparisonTrace, serializeComparisonCsv,
  type ComparisonReader, type ComparisonSelection, type ComparisonTrace,
} from './postprocess-comparison';
import type { ResidualSelection } from './residuals';
import { computeAdvancedAnalysis, emptyAdvancedAnalysis, validateAdvancedAnalysis, type AdvancedAnalysisConfig } from './postprocess-math';

export const CAPTURED_ANALYSIS_POINT_LIMIT = 20000;
export const ANALYSIS_REPORT_BYTE_LIMIT = 12 * 1024 * 1024;

export interface AnalysisSource {
  kind: 'source';
  caseName: string;
  selection: ComparisonSelection;
  time: string | null;
  residualSelection: ResidualSelection;
  field: string;
  mode: 'series' | 'profile';
  axis: string;
}
export type AnalysisOrigin = AnalysisSource | { kind: 'captured'; trace: ComparisonTrace };
export interface AnalysisCurve { key?: string; origin: AnalysisOrigin; color: string; visible: boolean }
export interface SavedPostProcessAnalysis {
  version: 1 | 2;
  curves: AnalysisCurve[];
  logScale: boolean;
  tableView: boolean;
  advanced?: AdvancedAnalysisConfig;
}
export interface AnalysisDisplayCurve extends AnalysisCurve { trace: ComparisonTrace }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid analysis object.');
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`Invalid analysis ${label}.`);
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid analysis display option.');
  return value;
}
function count(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid analysis ${label}.`);
  return value;
}
function caseName(value: unknown): string {
  if (!isValidCaseName(value)) throw new Error('Invalid analysis case name.');
  return value;
}
function mode(value: unknown): 'series' | 'profile' {
  if (value !== 'series' && value !== 'profile') throw new Error('Invalid analysis data mode.');
  return value;
}
function residual(value: unknown): ResidualSelection {
  if (value !== 'first' && value !== 'last' && value !== 'maximum') throw new Error('Invalid residual selection.');
  return value;
}

/** Captured values are intentionally frozen; they are never replayed as a file read. */
export function validateCapturedAnalysisTrace(value: unknown): ComparisonTrace {
  const trace = record(value);
  if (!Array.isArray(trace.points) || !trace.points.length || trace.points.length > CAPTURED_ANALYSIS_POINT_LIMIT) throw new Error(`A captured curve supports 1–${CAPTURED_ANALYSIS_POINT_LIMIT} points.`);
  const points = trace.points.map(value => {
    const point = record(value);
    if (typeof point.x !== 'number' || !Number.isFinite(point.x) || (point.y !== null && (typeof point.y !== 'number' || !Number.isFinite(point.y)))) throw new Error('Invalid captured numerical values.');
    return { x: point.x, y: point.y as number | null };
  });
  if (!points.some(point => point.y !== null)) throw new Error('The captured curve has no finite values.');
  const totalRows = count(trace.totalRows, 'row count');
  if (totalRows < points.length) throw new Error('Captured coverage is inconsistent.');
  return {
    id: text(trace.id, 'curve ID', 128), label: text(trace.label, 'label'), caseName: caseName(trace.caseName),
    source: text(trace.source, 'provenance'), snapshot: trace.snapshot === null ? null : text(trace.snapshot, 'snapshot', 128),
    residualSelection: trace.residualSelection === null ? null : residual(trace.residualSelection), mode: mode(trace.mode),
    axis: text(trace.axis, 'axis', 256), field: text(trace.field, 'field', 256), loadedAt: text(trace.loadedAt, 'capture time', 128),
    points, totalRows, coverage: text(trace.coverage, 'coverage', 4096), sourceOmissions: count(trace.sourceOmissions, 'omissions'),
  };
}

export function parsePostProcessAnalysis(value: unknown): SavedPostProcessAnalysis {
  const analysis = record(value);
  if (analysis.version !== 1 && analysis.version !== 2) throw new Error('Unsupported Post-Process analysis version.');
  if (!Array.isArray(analysis.curves) || !analysis.curves.length || analysis.curves.length > COMPARISON_TRACE_LIMIT) throw new Error(`An analysis supports 1–${COMPARISON_TRACE_LIMIT} curves.`);
  const curves = analysis.curves.map((value, index) => {
    const curve = record(value);
    const input = record(curve.origin);
    let origin: AnalysisOrigin;
    if (input.kind === 'captured') origin = { kind: 'captured', trace: validateCapturedAnalysisTrace(input.trace) };
    else if (input.kind === 'source') {
      const selected = record(input.selection);
      let selection: ComparisonSelection;
      // The existing case-read endpoints apply the shared path validators before a read.
      if (selected.kind === 'dataset') selection = { kind: 'dataset', dataset: text(selected.dataset, 'dataset', 1024), file: text(selected.file, 'file', 1024) };
      else if (selected.kind === 'log') selection = { kind: 'log', log: text(selected.log, 'log', 128) };
      else throw new Error('Unknown saved source kind.');
      origin = {
        kind: 'source', caseName: caseName(input.caseName), selection, time: input.time === null ? null : text(input.time, 'snapshot', 128),
        residualSelection: residual(input.residualSelection), field: text(input.field, 'field', 256), mode: mode(input.mode), axis: text(input.axis, 'axis', 256),
      };
      if ((origin.mode === 'profile') !== (origin.time !== null)) throw new Error('A saved profile must identify its exact snapshot.');
    } else throw new Error('Unknown analysis origin.');
    const color = text(curve.color, 'curve color', 7);
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Invalid analysis curve color.');
    return { key: analysis.version === 2 ? text(curve.key, 'stable curve key', 128) : `curve-${index}`, origin, color, visible: bool(curve.visible) };
  });
  if (new Set(curves.map(curve => curve.key)).size !== curves.length) throw new Error('Saved curve keys must be distinct.');
  const reference = curves[0].origin.kind === 'source' ? curves[0].origin : curves[0].origin.trace;
  for (const curve of curves.slice(1)) {
    const candidate = curve.origin.kind === 'source' ? curve.origin : curve.origin.trace;
    const error = comparisonAxisError(reference, candidate);
    if (error) throw new Error(error);
  }
  return { version: 2, curves, logScale: bool(analysis.logScale), tableView: bool(analysis.tableView), advanced: analysis.version === 2 ? validateAdvancedAnalysis(analysis.advanced) : emptyAdvancedAnalysis() };
}

/** Re-read source-backed curves; missing fields/snapshots never silently fall back. */
export async function replayPostProcessAnalysis(value: unknown, readData: ComparisonReader, loadedAt: string): Promise<{ analysis: SavedPostProcessAnalysis; curves: AnalysisDisplayCurve[]; warnings: string[] }> {
  const analysis = parsePostProcessAnalysis(value);
  const curves: AnalysisDisplayCurve[] = [];
  const warnings: string[] = [];
  for (const [index, curve] of analysis.curves.entries()) {
    try {
      let trace: ComparisonTrace;
      if (curve.origin.kind === 'captured') trace = { ...curve.origin.trace, id: `restored-${index}` };
      else {
        const source = curve.origin;
        const table = await readData(source.caseName, source.selection, source.time ?? undefined, COMPARISON_READ_LIMIT, source.residualSelection);
        if (table.mode !== source.mode || table.columns[0] !== source.axis) throw new Error('The source coordinate or data mode has changed.');
        if (source.time !== null && table.shownTime !== source.time) throw new Error(`Snapshot ${source.time} is no longer available.`);
        const matches = table.columns.map((name, index) => name === source.field && index > 0 ? index : -1).filter(index => index > 0);
        if (matches.length !== 1) throw new Error(`Field ${source.field} is missing or ambiguous.`);
        trace = createComparisonTrace({ id: `restored-${index}`, caseName: source.caseName, selection: source.selection, table, fieldIndex: matches[0], residualSelection: source.residualSelection, loadedAt });
        if (!trace.points.some(point => point.y !== null)) throw new Error('The source has no finite values.');
      }
      const error = curves.length ? comparisonAxisError(curves[0].trace, trace) : null;
      if (error) throw new Error(error);
      curves.push({ ...curve, trace });
    } catch (error) {
      const label = curve.origin.kind === 'captured' ? curve.origin.trace.label : `${curve.origin.caseName} / ${curve.origin.field}`;
      warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { analysis, curves, warnings };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
export function analysisCurveStatistics(trace: ComparisonTrace): { count: number; gaps: number; min: number | null; max: number | null; mean: number | null } {
  let count = 0, min = Infinity, max = -Infinity, mean = 0;
  for (const point of trace.points) {
    if (point.y === null) continue;
    count += 1;
    min = Math.min(min, point.y); max = Math.max(max, point.y);
    // This weighted form also avoids overflow when finite samples have opposite signs.
    mean = mean * ((count - 1) / count) + point.y / count;
  }
  return { count, gaps: trace.points.length - count, min: count ? min : null, max: count ? max : null, mean: count ? mean : null };
}

export function buildPostProcessAnalysisReport(title: string, entries: readonly AnalysisDisplayCurve[], logScale: boolean, createdAt: string, advanced?: AdvancedAnalysisConfig): string {
  if (!entries.length || entries.length > COMPARISON_TRACE_LIMIT) throw new Error('Choose at least one curve for the report.');
  const visible = entries.filter(entry => entry.visible);
  if (!visible.length) throw new Error('Enable at least one curve for the report.');
  const axis = visible[0].trace.axis;
  for (const entry of visible) {
    if (!/^#[0-9a-f]{6}$/i.test(entry.color)) throw new Error('Invalid report color.');
    const error = comparisonAxisError(visible[0].trace, entry.trace);
    if (error) throw new Error(error);
  }
  const sampled = visible.map(entry => ({ ...entry, ...sampleComparisonTrace(entry.trace, logScale) }));
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const entry of sampled) for (const point of entry.points) if (point.y !== null) {
    xmin = Math.min(xmin, point.x); xmax = Math.max(xmax, point.x);
    const y = logScale ? Math.log10(point.y) : point.y;
    ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
  }
  const chart: string[] = [];
  if (xmin !== Infinity) {
    const fraction = (value: number, min: number, max: number) => {
      if (min === max) return 0.5;
      const span = max - min;
      return Number.isFinite(span) ? (value - min) / span : (value / 2 - min / 2) / (max / 2 - min / 2);
    };
    const px = (x: number) => 85 + fraction(x, xmin, xmax) * 790;
    const py = (y: number) => 365 - fraction(logScale ? Math.log10(y) : y, ymin, ymax) * 330;
    chart.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 920 420" role="img" aria-label="Curve comparison"><path d="M85 35V365H875" fill="none" stroke="#64748b"/>');
    for (const entry of sampled) {
      const segments: string[] = []; let segment = '';
      for (const point of entry.points) {
        if (point.y === null) { if (segment) segments.push(segment); segment = ''; continue; }
        segment += `${segment ? ' L' : 'M'}${px(point.x).toFixed(3)} ${py(point.y).toFixed(3)}`;
      }
      if (segment) segments.push(segment);
      for (const path of segments) chart.push(`<path d="${path}" fill="none" stroke="${entry.color}" stroke-width="1.5"/>`);
      for (const [index, point] of entry.points.entries()) if (point.y !== null && entry.points[index - 1]?.y == null && entry.points[index + 1]?.y == null) chart.push(`<circle cx="${px(point.x).toFixed(3)}" cy="${py(point.y).toFixed(3)}" r="2" fill="${entry.color}"/>`);
    }
    chart.push(`<text x="85" y="385" font-size="12">${escapeHtml(String(xmin))}</text><text x="875" y="385" text-anchor="end" font-size="12">${escapeHtml(String(xmax))}</text><text x="75" y="40" text-anchor="end" font-size="11">${escapeHtml(String(logScale ? 10 ** ymax : ymax))}</text><text x="75" y="365" text-anchor="end" font-size="11">${escapeHtml(String(logScale ? 10 ** ymin : ymin))}</text><text x="480" y="412" text-anchor="middle" font-size="14">${escapeHtml(axis)}</text><text x="18" y="200" transform="rotate(-90 18 200)" text-anchor="middle" font-size="14">${logScale ? 'Value (log Y)' : 'Value'}</text></svg>`);
  } else chart.push('<p>No curves can be drawn within the chart limits.</p>');
  const rows = visible.map(entry => {
    const stats = analysisCurveStatistics(entry.trace);
    const sample = sampled.find(sample => sample.trace.id === entry.trace.id)!;
    return `<tr><td><span style="color:${entry.color}">●</span> ${escapeHtml(entry.trace.label)}</td><td>${stats.count} / ${stats.gaps}</td><td>${stats.min ?? '—'}</td><td>${stats.max ?? '—'}</td><td>${stats.mean ?? '—'}</td></tr><tr><td colspan="5" class="provenance">${entry.origin.kind === 'captured' ? 'Captured snapshot (not re-read)' : 'Source-backed curve'} · ${escapeHtml(entry.trace.source)} · ${escapeHtml(entry.trace.mode)} · ${escapeHtml(entry.trace.axis)} · captured/loaded ${escapeHtml(entry.trace.loadedAt)}<br>${escapeHtml(entry.trace.coverage)} · chart ${sample.points.length}/${entry.trace.points.length} points${sample.blocked ? ' (withheld: important boundaries omitted)' : ''}</td></tr>`;
  }).join('');
  // Check a lower bound before serializing so very long labels cannot allocate a giant CSV.
  const minimumCsvSize = visible.reduce((sum, { trace }) => sum + trace.points.length * (trace.label.length + trace.caseName.length + trace.source.length + trace.axis.length + trace.field.length + trace.coverage.length + trace.loadedAt.length + 20), 0);
  if (minimumCsvSize > ANALYSIS_REPORT_BYTE_LIMIT / 3) throw new Error('The report CSV exceeds 4 MB. Export the comparison CSV separately or reduce the curves.');
  const csv = serializeComparisonCsv(visible.map(entry => entry.trace));
  if (new TextEncoder().encode(csv).length > ANALYSIS_REPORT_BYTE_LIMIT / 3) throw new Error('The report CSV exceeds 4 MB. Export the comparison CSV separately or reduce the curves.');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:14px system-ui,sans-serif;color:#0f172a;margin:2rem auto;max-width:1100px;padding:0 1rem}h1{font-size:24px}svg{width:100%;height:auto}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border-bottom:1px solid #cbd5e1;text-align:left;padding:8px;overflow-wrap:anywhere}.provenance{color:#475569;font-size:11px}a{color:#2563eb}@media print{body{margin:0;max-width:none}.download{display:none}tr{break-inside:avoid}svg{max-height:100mm}}</style></head><body><h1>${escapeHtml(title)}</h1><p>OpenFOAM Studio · report ${escapeHtml(createdAt)}</p><p>Independent grids and missing-value gaps are preserved. Values have no inferred units or coordinate conversion. Statistics are sample statistics over all retained loaded rows, including non-positive values; log Y only changes the chart. They are not time-weighted or spatial integrals.</p>${chart.join('')}<table><thead><tr><th>Curve</th><th>Finite / gaps</th><th>Min</th><th>Max</th><th>Sample mean</th></tr></thead><tbody>${rows}</tbody></table><p class="download"><a download="post-process-analysis.csv" href="data:text/csv;charset=utf-8,${encodeURIComponent(csv)}">Download retained numerical rows and provenance (CSV)</a></p><p>Chart cap: 1,200 points per curve. Curves are withheld when safe sampling cannot preserve boundaries. The CSV contains every retained loaded row, independent of chart sampling.</p></body></html>`;
  if (new TextEncoder().encode(html).length > ANALYSIS_REPORT_BYTE_LIMIT) throw new Error('The report exceeds 12 MB. Export CSV separately or reduce the curves.');
  if (!advanced) return html;
  const config = validateAdvancedAnalysis(advanced);
  const results = computeAdvancedAnalysis(entries.map(entry => ({ key: entry.key ?? entry.trace.id, trace: entry.trace })), config);
  let sections = `<h2>Advanced analysis</h2><p>Selected interval: ${config.interval.from ?? 'source start'}–${config.interval.to ?? 'source end'}. Population sample statistics; time-weighted values integrate piecewise-linear finite adjacent segments and exclude gaps. Covered duration is reported separately from the requested interval. Reference values, units and orientations are supplied by the user.</p><table><thead><tr><th>Curve</th><th>Finite/gaps</th><th>Mean</th><th>RMS</th><th>Fluctuation RMS / population SD</th><th>Peak-to-peak</th><th>Least-squares slope</th><th>Time-weighted mean/RMS/fluctuation RMS</th><th>Covered/requested duration</th><th>Temporal integral (value × time-axis unit)</th></tr></thead><tbody>`;
  for (const stats of results.statistics) {
    const s = stats.result;
    sections += `<tr><td>${escapeHtml(stats.label)}</td>${s ? `<td>${s.samples}/${s.gaps}</td><td>${s.mean}</td><td>${s.rms}</td><td>${s.fluctuationRms}</td><td>${s.peakToPeak}</td><td>${s.slope ?? 'undefined'}</td><td>${s.weightedMean ?? 'n/a'} / ${s.weightedRms ?? 'n/a'} / ${s.weightedFluctuationRms ?? 'n/a'}</td><td>${s.coveredDuration}/${s.requestedDuration}</td><td>${s.integral ?? 'n/a'}</td>` : `<td colspan="9">${escapeHtml(stats.error ?? 'Unavailable')}</td>`}</tr>`;
  }
  sections += '</tbody></table>';
  for (const balance of results.balances) {
    const name = config.quantities.find(recipe => recipe.id === balance.id)!.name;
    sections += `<p>${escapeHtml(name)}: ${balance.finiteSamples} finite balance samples; last net ${balance.lastNet ?? 'undefined'}; maximum |net| ${balance.maxAbsoluteNet ?? 'undefined'}; maximum 100·|signed sum|/sum(|operand flux|) ${balance.maxRelativePercent ?? 'undefined'}%. The relative error is undefined at zero total absolute flux. Storage/source terms and density are not inferred.</p>`;
  }
  if (results.quantities.length) {
    const derivedHtml = buildPostProcessAnalysisReport('Derived quantities / signed flux balances', results.quantities.map((trace, index) => ({ trace, origin: { kind: 'captured', trace }, color: ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#06b6d4'][index], visible: true })), false, createdAt);
    sections += derivedHtml.slice(derivedHtml.indexOf('<body>') + 6, derivedHtml.lastIndexOf('</body>')).replaceAll('Captured snapshot (not re-read)', 'Derived from the loaded operands; saved recipe is replayed');
  }
  const numericalOutput = (title: string, columns: string[], rows: number[][], notes: string) => {
    const csv = columns.join(',') + '\n' + rows.map(row => row.join(',')).join('\n');
    const trace: ComparisonTrace = { ...entries[0].trace, id: 'advanced-report-output', label: title, field: columns[1], mode: 'series', axis: columns[0], source: notes, points: rows.map(row => ({ x: row[0], y: row[1] })), totalRows: rows.length, coverage: notes, sourceOmissions: 0 };
    const output = buildPostProcessAnalysisReport(title, [{ trace, origin: { kind: 'captured', trace }, color: '#8b5cf6', visible: true }], false, createdAt);
    return `<h3>${escapeHtml(title)}</h3><p>${escapeHtml(notes)}</p>${output.slice(output.indexOf('<svg'), output.indexOf('</svg>') + 6)}<a class="download" download="advanced-analysis.csv" href="data:text/csv;charset=utf-8,${encodeURIComponent(csv)}">Download all numerical output (CSV)</a>`;
  };
  if (results.spectrum) {
    const s = results.spectrum;
    sections += numericalOutput(`PSD — dominant ${s.dominantFrequency ?? 'undefined'} Hz; Strouhal ${s.strouhal ?? 'not supplied'}`, ['Frequency (Hz)', 'PSD', 'Peak amplitude'], s.points.map(point => [point.frequency, point.psd, point.amplitude]), `${s.notes} Nyquist ${s.nyquist} Hz; resolution ${s.frequencyResolution} Hz; interval used ${s.from}–${s.to}.`);
  }
  if (results.correlation) {
    const c = results.correlation;
    sections += numericalOutput(`Cross-correlation — second follows first by ${c.delay} s; coefficient ${c.correlation}`, ['Delay (s)', 'Normalized correlation', 'Overlap pairs'], c.points.map(point => [point.delay, point.correlation, point.pairs]), c.notes);
  }
  sections += `<p>${results.warnings.map(escapeHtml).join('<br>')}</p><h3>Reproducible settings</h3><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(JSON.stringify(config, null, 2))}</pre>`;
  const complete = html.replace('</body>', `${sections}</body>`);
  if (new TextEncoder().encode(complete).length > ANALYSIS_REPORT_BYTE_LIMIT) throw new Error('The advanced report exceeds 12 MB. Export numerical CSV separately or reduce the interval/curves.');
  return complete;
}

import { sampleRowsForChart } from './postprocess';
import type { ResidualSelection } from './residuals';

export const COMPARISON_TRACE_LIMIT = 6;
export const COMPARISON_READ_LIMIT = 200000;
export const COMPARISON_CHART_LIMIT = 1200;

export type ComparisonSelection =
  | { kind: 'dataset'; dataset: string; file: string }
  | { kind: 'log'; log: string };

export interface ComparisonTable {
  mode: 'series' | 'profile';
  columns: string[];
  rows: (number | null)[][];
  totalRows: number;
  times: string[];
  shownTime: string | null;
  truncated: boolean;
  timesTruncated: boolean;
  runsTruncated: boolean;
  incompatible: string[];
  omittedFeatures?: number;
  diagnostics?: { skippedRows: number; nonFiniteCells: number };
  logCoverage?: { returnedLines: number; maxLines: number; maxBytes: number };
}

export type ComparisonReader = (
  caseName: string, selection: ComparisonSelection, time?: string,
  maxPoints?: number, residualSelection?: ResidualSelection,
) => Promise<ComparisonTable>;

export interface ComparisonPoint { x: number; y: number | null }
export interface ComparisonTrace {
  id: string;
  label: string;
  caseName: string;
  source: string;
  snapshot: string | null;
  residualSelection: ResidualSelection | null;
  mode: 'series' | 'profile';
  axis: string;
  field: string;
  loadedAt: string;
  points: ComparisonPoint[];
  totalRows: number;
  coverage: string;
  sourceOmissions: number;
}

export function comparisonSource(selection: ComparisonSelection): string {
  if (selection.kind === 'log') {
    return selection.log === 'log' || selection.log.startsWith('log.') ? selection.log : `log.${selection.log}`;
  }
  return `postProcessing/${selection.dataset}/${selection.file}`;
}

/** Names must agree; the file contains no reliable unit or coordinate-frame metadata. */
export function comparisonAxisError(reference: Pick<ComparisonTrace, 'mode' | 'axis'>, candidate: Pick<ComparisonTrace, 'mode' | 'axis'>): string | null {
  if (reference.mode !== candidate.mode) return 'Time series and spatial profiles cannot share a comparison.';
  const normalize = (axis: string) => axis.trim().replace(/\s+/g, ' ').toLowerCase();
  if (normalize(reference.axis) !== normalize(candidate.axis)) {
    return `Independent axes differ: ${reference.axis} and ${candidate.axis}. No coordinate conversion is applied.`;
  }
  return null;
}

export function comparisonCoverage(table: ComparisonTable): string {
  const notes: string[] = [`${table.rows.length}/${table.totalRows} retained rows`, `read cap ${COMPARISON_READ_LIMIT}`];
  if (table.rows.length < table.totalRows) notes.push('source sampled');
  if (table.truncated) notes.push('source read truncated');
  if (table.timesTruncated) notes.push('time inventory truncated');
  if (table.runsTruncated) notes.push('restart inventory truncated');
  if (table.incompatible.length) notes.push(`${table.incompatible.length} incompatible files skipped`);
  if (table.diagnostics?.skippedRows) notes.push(`${table.diagnostics.skippedRows} malformed rows skipped`);
  if (table.diagnostics?.nonFiniteCells) notes.push(`${table.diagnostics.nonFiniteCells} non-finite cells`);
  if (table.omittedFeatures) notes.push(`${table.omittedFeatures} source features omitted`);
  if (table.logCoverage) notes.push(`log ${table.logCoverage.returnedLines} lines; caps ${table.logCoverage.maxLines} lines/${table.logCoverage.maxBytes} bytes`);
  return notes.join('; ');
}

export function createComparisonTrace(options: {
  id: string; caseName: string; selection: ComparisonSelection; table: ComparisonTable;
  fieldIndex: number; residualSelection?: ResidualSelection; loadedAt: string;
}): ComparisonTrace {
  const { table, fieldIndex } = options;
  if (!Number.isInteger(fieldIndex) || fieldIndex < 1 || fieldIndex >= table.columns.length) throw new Error('Select a value column.');
  const axis = table.columns[0];
  if (!axis?.trim()) throw new Error('The independent coordinate has no name.');
  const points = table.rows.map(row => {
    const x = row[0];
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error('Invalid independent coordinate; this source cannot be compared safely.');
    const value = row[fieldIndex];
    return { x, y: typeof value === 'number' && Number.isFinite(value) ? value : null };
  });
  const source = comparisonSource(options.selection);
  const field = table.columns[fieldIndex];
  const residualSelection = options.selection.kind === 'log' ? options.residualSelection ?? 'first' : null;
  const snapshot = table.mode === 'profile' ? table.shownTime : null;
  const label = `${options.caseName} · ${source}${snapshot === null ? '' : ` · t=${snapshot}`} · ${field}${residualSelection ? ` (${residualSelection} initial)` : ''}`;
  return {
    id: options.id, label, caseName: options.caseName, source, snapshot, residualSelection,
    mode: table.mode, axis, field, loadedAt: options.loadedAt, points,
    totalRows: table.totalRows, coverage: comparisonCoverage(table), sourceOmissions: table.omittedFeatures ?? 0,
  };
}

/** Refuse the preview if its budget would erase boundaries and join unrelated segments. */
export function sampleComparisonTrace(trace: Pick<ComparisonTrace, 'points' | 'sourceOmissions'>, logScale = false, limit = COMPARISON_CHART_LIMIT): { points: ComparisonPoint[]; blocked: boolean } {
  if (!Number.isFinite(limit) || limit < 1) throw new Error('The chart limit must be a positive finite number.');
  if (trace.sourceOmissions > 0) return { points: [], blocked: true };
  const rows = trace.points.map(point => [point.x, point.y === null || (logScale && point.y <= 0) ? NaN : point.y]);
  const sampled = sampleRowsForChart(rows, limit);
  if (sampled.omittedFeatures) return { points: [], blocked: true };
  return { points: sampled.rows.map(row => ({ x: row[0], y: Number.isFinite(row[1]) ? row[1] : null })), blocked: false };
}

/** Long format keeps independent grids and repeated coordinates intact. */
export function serializeComparisonCsv(traces: readonly ComparisonTrace[]): string {
  const cell = (value: string | number | null) => {
    if (value === null) return '';
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [['Curve', 'Case', 'Source', 'Snapshot', 'Residual selection', 'Mode', 'Axis', 'Coordinate', 'Series', 'Value', 'Loaded at', 'Returned rows', 'Total retained rows', 'Coverage'].join(',')];
  for (const trace of traces) {
    for (const point of trace.points) {
      lines.push([trace.label, trace.caseName, trace.source, trace.snapshot, trace.residualSelection, trace.mode, trace.axis, point.x, trace.field, point.y, trace.loadedAt, trace.points.length, trace.totalRows, trace.coverage].map(cell).join(','));
    }
  }
  return lines.join('\n') + '\n';
}

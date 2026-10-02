import { sampleRowsForChart } from './postprocess';

export type ParaViewDataAssociation = 'POINTS' | 'CELLS' | 'ROWS';
export type ParaViewDataMode = 'schema' | 'page' | 'chart' | 'export';

export interface ParaViewDataColumn {
  index: number;
  label: string;
  name: string;
  kind: 'index' | 'coordinate' | 'array';
  component: number;
}

export interface ParaViewDataBlock { index: number; label: string }

export interface ParaViewDataRequest {
  mode: ParaViewDataMode;
  id: string;
  revision: number;
  time: number;
  block?: number;
  association?: ParaViewDataAssociation;
  columns?: number[];
  offset?: number;
}

export interface ParaViewDataTable {
  id: string;
  revision: number;
  time: number;
  block: number;
  blocks: ParaViewDataBlock[];
  blocksLimited: boolean;
  association: ParaViewDataAssociation;
  associations: ParaViewDataAssociation[];
  columns: ParaViewDataColumn[];
  columnsLimited: boolean;
  nonNumericColumns: number;
  selectedColumns: number[];
  rows: (number | null)[][];
  totalRows: number;
  offset: number;
  limited: boolean;
  invalidRows: number;
  nonFiniteValues: number;
  rowLimit: number;
}

function integer(value: unknown, name: string, maximum = 2_147_483_647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`Invalid ParaView data ${name}.`);
  }
  return value;
}

export function paraViewDataRequest(value: unknown): ParaViewDataRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ParaView data request.');
  const data = value as Record<string, unknown>;
  if (!['schema', 'page', 'chart', 'export'].includes(String(data.mode))) throw new Error('Unsupported ParaView data mode.');
  if (typeof data.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(data.id)) throw new Error('Invalid pipeline item.');
  if (typeof data.time !== 'number' || !Number.isFinite(data.time)) throw new Error('Invalid ParaView data time.');
  const request: ParaViewDataRequest = {
    mode: data.mode as ParaViewDataMode, id: data.id, time: data.time,
    revision: integer(data.revision, 'revision'),
  };
  if (data.block !== undefined) request.block = integer(data.block, 'block');
  if (data.offset !== undefined) request.offset = integer(data.offset, 'offset');
  if (data.association !== undefined) {
    if (!['POINTS', 'CELLS', 'ROWS'].includes(String(data.association))) throw new Error('Unsupported data association.');
    request.association = data.association as ParaViewDataAssociation;
  }
  if (data.columns !== undefined) {
    if (!Array.isArray(data.columns) || data.columns.length < 1 || data.columns.length > 16) throw new Error('Choose between 1 and 16 numeric columns.');
    request.columns = [...new Set(data.columns.map(column => integer(column, 'column', 127)))];
  }
  return request;
}

export function defaultParaViewColumns(columns: ParaViewDataColumn[]): { x: number; series: number[] } {
  const numeric = columns.filter(column => column.kind === 'array' && column.name !== 'vtkValidPointMask');
  const x = columns.find(column => column.name === 'arc_length')
    || numeric.find(column => /^(time|distance|x)$/i.test(column.name))
    || columns.find(column => column.kind === 'coordinate' && column.component === 0) || columns[0];
  const candidates = numeric.filter(column => column.index !== x?.index && column.name !== 'arc_length');
  const chosen = candidates.find(column => column.name === 'U' && column.component === -1)
    || candidates.find(column => column.name === 'p') || candidates[0];
  return { x: x?.index ?? 0, series: chosen ? [chosen.index] : [] };
}

export function paraViewChartRows(rows: (number | null)[][], limit = 4000): {
  rows: (number | null)[][]; omittedFeatures: number;
} {
  const sampled = sampleRowsForChart(rows.map(row => row.map((value, index) =>
    index > 0 && !Number.isFinite(row[0]) ? NaN : value ?? NaN)), limit);
  return { rows: sampled.rows.map(row => row.map(value => Number.isFinite(value) ? value : null)), omittedFeatures: sampled.omittedFeatures };
}

export function paraViewTableCsv(data: ParaViewDataTable): string {
  const quote = (text: string) => /[,"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  const headers = data.selectedColumns.map(index => data.columns.find(column => column.index === index)?.label ?? `Column ${index}`);
  return [headers.map(quote).join(','), ...data.rows.map(row => row.map(value => value === null || !Number.isFinite(value) ? '' : String(value)).join(','))].join('\r\n');
}

export function isolatedParaViewSample(rows: (number | null)[][], index: number, column: number): boolean {
  const drawable = (row: (number | null)[] | undefined) => Boolean(row && Number.isFinite(row[0]) && Number.isFinite(row[column]));
  return drawable(rows[index]) && !drawable(rows[index - 1]) && !drawable(rows[index + 1]);
}

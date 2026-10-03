import type { ParaViewWorkbenchState } from './paraview';

export type AnalysisAssociation = 'POINTS' | 'CELLS';
export interface AnalysisGuard { id: string; revision: number; time: number }
export interface ProbeRequest extends AnalysisGuard { block: number; association: AnalysisAssociation; position: [number, number, number] }
export interface SelectionRecipe { block: number; association: AnalysisAssociation; name: string; component: number; lower: number; upper: number }
export interface FindDataRequest extends AnalysisGuard, SelectionRecipe {}
export interface DiagnosticSettings { association: AnalysisAssociation; name: string; prefix: string }
export interface VolumeSettings { opacityPoints: [number, number][]; unitDistance: number }
export interface ProbeResult extends AnalysisGuard {
  block: number; association: AnalysisAssociation; position: [number, number, number]; inside: boolean;
  values: { name: string; components: (number | null)[]; magnitude: number | null }[];
  limited: boolean; note: string;
}
export interface FindDataResult extends FindDataRequest {
  rows: { index: number; coordinate: [number | null, number | null, number | null]; value: number }[];
  matched: number; scanned: number; total: number; limited: boolean; scanLimited: boolean;
}

function record(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid ParaView analysis request.');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unsupported ParaView analysis parameter.');
  return value;
}
function finite(raw: unknown, label: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) > 1e15) throw new Error(`Invalid ${label}.`);
  return raw;
}
export function analysisNumber(text: string, label: string): number {
  if (!text.trim()) throw new Error(`Enter ${label}.`);
  return finite(Number(text), label);
}
function integer(raw: unknown, label: string, lo = 0, hi = 2_147_483_647): number {
  const value = finite(raw, label);
  if (!Number.isSafeInteger(value) || value < lo || value > hi) throw new Error(`Invalid ${label}.`);
  return value;
}
function association(raw: unknown): AnalysisAssociation {
  if (raw !== 'POINTS' && raw !== 'CELLS') throw new Error('Choose points or cells.');
  return raw;
}
function name(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > 160 || /[\x00-\x1f]/.test(raw)) throw new Error('Invalid data array.');
  return raw;
}
export function analysisGuard(raw: Record<string, unknown>): AnalysisGuard {
  if (typeof raw.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(raw.id)) throw new Error('Invalid pipeline item.');
  return { id: raw.id, revision: integer(raw.revision, 'revision'), time: finite(raw.time, 'time') };
}
export function probeRequest(raw: unknown): ProbeRequest {
  const value = record(raw, ['id', 'revision', 'time', 'block', 'association', 'position']);
  if (!Array.isArray(value.position) || value.position.length !== 3) throw new Error('Choose an XYZ probe location.');
  return { ...analysisGuard(value), block: integer(value.block, 'block'), association: association(value.association), position: value.position.map(item => finite(item, 'probe location')) as [number, number, number] };
}
export function selectionRecipe(raw: unknown): SelectionRecipe {
  const value = record(raw, ['block', 'association', 'name', 'component', 'lower', 'upper']);
  const lower = finite(value.lower, 'lower threshold'), upper = finite(value.upper, 'upper threshold');
  if (lower > upper) throw new Error('The lower threshold must not exceed the upper threshold.');
  return { block: integer(value.block, 'block'), association: association(value.association), name: name(value.name), component: integer(value.component, 'component', -1, 15), lower, upper };
}
export function findDataRequest(raw: unknown): FindDataRequest {
  const value = record(raw, ['id', 'revision', 'time', 'block', 'association', 'name', 'component', 'lower', 'upper']);
  const settings = { block: value.block, association: value.association, name: value.name, component: value.component, lower: value.lower, upper: value.upper };
  return { ...analysisGuard(value), ...selectionRecipe(settings) };
}
export function diagnosticSettings(raw: unknown): DiagnosticSettings {
  const value = record(raw, ['association', 'name', 'prefix']);
  if (typeof value.prefix !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value.prefix)) throw new Error('Use a short result prefix containing letters, numbers and underscores.');
  return { association: association(value.association), name: name(value.name), prefix: value.prefix };
}
export function diagnosticRequest(raw: unknown) {
  const value = record(raw, ['id', 'revision', 'time', 'diagnostic']);
  return { ...analysisGuard(value), diagnostic: diagnosticSettings(value.diagnostic) };
}
export function resampleRequest(raw: unknown) {
  const value = record(raw, ['id', 'revision', 'time', 'dimensions']);
  if (!Array.isArray(value.dimensions) || value.dimensions.length !== 3) throw new Error('Choose XYZ sampling dimensions.');
  const dimensions = value.dimensions.map(item => integer(item, 'sampling dimension', 2, 160)) as [number, number, number];
  if (dimensions.reduce((a, b) => a * b, 1) > 2_000_000) throw new Error('Resampling is limited to two million points.');
  return { ...analysisGuard(value), dimensions };
}
export function volumeSettings(raw: unknown): VolumeSettings {
  const value = record(raw, ['opacityPoints', 'unitDistance']);
  const unitDistance = finite(value.unitDistance, 'opacity unit distance');
  if (unitDistance < 1e-12) throw new Error('Opacity unit distance must be positive.');
  if (!Array.isArray(value.opacityPoints) || value.opacityPoints.length < 2 || value.opacityPoints.length > 16) throw new Error('Use between two and sixteen opacity points.');
  let last = -Infinity;
  const opacityPoints = value.opacityPoints.map(item => {
    if (!Array.isArray(item) || item.length !== 2) throw new Error('Invalid opacity point.');
    const x = finite(item[0], 'opacity coordinate'), opacity = finite(item[1], 'opacity');
    if (x <= last || opacity < 0 || opacity > 1) throw new Error('Opacity coordinates must increase and opacity must be between zero and one.');
    last = x;
    return [x, opacity] as [number, number];
  });
  return { opacityPoints, unitDistance };
}
export function currentAnalysisGuard(workbench: ParaViewWorkbenchState): AnalysisGuard {
  return { id: workbench.selectedId, revision: workbench.dataRevision, time: workbench.time };
}
export function probeCsv(result: ProbeResult): string {
  const quote = (text: string) => `"${text.replace(/"/g, '""')}"`;
  return ['time,block,association,x,y,z,inside,array,component,value', ...result.values.flatMap(array => [...array.components, ...(array.components.length > 1 ? [array.magnitude] : [])].map((value, index) => [result.time, result.block, result.association, ...result.position, result.inside, quote(array.name), index === array.components.length ? 'magnitude' : index, value ?? ''].join(',')))].join('\r\n');
}
export function findDataCsv(result: FindDataResult): string {
  const name = `"${result.name.replace(/"/g, '""')}"`;
  return ['time,block,association,array,component,index,x,y,z,value', ...result.rows.map(row => [result.time, result.block, result.association, name, result.component, row.index, ...row.coordinate, row.value].join(','))].join('\r\n');
}

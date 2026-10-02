import type { ComparisonTrace } from './postprocess-comparison';
import type { ParaViewDataTable } from './pvplots';
import type { ParaViewWorkbenchState } from './paraview';

export const ANALYSIS_TRANSFER_EVENT = 'ofstudio-analysis-transfer';
export interface AnalysisTransfer {
  id: string; caseName: string; createdAt: string; traces: ComparisonTrace[]; provenance: string;
}
let pending: AnalysisTransfer | null = null;
let listening = false;

function listen() {
  if (typeof window !== 'undefined' && !listening) {
    listening = true;
    window.addEventListener('foam-version-changed', () => { pending = null; });
  }
}

export function peekAnalysisTransfer(caseName: string): AnalysisTransfer | null {
  listen();
  return pending?.caseName === caseName ? pending : null;
}

export function consumeAnalysisTransfer(id: string): void { if (pending?.id === id) pending = null; }

export function publishAnalysisTransfer(transfer: AnalysisTransfer): void {
  listen(); pending = transfer;
  window.dispatchEvent(new CustomEvent(ANALYSIS_TRANSFER_EVENT, { detail: transfer }));
}

/** Keep a captured numerical output independent of subsequent pipeline changes. */
export function createParaViewAnalysisTransfer(workbench: Pick<ParaViewWorkbenchState, 'caseName' | 'selectedId' | 'dataRevision' | 'time'>,
  data: ParaViewDataTable, label: string, id: string, createdAt: string): AnalysisTransfer {
  if (data.id !== workbench.selectedId || data.revision !== workbench.dataRevision || data.time !== workbench.time) {
    throw new Error('The pipeline changed. Refresh its data before sending it.');
  }
  if (data.selectedColumns.length < 2 || data.selectedColumns.length > 7) throw new Error('Choose an X axis and between 1 and 6 series to send.');
  if (data.rows.length > 20000 || data.offset !== 0) throw new Error('Only the bounded chart output can be sent to Post-Process.');
  const columns = data.selectedColumns.map(index => data.columns.find(column => column.index === index));
  if (columns.some(column => !column)) throw new Error('The output columns are unavailable. Refresh its data.');
  const axisColumn = columns[0]!;
  if (!data.rows.length || data.rows.some(row => typeof row[0] !== 'number' || !Number.isFinite(row[0]))) {
    throw new Error('The X axis contains invalid coordinates. Choose a valid numeric axis before sending.');
  }
  const mode = /^time$/i.test(axisColumn.name) ? 'series' : 'profile';
  const block = data.blocks.find(item => item.index === data.block)?.label || `Block ${data.block}`;
  const source = `ParaView/${label} · ${data.association.toLowerCase()} · ${block}`;
  const axis = axisColumn.label;
  const coverage = `${data.rows.length}/${data.totalRows} rows captured; ${data.limited ? 'prefix only; ' : ''}chart read cap ${data.rowLimit} rows / 4 MB; `
    + `${data.invalidRows} invalid samples; ${data.nonFiniteValues} non-finite values; `
    + `${data.blocksLimited ? 'block inventory limited; ' : ''}${data.columnsLimited ? 'column inventory limited; ' : ''}`
    + 'units and coordinate frame unknown; captured snapshot (not automatically recomputed)';
  const provenance = `${source} · time ${data.time} · pipeline revision ${data.revision} · ${coverage}`;
  const traces = columns.slice(1).map((column, index): ComparisonTrace => ({
    id: `${id}-${index}`, label: `${workbench.caseName} · ${label} · t=${data.time} · ${column!.label} (captured)`,
    caseName: workbench.caseName, source, snapshot: String(data.time), residualSelection: null,
    mode, axis, field: column!.label, loadedAt: createdAt,
    points: data.rows.map(row => ({ x: row[0]!, y: typeof row[index + 1] === 'number' && Number.isFinite(row[index + 1]) ? row[index + 1] : null })),
    totalRows: data.totalRows, coverage, sourceOmissions: 0,
  }));
  return { id, caseName: workbench.caseName, createdAt, traces, provenance };
}

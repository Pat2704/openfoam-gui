'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, Loader2, Crosshair, Filter, Activity } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ParaViewWorkbenchState } from '@/lib/paraview';
import type { ParaViewDataTable } from '@/lib/pvplots';
import { currentAnalysisGuard, analysisNumber, probeRequest, findDataRequest, diagnosticRequest, probeCsv, findDataCsv, type ProbeResult, type FindDataResult, type AnalysisAssociation } from '@/lib/paraview-analysis';

export interface ParaViewAnalysisPanelProps {
  workbench: ParaViewWorkbenchState;
  locked: boolean;
  active: boolean;
  onCommand: (name: string, data?: Record<string, unknown>, options?: { render?: boolean; quiet?: boolean }) => Promise<ParaViewWorkbenchState | null>;
}
async function analysisRead(command: string, data: unknown, signal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = window.setTimeout(abort, 180_000);
  try {
    const response = await fetch('/api/paraview', { signal: controller.signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'command', command, data }) });
    const result = await response.json() as { table?: ParaViewDataTable; probe?: ProbeResult; selection?: FindDataResult; error?: string };
    if (!response.ok) throw new Error(result.error || 'ParaView analysis failed.');
    return result;
  } catch (cause) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error('The ParaView analysis request timed out. Try a smaller input.');
    throw cause;
  } finally { window.clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
function downloadCsv(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ParaViewAnalysisPanel({ workbench, locked, active, onCommand }: ParaViewAnalysisPanelProps) {
  const [schema, setSchema] = useState<ParaViewDataTable | null>(null);
  const [association, setAssociation] = useState<AnalysisAssociation>('CELLS');
  const [position, setPosition] = useState(['0', '0', '0']);
  const [field, setField] = useState('');
  const [component, setComponent] = useState(0);
  const [lower, setLower] = useState('0');
  const [upper, setUpper] = useState('1');
  const [vector, setVector] = useState('');
  const [vectorAssociation, setVectorAssociation] = useState<AnalysisAssociation>('CELLS');
  const [prefix, setPrefix] = useState('Velocity');
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [found, setFound] = useState<FindDataResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ticketRef = useRef(0);
  const dataKeyRef = useRef('');
  const schemaRef = useRef<ParaViewDataTable | null>(null);
  const controllersRef = useRef(new Set<AbortController>());
  const selected = workbench.pipeline.find(node => node.id === workbench.selectedId);
  const guard = currentAnalysisGuard(workbench);
  const columns = schema?.columns.filter(column => column.kind === 'array' && column.name !== 'vtkValidPointMask') ?? [];
  const names = [...new Set(columns.map(column => column.name))];
  const components = columns.filter(column => column.name === field);
  const vectors = workbench.arrays.filter(array => array.components === 3 && array.association === vectorAssociation);
  const disabled = locked || busy;

  useEffect(() => {
    const key = `${workbench.selectedId}:${workbench.dataRevision}:${workbench.time}`;
    if (dataKeyRef.current !== key) {
      dataKeyRef.current = key; ticketRef.current++;
      for (const controller of controllersRef.current) controller.abort();
      schemaRef.current = null; setSchema(null); setProbe(null); setFound(null); setError('');
    }
    if (!active) {
      ticketRef.current++;
      for (const controller of controllersRef.current) controller.abort();
      return;
    }
    if (locked || schemaRef.current || selected?.renderable === false) return;
    const ticket = ticketRef.current;
    const controller = new AbortController(); controllersRef.current.add(controller);
    void analysisRead('data_table', { ...currentAnalysisGuard(workbench), mode: 'schema' }, controller.signal).then(result => {
      if (ticketRef.current !== ticket || !result.table) return;
      const table = result.table; schemaRef.current = table; setSchema(table);
      setAssociation(table.association === 'POINTS' ? 'POINTS' : 'CELLS');
      const column = table.columns.find(item => item.kind === 'array' && item.name !== 'vtkValidPointMask');
      setField(column?.name ?? ''); setComponent(column?.component ?? 0);
    }).catch(cause => { if (ticketRef.current === ticket && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => controllersRef.current.delete(controller));
    return () => { controller.abort(); controllersRef.current.delete(controller); };
    // Only data identity invalidates captured results, not unrelated UI state.
  }, [active, locked, workbench.selectedId, workbench.dataRevision, workbench.time]);

  useEffect(() => () => { for (const controller of controllersRef.current) controller.abort(); }, []);

  const run = async (job: (ticket: number, signal: AbortSignal) => Promise<void>) => {
    if (disabled) return;
    const ticket = ticketRef.current; setBusy(true); setError('');
    const controller = new AbortController(); controllersRef.current.add(controller);
    try { await job(ticket, controller.signal); }
    catch (cause) { if (ticket === ticketRef.current) { const message = cause instanceof Error ? cause.message : 'Analysis failed.'; setError(message); toast.error(message); } }
    finally { controllersRef.current.delete(controller); setBusy(false); }
  };
  const readSchema = (block: number, nextAssociation: AnalysisAssociation) => void run(async (ticket, signal) => {
    const result = await analysisRead('data_table', { ...guard, mode: 'schema', block, association: nextAssociation }, signal);
    if (ticket !== ticketRef.current || !result.table) return;
    schemaRef.current = result.table; setSchema(result.table); setAssociation(nextAssociation); setProbe(null); setFound(null);
    const column = result.table.columns.find(item => item.kind === 'array' && item.name !== 'vtkValidPointMask');
    setField(column?.name ?? ''); setComponent(column?.component ?? 0);
  });
  const selection = () => findDataRequest({ ...guard, block: schema?.block ?? 0, association, name: field, component, lower: analysisNumber(lower, 'lower threshold'), upper: analysisNumber(upper, 'upper threshold') });

  return <div className="space-y-4 p-3 text-xs">
    <p className="text-muted-foreground">Analyze {selected?.label ?? 'the selected output'} at t={workbench.time}. Results retain the block, association and original tuple IDs. Units follow the source data.</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {busy && <Loader2 className="h-4 w-4 animate-spin" />}
    {schema && <div className="grid grid-cols-2 gap-2"><Select value={String(schema.block)} disabled={disabled} onValueChange={value => readSchema(Number(value), association)}><SelectTrigger className="h-8 text-xs" aria-label="Analysis block"><SelectValue /></SelectTrigger><SelectContent>{schema.blocks.map(block => <SelectItem key={block.index} value={String(block.index)}>{block.label}</SelectItem>)}</SelectContent></Select><Select value={association} disabled={disabled} onValueChange={value => readSchema(schema.block, value as AnalysisAssociation)}><SelectTrigger className="h-8 text-xs" aria-label="Analysis association"><SelectValue /></SelectTrigger><SelectContent>{schema.associations.filter(item => item !== 'ROWS').map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select></div>}
    <section className="space-y-2 border-t pt-3"><p className="flex items-center gap-1 font-semibold"><Crosshair className="h-4 w-4 text-cyan-500" /> Probe location</p><div className="grid grid-cols-3 gap-1">{position.map((value, index) => <Input key={index} aria-label={`Probe ${'XYZ'[index]}`} className="h-8 text-xs" type="number" step="any" value={value} disabled={disabled} onChange={event => { setPosition(values => values.map((old, i) => i === index ? event.target.value : old)); setProbe(null); }} />)}</div><Button size="sm" variant="outline" disabled={disabled || !schema} onClick={() => void run(async (ticket, signal) => {
      const request = probeRequest({ ...guard, block: schema!.block, association, position: position.map((value, index) => analysisNumber(value, `probe ${'XYZ'[index]}`)) });
      const result = await analysisRead('analysis_probe', request, signal); if (ticket === ticketRef.current) setProbe(result.probe ?? null);
    })}>Probe XYZ</Button>{probe && <div className="space-y-2 rounded border p-2"><p className={probe.inside ? 'text-emerald-600' : 'text-amber-600'}>{probe.inside ? 'Inside the selected block' : 'Outside the selected block: no values'}</p><p className="text-muted-foreground">{probe.note}{probe.limited ? ' Showing up to 16 arrays with 16 components each.' : ''}</p>{probe.values.map(array => <div key={array.name} className="flex justify-between gap-2"><span className="truncate font-mono">{array.name}</span><span className="text-right font-mono">{array.components.map(value => value === null ? '—' : value.toPrecision(6)).join(', ')}</span></div>)}<Button size="sm" variant="ghost" onClick={() => downloadCsv(probeCsv(probe), `${workbench.caseName}-probe.csv`)}><Download className="h-3 w-3" /> CSV</Button></div>}</section>
    <section className="space-y-2 border-t pt-3"><p className="flex items-center gap-1 font-semibold"><Filter className="h-4 w-4 text-amber-500" /> Find Data</p><Select value={field || undefined} disabled={disabled || !names.length} onValueChange={value => { setField(value); setComponent(columns.find(column => column.name === value)?.component ?? 0); setFound(null); }}><SelectTrigger className="h-8 text-xs" aria-label="Selection field"><SelectValue placeholder="Numeric array" /></SelectTrigger><SelectContent>{names.map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent></Select><Select value={String(component)} disabled={disabled || !components.length} onValueChange={value => { setComponent(Number(value)); setFound(null); }}><SelectTrigger className="h-8 text-xs" aria-label="Selection component"><SelectValue /></SelectTrigger><SelectContent>{components.map(column => <SelectItem key={column.index} value={String(column.component)}>{column.component === -1 ? 'Magnitude' : `Component ${column.component}`}</SelectItem>)}</SelectContent></Select><div className="grid grid-cols-2 gap-2"><Input aria-label="Lower selection bound" className="h-8" type="number" step="any" value={lower} disabled={disabled} onChange={event => { setLower(event.target.value); setFound(null); }} /><Input aria-label="Upper selection bound" className="h-8" type="number" step="any" value={upper} disabled={disabled} onChange={event => { setUpper(event.target.value); setFound(null); }} /></div><div className="flex gap-2"><Button size="sm" variant="outline" disabled={disabled || !field || !schema} onClick={() => void run(async (ticket, signal) => { const result = await analysisRead('find_data', selection(), signal); if (ticket === ticketRef.current) setFound(result.selection ?? null); })}>Find in range</Button><Button size="sm" disabled={disabled || !found || found.scanLimited || found.matched > 20000 || found.matched === 0} onClick={() => void run(async () => { await onCommand('selection_extract', { ...selection() }); })}>Extract</Button></div>{found && <div className="space-y-2"><p className="text-muted-foreground">{found.matched.toLocaleString()} matches in {found.scanned.toLocaleString()}/{found.total.toLocaleString()} scanned tuples; {found.rows.length} shown. {found.scanLimited && 'Scan limited to 200,000 tuples.'} Extraction re-evaluates this range at each timestep, capped at 20,000 matches.</p><div className="max-h-44 overflow-auto rounded border"><table className="w-full text-[10px]"><thead><tr><th>ID</th><th>XYZ {association === 'CELLS' ? 'parametric center' : 'point'}</th><th>Value</th></tr></thead><tbody>{found.rows.map(row => <tr key={row.index}><td>{row.index}</td><td className="font-mono">{row.coordinate.map(value => value === null ? '—' : value.toPrecision(3)).join(', ')}</td><td className="font-mono">{row.value.toPrecision(6)}</td></tr>)}</tbody></table></div><Button size="sm" variant="ghost" onClick={() => downloadCsv(findDataCsv(found), `${workbench.caseName}-selection.csv`)}><Download className="h-3 w-3" /> CSV shown rows</Button></div>}</section>
    <section className="space-y-2 border-t pt-3"><p className="flex items-center gap-1 font-semibold"><Activity className="h-4 w-4 text-violet-500" /> CFD diagnostics</p><p className="text-muted-foreground">Gradient tensor, curl/vorticity, divergence and Q criterion of a three-component vector. Cell and point derivatives retain their source association; no density or physical units are inferred.</p><Select value={vectorAssociation} disabled={disabled} onValueChange={value => { setVectorAssociation(value as AnalysisAssociation); setVector(''); }}><SelectTrigger className="h-8" aria-label="Vector association"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="CELLS">CELLS</SelectItem><SelectItem value="POINTS">POINTS</SelectItem></SelectContent></Select><Select value={vector || undefined} disabled={disabled || !vectors.length} onValueChange={setVector}><SelectTrigger className="h-8" aria-label="Diagnostic vector"><SelectValue placeholder="Three-component vector" /></SelectTrigger><SelectContent>{vectors.map(array => <SelectItem key={array.name} value={array.name}>{array.name}</SelectItem>)}</SelectContent></Select><Input aria-label="Diagnostic output prefix" className="h-8" maxLength={40} value={prefix} disabled={disabled} onChange={event => setPrefix(event.target.value)} /><Button size="sm" variant="outline" disabled={disabled || !vector || !workbench.analysisCapabilities?.cfd} onClick={() => void run(async () => { await onCommand('cfd_diagnostic', { ...diagnosticRequest({ ...guard, diagnostic: { association: vectorAssociation, name: vector, prefix } }) }); })}>Create diagnostic fields</Button></section>
    <section className="space-y-2 border-t pt-3"><p className="font-semibold">Spatial integrals</p><p className="text-muted-foreground">Integrate Variables sums fields over the selected geometry, weighted by cell measure. Surface and volume integrals depend on the input dimension. A surface flux requires explicit normals and a flux field; these scalar/vector integrals are not automatically mass flow.</p><Button size="sm" variant="outline" disabled={disabled || selected?.renderable === false || !workbench.availableFilters.includes('IntegrateVariables')} onClick={() => void onCommand('add_filter', { filter: 'IntegrateVariables' })}>Integrate selected output</Button><p className="text-muted-foreground">Inspect or export the integral arrays in Table after creating the filter.</p></section>
  </div>;
}

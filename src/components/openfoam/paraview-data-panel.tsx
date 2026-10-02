'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Download, Image as ImageIcon, Loader2, RefreshCw, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ParaViewWorkbenchState } from '@/lib/paraview';
import { defaultParaViewColumns, isolatedParaViewSample, paraViewChartRows, paraViewTableCsv } from '@/lib/pvplots';
import type { ParaViewDataAssociation, ParaViewDataRequest, ParaViewDataTable } from '@/lib/pvplots';
import ChartExportDialog from './chart-export';
import type { ChartExportSource } from './chart-export';
import { createParaViewAnalysisTransfer, publishAnalysisTransfer } from '@/lib/analysis-transfer';

const COLORS = ['#38bdf8', '#f472b6', '#facc15', '#4ade80', '#a78bfa', '#fb923c', '#2dd4bf', '#f87171'];

async function readData(request: ParaViewDataRequest, signal: AbortSignal): Promise<ParaViewDataTable> {
  const response = await fetch('/api/paraview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ action: 'command', command: 'data_table', data: request }),
  });
  const result = await response.json() as { table?: ParaViewDataTable; error?: string };
  if (!response.ok || !result.table) throw new Error(result.error || 'ParaView could not read this output.');
  if (result.table.id !== request.id || result.table.revision !== request.revision || result.table.time !== request.time) {
    throw new Error('The pipeline changed while reading its output. Refresh the data.');
  }
  return result.table;
}

export default function ParaViewDataPanel({ workbench, mode, locked, active }: {
  workbench: ParaViewWorkbenchState; mode: 'chart' | 'table'; locked: boolean; active: boolean;
}) {
  const id = workbench.selectedId;
  const context = `${id}:${workbench.dataRevision}:${workbench.time}`;
  const selected = workbench.pipeline.find(node => node.id === id);
  const [location, setLocation] = useState<{ id: string; block?: number; association?: ParaViewDataAssociation }>({ id });
  const currentLocation = location.id === id ? location : { id };
  const [schema, setSchema] = useState<{ key: string; data: ParaViewDataTable } | null>(null);
  const [result, setResult] = useState<{ key: string; data: ParaViewDataTable } | null>(null);
  const [choices, setChoices] = useState<{ identity: string; signature: string; x: number; series: number[]; table: number[] } | null>(null);
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveChart, setSaveChart] = useState(false);
  const generation = useRef(0);
  const exportController = useRef<AbortController | null>(null);
  const schemaKey = `${context}:${currentLocation.block ?? 'default'}:${currentLocation.association ?? 'default'}:${retry}`;
  const metadata = schema?.key === schemaKey ? schema.data : null;
  const identity = metadata ? `${id}:${metadata.block}:${metadata.association}` : '';
  const currentChoices = choices?.identity === identity ? choices : null;
  const columns = useMemo(() => currentChoices
    ? mode === 'chart' ? [currentChoices.x, ...currentChoices.series.filter(index => index !== currentChoices.x)] : currentChoices.table
    : [], [currentChoices, mode]);
  const dataKey = `${schemaKey}:${mode}:${columns.join(',')}:${mode === 'table' ? offset : 0}`;
  const data = result?.key === dataKey && !locked && active ? result.data : null;

  useEffect(() => {
    const controller = new AbortController();
    const token = ++generation.current;
    exportController.current?.abort();
    setSaving(false); setSaveChart(false); setError(''); setSchema(null); setResult(null); setOffset(0);
    if (locked || !active) { setLoading(false); return; }
    setLoading(true);
    const timer = window.setTimeout(() => controller.abort(), 180_000);
    void readData({ mode: 'schema', id, revision: workbench.dataRevision, time: workbench.time,
      block: currentLocation.block, association: currentLocation.association }, controller.signal).then(next => {
      if (controller.signal.aborted || token !== generation.current) return;
      const nextIdentity = `${id}:${next.block}:${next.association}`;
      const signature = JSON.stringify(next.columns.map(column => [column.name, column.kind, column.component]));
      const defaults = defaultParaViewColumns(next.columns);
      setChoices(previous => previous?.identity === nextIdentity && previous.signature === signature &&
        [previous.x, ...previous.series, ...previous.table].every(index => next.columns.some(column => column.index === index))
        ? previous : { identity: nextIdentity, signature, ...defaults, table: next.columns.slice(0, 12).map(column => column.index) });
      setSchema({ key: schemaKey, data: next });
    }).catch(cause => {
      if (token === generation.current && !controller.signal.aborted) setError(String(cause.message || cause));
      else if (token === generation.current && active && !locked) setError('ParaView did not answer within 180 seconds.');
    }).finally(() => { window.clearTimeout(timer); if (token === generation.current) setLoading(false); });
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [schemaKey, id, workbench.dataRevision, workbench.time, currentLocation.block, currentLocation.association, locked, active]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let timedOut = false;
    setResult(null);
    if (!metadata || locked || !active || columns.length === 0) return;
    setLoading(true); setError('');
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 180_000);
    void readData({ mode: mode === 'chart' ? 'chart' : 'page', id, revision: workbench.dataRevision,
      time: workbench.time, block: metadata.block, association: metadata.association, columns,
      offset: mode === 'table' ? offset : 0 }, controller.signal).then(next => {
      if (!controller.signal.aborted) setResult({ key: dataKey, data: next });
    }).catch(cause => { if (!disposed) setError(timedOut ? 'ParaView did not answer within 180 seconds.' : String(cause.message || cause)); })
      .finally(() => { window.clearTimeout(timer); if (!disposed) setLoading(false); });
    return () => { disposed = true; controller.abort(); window.clearTimeout(timer); };
  }, [metadata, dataKey, id, workbench.dataRevision, workbench.time, mode, columns, offset, locked, active]);

  useEffect(() => () => { generation.current++; exportController.current?.abort(); }, []);
  const sampled = useMemo(() => paraViewChartRows(data?.rows || []), [data]);
  const labels = data?.selectedColumns.map(index => data.columns.find(column => column.index === index)?.label || '') || [];
  const chartRows = useMemo(() => sampled.rows.map(row => Object.fromEntries(row.map((value, index) => [`c${index}`, value]))), [sampled]);
  const source: ChartExportSource | null = data && columns.length > 1 && sampled.omittedFeatures === 0 ? {
    columns: labels, rows: sampled.rows,
    series: labels.slice(1).map((name, index) => ({ index: index + 1, name, color: COLORS[index % COLORS.length] })),
    xLabel: labels[0], yLabel: 'Value', logScale: false,
    fileName: `${workbench.caseName}-${selected?.label || 'output'}-${workbench.time}`,
    title: `${selected?.label || 'Output'} · ${data.association.toLowerCase()} · time ${workbench.time}`,
  } : null;

  async function exportCsv() {
    if (!metadata || !columns.length) return;
    const controller = new AbortController();
    exportController.current?.abort(); exportController.current = controller;
    const token = generation.current;
    let timedOut = false;
    setSaving(true);
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 180_000);
    try {
      const next = await readData({ mode: 'export', id, revision: workbench.dataRevision, time: workbench.time,
        block: metadata.block, association: metadata.association, columns, offset: 0 }, controller.signal);
      if (controller.signal.aborted || token !== generation.current) return;
      const url = URL.createObjectURL(new Blob([paraViewTableCsv(next)], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url;
      anchor.download = `${workbench.caseName}-${selected?.label || 'output'}-${workbench.time}.csv`.replace(/[<>:"/\\|?*]/g, '-');
      anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success(`Saved ${next.rows.length.toLocaleString()} of ${next.totalRows.toLocaleString()} rows${next.limited ? ' (bounded export)' : ''}.`);
    } catch (cause) { if (token === generation.current && (timedOut || !controller.signal.aborted)) toast.error(timedOut ? 'ParaView did not answer within 180 seconds.' : cause instanceof Error ? cause.message : String(cause)); }
    finally { window.clearTimeout(timer); if (token === generation.current) setSaving(false); }
  }

  function toggleColumn(index: number) {
    setChoices(previous => {
      if (!previous) return previous;
      const key = mode === 'chart' ? 'series' : 'table';
      const values = previous[key];
      return { ...previous, [key]: values.includes(index) ? values.filter(value => value !== index)
        : values.length < (mode === 'chart' ? 15 : 16) ? [...values, index] : values };
    });
    setOffset(0);
  }

  function sendToPostProcess() {
    if (!data || locked || loading) return;
    try {
      publishAnalysisTransfer(createParaViewAnalysisTransfer(workbench, data, selected?.label || 'Output', crypto.randomUUID(), new Date().toISOString()));
      toast.success('Captured curves sent to Post-Process.');
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <div className="absolute inset-0 top-9 flex min-h-0 flex-col bg-background text-foreground">
    <div className="flex flex-wrap items-center gap-2 border-b p-2 text-xs">
      <span className="min-w-0 flex-1 truncate font-semibold">{selected?.label} · time {workbench.time}</span>
      <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={locked || loading || saving} onClick={() => setRetry(value => value + 1)}><RefreshCw className="h-3 w-3" /> Refresh data</Button>
      <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={!data || saving} onClick={() => void exportCsv()}>{saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />} CSV</Button>
      {mode === 'chart' && <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={!source || !data?.rows.length} onClick={() => setSaveChart(true)}><ImageIcon className="h-3 w-3" /> Save chart</Button>}
      {mode === 'chart' && <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={!data?.rows.length || locked || loading || columns.length < 2 || columns.length > 7} title="Send a captured snapshot of up to six series, with coverage and provenance" onClick={sendToPostProcess}><Send className="h-3 w-3" /> Send to Post-Process</Button>}
    </div>
    {metadata && currentChoices && <div className="space-y-2 border-b p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(metadata.block)} onValueChange={value => setLocation({ id, block: Number(value) })}><SelectTrigger aria-label="Data block" size="sm" className="min-w-28 max-w-60 flex-1 text-xs"><SelectValue /></SelectTrigger><SelectContent>{metadata.blocks.map(block => <SelectItem key={block.index} value={String(block.index)}>{block.label}</SelectItem>)}</SelectContent></Select>
        <Select value={metadata.association} onValueChange={value => setLocation({ id, block: metadata.block, association: value as ParaViewDataAssociation })}><SelectTrigger aria-label="Data association" size="sm" className="w-28 text-xs"><SelectValue /></SelectTrigger><SelectContent>{metadata.associations.map(association => <SelectItem key={association} value={association}>{association === 'ROWS' ? 'Rows' : association === 'POINTS' ? 'Points' : 'Cells'}</SelectItem>)}</SelectContent></Select>
        {mode === 'chart' && <><Label className="text-[10px]">X axis</Label><Select value={String(currentChoices.x)} onValueChange={value => setChoices(previous => previous && ({ ...previous, x: Number(value) }))}><SelectTrigger aria-label="Chart X axis" size="sm" className="min-w-28 max-w-52 flex-1 text-xs"><SelectValue /></SelectTrigger><SelectContent>{metadata.columns.map(column => <SelectItem key={column.index} value={String(column.index)}>{column.label}</SelectItem>)}</SelectContent></Select></>}
      </div>
      <details><summary className="cursor-pointer text-[10px] text-muted-foreground">{mode === 'chart' ? `Series (${columns.length - 1}/15)` : `Columns (${columns.length}/16)`} · choose arrays and components</summary><div className="mt-2 flex max-h-32 flex-wrap gap-x-3 gap-y-2 overflow-auto">{metadata.columns.filter(column => mode === 'table' || column.index !== currentChoices.x).map(column => <Label key={column.index} className="flex items-center gap-1 text-[10px]"><Checkbox checked={(mode === 'chart' ? currentChoices.series : currentChoices.table).includes(column.index)} onCheckedChange={() => toggleColumn(column.index)} />{column.label}</Label>)}</div></details>
      {(metadata.columnsLimited || metadata.blocksLimited || metadata.nonNumericColumns > 0) && <p className="text-[10px] text-amber-600 dark:text-amber-400">{metadata.nonNumericColumns > 0 && `${metadata.nonNumericColumns} non-numeric arrays excluded. `}{metadata.columnsLimited && 'Metadata is limited to 128 columns and 16 components per array. '}{metadata.blocksLimited && 'Only the first 256 leaf blocks are available.'}</p>}
    </div>}
    {data && <div className="border-b px-2 py-1 text-[10px] text-muted-foreground">{mode === 'table' ? `Rows ${data.rows.length ? data.offset + 1 : 0}–${data.offset + data.rows.length}` : `${sampled.rows.length.toLocaleString()} plotted / ${data.rows.length.toLocaleString()} read`} / {data.totalRows.toLocaleString()} total · {data.association.toLowerCase()} · {data.blocks.find(block => block.index === data.block)?.label}{data.limited && mode === 'chart' ? ` · prefix only (up to ${data.rowLimit.toLocaleString()} rows / 4 MB)` : ''}{sampled.omittedFeatures > 0 && mode === 'chart' ? ` · ${sampled.omittedFeatures} extrema/gap boundaries omitted` : ''}{data.invalidRows > 0 ? ` · ${data.invalidRows} invalid samples shown as gaps` : ''}{data.nonFiniteValues > 0 ? ` · ${data.nonFiniteValues} non-finite values shown as gaps` : ''}</div>}
    <div className="relative min-h-0 flex-1 overflow-auto">
      {error ? <div className="p-4 text-xs text-destructive">{error}</div> : locked ? <p className="p-4 text-xs text-muted-foreground">Waiting for the pipeline update…</p> : loading ? <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Reading selected output…</div> : !data || !data.rows.length ? <p className="p-4 text-xs text-muted-foreground">{columns.length === 0 ? 'Choose at least one numeric column.' : 'This output has no rows at the current time and association.'}</p> : mode === 'table' ? <table className="w-full whitespace-nowrap text-right font-mono text-[10px]"><thead className="sticky top-0 bg-muted"><tr>{labels.map((label, index) => <th key={index} className="border-b px-3 py-2 font-semibold">{label}</th>)}</tr></thead><tbody>{data.rows.map((row, index) => <tr key={data.offset + index} className="even:bg-muted/30">{row.map((value, column) => <td key={column} className="border-b border-border/40 px-3 py-1.5">{value === null ? <span className="text-muted-foreground" title="Invalid or non-finite value">—</span> : Number.isInteger(value) ? value : value.toPrecision(7)}</td>)}</tr>)}</tbody></table> : columns.length < 2 ? <p className="p-4 text-xs text-muted-foreground">Choose one or more series to plot against {labels[0]}.</p> : sampled.omittedFeatures > 0 ? <p className="p-4 text-xs text-amber-600 dark:text-amber-400">This output has more extrema or gap boundaries than the chart budget can preserve. Use Table or CSV to inspect it; increase spatial sampling selectively.</p> : <ResponsiveContainer width="100%" height="100%" minHeight={230}><LineChart data={chartRows} margin={{ top: 20, right: 20, bottom: 30, left: 12 }}><CartesianGrid strokeDasharray="3 3" opacity={0.25} /><XAxis dataKey="c0" type="number" domain={['dataMin', 'dataMax']} tick={{ fontSize: 10 }} label={{ value: labels[0], position: 'insideBottom', offset: -18, fontSize: 11 }} /><YAxis type="number" domain={['auto', 'auto']} tick={{ fontSize: 10 }} width={65} /><Tooltip /><Legend wrapperStyle={{ fontSize: 10 }} />{labels.slice(1).map((label, index) => <Line key={index} type="linear" dataKey={`c${index + 1}`} name={label} stroke={COLORS[index % COLORS.length]} dot={sampled.rows.some((_, row) => isolatedParaViewSample(sampled.rows, row, index + 1)) ? props => <circle key={props.index} cx={props.cx} cy={props.cy} r={isolatedParaViewSample(sampled.rows, props.index ?? -1, index + 1) ? 3 : 0} fill={COLORS[index % COLORS.length]} /> : false} isAnimationActive={false} connectNulls={false} />)}</LineChart></ResponsiveContainer>}
    </div>
    {mode === 'table' && data && <div className="flex items-center justify-between border-t p-2 text-[10px] text-muted-foreground"><Button size="sm" variant="outline" className="h-7 text-[10px]" disabled={offset === 0 || loading} onClick={() => setOffset(value => Math.max(0, value - 200))}>Previous</Button><span>200 rows per page · CSV: up to 200,000 rows, 1,000,000 values / 4 MB</span><Button size="sm" variant="outline" className="h-7 text-[10px]" disabled={offset + data.rows.length >= data.totalRows || !data.rows.length || loading} onClick={() => setOffset(value => value + data.rows.length)}>Next</Button></div>}
    {mode === 'chart' && <p className="border-t px-2 py-1 text-[10px] text-muted-foreground">Current-time output; one block at a time. Chart: up to 20,000 rows, sampled to 4,000. CSV: up to 200,000 rows, 1,000,000 values / 4 MB.</p>}
    {source && <ChartExportDialog open={saveChart} onOpenChange={setSaveChart} source={source} />}
  </div>;
}

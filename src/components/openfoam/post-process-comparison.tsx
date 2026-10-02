'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Download, FileText, Image as ImageIcon, Loader2, Plus, Save, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import ChartExportDialog, { type ChartExportSource } from './chart-export';
import {
  COMPARISON_TRACE_LIMIT, COMPARISON_READ_LIMIT, COMPARISON_CHART_LIMIT,
  comparisonAxisError, comparisonSource, createComparisonTrace, sampleComparisonTrace, serializeComparisonCsv,
  type ComparisonReader, type ComparisonSelection, type ComparisonTable, type ComparisonTrace,
} from '@/lib/postprocess-comparison';
import type { ResidualSelection } from '@/lib/residuals';
import { listAnalysisDocuments, saveAnalysisDocument, deleteAnalysisDocument, type AnalysisDocument } from '@/lib/analysis-documents';
import { ANALYSIS_TRANSFER_EVENT, peekAnalysisTransfer, consumeAnalysisTransfer, type AnalysisTransfer } from '@/lib/analysis-transfer';
import {
  buildPostProcessAnalysisReport, parsePostProcessAnalysis, replayPostProcessAnalysis, validateCapturedAnalysisTrace,
  type AnalysisDisplayCurve,
} from '@/lib/postprocess-analysis';

const COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#06b6d4'];
interface SourceOption { key: string; selection: ComparisonSelection }
type DisplayTrace = AnalysisDisplayCurve;

async function readJson(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

export default function PostProcessComparison({ open, onOpenChange, caseName, initialSelection, initialTime, initialResidualSelection, readData }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caseName: string;
  initialSelection: ComparisonSelection | null;
  initialTime?: string;
  initialResidualSelection: ResidualSelection;
  readData: ComparisonReader;
}) {
  const [chosenCase, setChosenCase] = useState(caseName);
  const [cases, setCases] = useState<string[]>([caseName]);
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [sourceKey, setSourceKey] = useState('');
  const [time, setTime] = useState(initialTime ?? '');
  const [field, setField] = useState('1');
  const [residual, setResidual] = useState<ResidualSelection>(initialResidualSelection);
  const [candidate, setCandidate] = useState<ComparisonTable | null>(null);
  const [traces, setTraces] = useState<DisplayTrace[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [adding, setAdding] = useState(false);
  const [inventoryTruncated, setInventoryTruncated] = useState(false);
  const [error, setError] = useState('');
  const [logScale, setLogScale] = useState(false);
  const [tableView, setTableView] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [installationRevision, setInstallationRevision] = useState(0);
  const [documents, setDocuments] = useState<AnalysisDocument[]>([]);
  const [documentId, setDocumentId] = useState('');
  const [analysisName, setAnalysisName] = useState('Curve analysis');
  const [documentBusy, setDocumentBusy] = useState(false);
  const [documentStatus, setDocumentStatus] = useState('');
  const [pendingTransfer, setPendingTransfer] = useState<AnalysisTransfer | null>(null);
  const documentVersion = useRef(0);
  const lastTransfer = useRef('');
  const requestVersion = useRef(0);
  const addVersion = useRef(0);
  const nextId = useRef(0);
  const initial = useRef({ selection: initialSelection, time: initialTime, residual: initialResidualSelection });
  const wasOpen = useRef(false);
  const selection = sources.find(source => source.key === sourceKey)?.selection;
  const busy = adding || documentBusy;

  useEffect(() => {
    if (open && !wasOpen.current) {
      initial.current = { selection: initialSelection, time: initialTime, residual: initialResidualSelection };
      setChosenCase(caseName);
      setSources([]);
      setSourceKey('');
      setTime(initialTime ?? '');
      setResidual(initialResidualSelection);
      setField('1');
      setCandidate(null);
    }
    wasOpen.current = open;
  }, [open, caseName, initialSelection, initialTime, initialResidualSelection]);

  useEffect(() => {
    const reset = () => {
      requestVersion.current += 1;
      addVersion.current += 1;
      setTraces([]);
      setCandidate(null);
      setLoadingData(false);
      setSources([]);
      setSourceKey('');
      setTime('');
      setAdding(false);
      setExportOpen(false);
      documentVersion.current += 1;
      setDocuments([]);
      setDocumentId('');
      setDocumentBusy(false);
      setDocumentStatus('');
      setPendingTransfer(null);
      lastTransfer.current = '';
      setInstallationRevision(value => value + 1);
    };
    window.addEventListener('foam-version-changed', reset);
    return () => window.removeEventListener('foam-version-changed', reset);
  }, []);

  useEffect(() => {
    if (!open) return;
    const version = ++documentVersion.current;
    setDocumentBusy(true);
    listAnalysisDocuments('postprocess', caseName).then(items => {
      if (version !== documentVersion.current) return;
      setDocuments(items);
      setDocumentId(current => items.some(item => item.id === current) ? current : '');
    }).catch(reason => {
      if (version === documentVersion.current) setDocumentStatus(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (version === documentVersion.current) setDocumentBusy(false); });
    return () => { documentVersion.current += 1; };
  }, [open, caseName, installationRevision]);

  useEffect(() => {
    const receive = (event?: Event) => {
      const transfer = event ? (event as CustomEvent<AnalysisTransfer>).detail : peekAnalysisTransfer(caseName);
      if (transfer?.caseName === caseName && transfer.id !== lastTransfer.current) setPendingTransfer(transfer);
    };
    receive();
    window.addEventListener(ANALYSIS_TRANSFER_EVENT, receive);
    return () => window.removeEventListener(ANALYSIS_TRANSFER_EVENT, receive);
  }, [caseName]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoadingSources(true);
    setError('');
    setCandidate(null);
    Promise.all([
      readJson('/api/cases?action=list', controller.signal),
      readJson(`/api/postprocess?action=list&case=${encodeURIComponent(chosenCase)}`, controller.signal),
      readJson(`/api/cases/${encodeURIComponent(chosenCase)}?action=listLogs`, controller.signal),
    ]).then(([caseList, inventory, logs]) => {
      if (controller.signal.aborted) return;
      setCases(caseList.cases ?? [caseName]);
      const options: SourceOption[] = [];
      for (const dataset of inventory.datasets ?? []) {
        for (const file of dataset.files ?? []) {
          const selection: ComparisonSelection = { kind: 'dataset', dataset: dataset.name, file: file.name };
          options.push({ key: JSON.stringify(selection), selection });
        }
      }
      for (const log of logs.availableLogs ?? []) {
        const selection: ComparisonSelection = { kind: 'log', log };
        options.push({ key: JSON.stringify(selection), selection });
      }
      setSources(options);
      setInventoryTruncated(inventory.inventoryTruncated === true);
      const seed = chosenCase === caseName ? JSON.stringify(initial.current.selection) : '';
      setSourceKey(current => options.some(option => option.key === current) ? current : options.find(option => option.key === seed)?.key ?? options[0]?.key ?? '');
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (!controller.signal.aborted) setLoadingSources(false); });
    return () => controller.abort();
  }, [open, chosenCase, caseName, installationRevision]);

  useEffect(() => {
    const version = ++requestVersion.current;
    if (!open || !selection || loadingSources) { setLoadingData(false); return; }
    setLoadingData(true);
    setCandidate(null);
    setError('');
    readData(chosenCase, selection, time || undefined, 4000, residual).then(table => {
      if (version !== requestVersion.current) return;
      if (table.mode === 'profile' && time && table.shownTime !== time) throw new Error('The requested profile snapshot is no longer available.');
      setCandidate(table);
      setField(current => Number(current) < table.columns.length ? current : '1');
    }).catch(reason => {
      if (version === requestVersion.current) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (version === requestVersion.current) setLoadingData(false); });
    return () => { requestVersion.current += 1; };
  }, [open, chosenCase, selection, time, residual, readData, loadingSources]);

  useEffect(() => {
    if (!open) { addVersion.current += 1; setAdding(false); setExportOpen(false); }
  }, [open]);

  const candidateAxisError = candidate && traces.length
    ? comparisonAxisError(traces[0].trace, { mode: candidate.mode, axis: candidate.columns[0] }) : null;

  async function addTrace() {
    if (!selection || !candidate || busy) return;
    const version = ++addVersion.current;
    setAdding(true);
    setError('');
    try {
      const snapshot = candidate.mode === 'profile' ? candidate.shownTime ?? undefined : undefined;
      const table = await readData(chosenCase, selection, snapshot, COMPARISON_READ_LIMIT, residual);
      if (version !== addVersion.current) return;
      if (snapshot && table.shownTime !== snapshot) throw new Error('The requested profile snapshot is no longer available.');
      if (table.columns[Number(field)] !== candidate.columns[Number(field)] || table.mode !== candidate.mode || table.columns[0] !== candidate.columns[0]) {
        throw new Error('The source schema changed while loading. Select it again before adding a curve.');
      }
      const trace = createComparisonTrace({
        id: String(++nextId.current), caseName: chosenCase, selection, table, fieldIndex: Number(field),
        residualSelection: residual, loadedAt: new Date().toISOString(),
      });
      if (!trace.points.some(point => point.y !== null)) throw new Error('This series has no finite values.');
      if (traces.length >= COMPARISON_TRACE_LIMIT) throw new Error(`A comparison supports up to ${COMPARISON_TRACE_LIMIT} curves.`);
      const axisError = traces.length ? comparisonAxisError(traces[0].trace, trace) : null;
      if (axisError) throw new Error(axisError);
      if (traces.some(entry => entry.trace.label === trace.label)) throw new Error('This curve is already included. Remove it before reloading its values.');
      const color = COLORS.find(color => !traces.some(entry => entry.color === color)) ?? COLORS[0];
      setTraces(current => [...current, { trace, color, visible: true, origin: {
        kind: 'source', caseName: chosenCase, selection, time: trace.snapshot, residualSelection: residual,
        field: trace.field, axis: trace.axis, mode: trace.mode,
      } }]);
    } catch (reason) {
      if (version === addVersion.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (version === addVersion.current) setAdding(false); }
  }

  const visible = useMemo(() => traces.filter(entry => entry.visible), [traces]);
  const logUsable = useMemo(() => visible.some(entry => entry.trace.points.some(point => point.y !== null && point.y > 0)), [visible]);
  const effectiveLogScale = logScale && logUsable;
  const plotted = useMemo(() => visible.map(entry => {
    const sample = sampleComparisonTrace(entry.trace, effectiveLogScale);
    return { ...entry, ...sample, points: sample.points.map((point, index, points) => ({
      ...point, isolated: point.y !== null && points[index - 1]?.y == null && points[index + 1]?.y == null,
    })) };
  }), [visible, effectiveLogScale]);
  const axisRows = useMemo(() => plotted.flatMap(entry => entry.points), [plotted]);
  const exportSource: ChartExportSource | null = useMemo(() => plotted.some(entry => !entry.blocked) ? {
    columns: [visible[0].trace.axis], rows: [],
    series: plotted.filter(entry => !entry.blocked).map((entry, index) => ({ index: index + 1, name: entry.trace.label, color: entry.color, points: entry.points })),
    xLabel: visible[0].trace.axis, yLabel: 'Value', logScale: effectiveLogScale,
    fileName: `comparison-${visible.map(entry => entry.trace.id).join('-')}`, title: 'Post-Process comparison',
  } : null, [plotted, visible, effectiveLogScale]);
  const tableRows = useMemo(() => {
    const rows: { trace: ComparisonTrace; x: number; y: number | null; index: number }[] = [];
    for (const entry of visible) {
      for (let index = 0; index < entry.trace.points.length && rows.length < 500; index += 1) rows.push({ trace: entry.trace, ...entry.trace.points[index], index });
      if (rows.length === 500) break;
    }
    return rows;
  }, [visible]);

  function saveCsv() {
    const blob = new Blob([serializeComparisonCsv(visible.map(entry => entry.trace))], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'post-process-comparison.csv';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function importTransfer(replace = false) {
    if (!pendingTransfer || adding || documentBusy) return;
    try {
      const imported = pendingTransfer.traces.map((value, index) => {
        const trace = validateCapturedAnalysisTrace(value);
        trace.id = `captured-${pendingTransfer.id}-${index}`;
        return { trace, origin: { kind: 'captured' as const, trace }, color: COLORS[(replace ? index : traces.length + index) % COLORS.length], visible: true };
      });
      const next = [...(replace ? [] : traces), ...imported];
      parsePostProcessAnalysis({ version: 1, curves: next, logScale, tableView });
      setTraces(next);
      lastTransfer.current = pendingTransfer.id;
      consumeAnalysisTransfer(pendingTransfer.id);
      setPendingTransfer(null);
      if (replace) { setDocumentId(''); setAnalysisName('ParaView captured analysis'); }
      setDocumentStatus('Imported ParaView values as captured snapshots. Saving preserves these values; reopening does not re-run the ParaView pipeline.');
    } catch (reason) { setDocumentStatus(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function saveAnalysis() {
    if (documentBusy || adding || !traces.length) return;
    const version = ++documentVersion.current;
    setDocumentBusy(true);
    setDocumentStatus('');
    try {
      const data = parsePostProcessAnalysis({ version: 1, curves: traces.map(({ origin, color, visible }) => ({ origin, color, visible })), logScale, tableView });
      const saved = await saveAnalysisDocument('postprocess', caseName, { id: documentId || crypto.randomUUID(), name: analysisName.trim(), savedAt: new Date().toISOString(), data });
      if (version !== documentVersion.current) return;
      setDocuments(current => [...current.filter(item => item.id !== saved.id), saved].sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
      setDocumentId(saved.id);
      setDocumentStatus('Analysis saved locally for this case and OpenFOAM installation. Source-backed curves are re-read when reopened; captured snapshots keep their values.');
    } catch (reason) { if (version === documentVersion.current) setDocumentStatus(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (version === documentVersion.current) setDocumentBusy(false); }
  }

  async function restoreAnalysis() {
    const saved = documents.find(item => item.id === documentId);
    if (!saved || documentBusy || adding) return;
    const version = ++documentVersion.current;
    setDocumentBusy(true);
    setDocumentStatus('Re-reading saved source-backed curves…');
    try {
      const restored = await replayPostProcessAnalysis(saved.data, readData, new Date().toISOString());
      if (version !== documentVersion.current) return;
      setTraces(restored.curves.map((entry, index) => ({ ...entry, trace: { ...entry.trace, id: `restored-${++nextId.current}-${index}` } })));
      setLogScale(restored.analysis.logScale);
      setTableView(restored.analysis.tableView);
      setAnalysisName(saved.name);
      setDocumentStatus(restored.warnings.length ? `Loaded ${restored.curves.length}/${restored.analysis.curves.length} curves. ${restored.warnings.join(' ')}` : 'Analysis reopened. Source-backed curves use current results; captured snapshots keep their original capture time.');
    } catch (reason) { if (version === documentVersion.current) setDocumentStatus(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (version === documentVersion.current) setDocumentBusy(false); }
  }

  async function deleteAnalysis() {
    if (!documentId || documentBusy || adding) return;
    const version = ++documentVersion.current;
    setDocumentBusy(true);
    try {
      await deleteAnalysisDocument('postprocess', caseName, documentId);
      if (version !== documentVersion.current) return;
      setDocuments(current => current.filter(item => item.id !== documentId));
      setDocumentId('');
      setDocumentStatus('Saved analysis deleted. The loaded curves remain available.');
    } catch (reason) { if (version === documentVersion.current) setDocumentStatus(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (version === documentVersion.current) setDocumentBusy(false); }
  }

  function saveReport() {
    try {
      const html = buildPostProcessAnalysisReport(analysisName.trim() || 'Post-Process analysis', traces, effectiveLogScale, new Date().toISOString());
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'post-process-analysis.html'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDocumentStatus('Printable HTML report exported with chart, retained-row statistics, provenance and embedded CSV.');
    } catch (reason) { setDocumentStatus(reason instanceof Error ? reason.message : String(reason)); }
  }

  function changeSource(key: string) {
    setSourceKey(key);
    setTime('');
    setField('1');
    setCandidate(null);
  }

  return <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[90vh] flex-col gap-3 overflow-y-auto sm:max-w-6xl">
        <DialogHeader><DialogTitle>Compare Post-Process curves</DialogTitle></DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={documentId || '__new'} disabled={documentBusy || adding} onValueChange={value => { const id = value === '__new' ? '' : value; setDocumentId(id); if (id) setAnalysisName(documents.find(item => item.id === id)?.name ?? 'Curve analysis'); }}><SelectTrigger className="w-52 text-xs"><SelectValue placeholder="Saved analyses" /></SelectTrigger><SelectContent><SelectItem value="__new">New analysis</SelectItem>{documents.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select>
          <Button size="sm" variant="outline" disabled={!documentId || documentBusy || adding} onClick={() => void restoreAnalysis()}>Reopen</Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Delete saved analysis" disabled={!documentId || documentBusy || adding} onClick={() => void deleteAnalysis()}><Trash2 className="h-3.5 w-3.5" /></Button>
          <Input aria-label="Analysis name" maxLength={120} value={analysisName} disabled={documentBusy} onChange={event => setAnalysisName(event.target.value)} className="h-8 w-48 text-xs" />
          <Button size="sm" variant="outline" className="gap-1.5" disabled={!traces.length || !analysisName.trim() || documentBusy || adding} onClick={() => void saveAnalysis()}>{documentBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}{documentId ? 'Update analysis' : 'Save analysis'}</Button>
          <Button size="sm" variant="outline" className="gap-1.5" disabled={!visible.length || documentBusy || adding} onClick={saveReport}><FileText className="h-3.5 w-3.5" />HTML report</Button>
        </div>
        {documentStatus && <p role="status" aria-live="polite" className="text-xs text-muted-foreground">{documentStatus}</p>}
        {pendingTransfer && <div className="flex flex-wrap items-center gap-2 rounded border border-blue-500/30 bg-blue-500/5 p-2 text-xs"><span className="flex-1">{pendingTransfer.traces.length} captured ParaView curves are ready. {pendingTransfer.provenance}</span><Button size="sm" variant="outline" disabled={adding || documentBusy} onClick={() => importTransfer()}>Add captured curves</Button><Button size="sm" variant="outline" disabled={adding || documentBusy} onClick={() => importTransfer(true)}>Use as new analysis</Button></div>}
        <p className="text-xs text-muted-foreground">Up to {COMPARISON_TRACE_LIMIT} curves. Original coordinates and gaps are retained. Matching coordinate names do not guarantee matching units or reference frames; verify quantities and sampling locations in the sources.</p>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-[160px_minmax(220px,1fr)_150px_170px_auto]">
          <div><Label className="text-xs">Case</Label><Select value={chosenCase} disabled={busy} onValueChange={value => { setChosenCase(value); setSources([]); changeSource(''); }}><SelectTrigger className="mt-1 text-xs"><SelectValue /></SelectTrigger><SelectContent>{cases.map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent></Select></div>
          <div><Label className="text-xs">Dataset / file or solver log</Label><Select value={sourceKey} disabled={loadingSources || busy} onValueChange={changeSource}><SelectTrigger className="mt-1 text-xs"><SelectValue placeholder={loadingSources ? 'Loading sources…' : 'No sources'} /></SelectTrigger><SelectContent>{sources.map(source => <SelectItem key={source.key} value={source.key} className="text-xs">{comparisonSource(source.selection)}</SelectItem>)}</SelectContent></Select></div>
          <div><Label className="text-xs">{selection?.kind === 'log' ? 'Initial residual' : 'Profile snapshot'}</Label>{selection?.kind === 'log' ? <Select value={residual} disabled={busy} onValueChange={value => setResidual(value as ResidualSelection)}><SelectTrigger className="mt-1 text-xs"><SelectValue /></SelectTrigger><SelectContent>{(['first', 'last', 'maximum'] as const).map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select> : <Select value={time || '__latest'} disabled={candidate?.mode !== 'profile' || busy} onValueChange={value => setTime(value === '__latest' ? '' : value)}><SelectTrigger className="mt-1 text-xs"><SelectValue placeholder="Time series" /></SelectTrigger><SelectContent><SelectItem value="__latest">Latest snapshot</SelectItem>{candidate?.times.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>}</div>
          <div><Label className="text-xs">Series / field</Label><Select value={field} disabled={!candidate || loadingData || busy} onValueChange={setField}><SelectTrigger className="mt-1 text-xs"><SelectValue placeholder="Select field" /></SelectTrigger><SelectContent>{candidate?.columns.slice(1).map((name, index) => <SelectItem key={index} value={String(index + 1)}>{name}</SelectItem>)}</SelectContent></Select></div>
          <Button className="self-end gap-1.5" disabled={!candidate || loadingData || loadingSources || busy || traces.length >= COMPARISON_TRACE_LIMIT || !!candidateAxisError} onClick={() => void addTrace()}>{adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}Add curve</Button>
        </div>
        <div className="min-h-4 text-xs" role="status" aria-live="polite">{loadingSources || loadingData ? <span className="flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" />{loadingSources ? 'Loading source inventory…' : 'Reading source…'}</span> : candidate ? <span className="text-muted-foreground">{candidate.mode === 'profile' ? `Snapshot ${candidate.shownTime}` : 'Time series'} · coordinate: {candidate.columns[0]} · {candidate.totalRows} retained rows</span> : null}</div>
        {(error || candidateAxisError || inventoryTruncated) && <p role="alert" className="text-xs text-warning">{error || candidateAxisError || 'Source inventory is incomplete: only the first 20,000 output files were inspected.'}</p>}
        <div className="max-h-40 flex-shrink-0 space-y-2 overflow-auto rounded border p-2">
          {!traces.length && <p className="text-xs text-muted-foreground">Choose a source and field, then add a curve. Add another case or profile snapshot to overlay its values.</p>}
          {traces.map(entry => <div key={entry.trace.id}>
            <div className="flex items-center gap-2"><Checkbox aria-label={`Show ${entry.trace.label}`} checked={entry.visible} disabled={busy} onCheckedChange={checked => setTraces(current => current.map(item => item.trace.id === entry.trace.id ? { ...item, visible: checked === true } : item))} /><span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: entry.color }} /><span className="min-w-0 flex-1 truncate text-xs" title={entry.trace.label}>{entry.trace.label}</span><Button size="icon" variant="ghost" className="h-5 w-5" aria-label={`Remove ${entry.trace.label}`} disabled={busy} onClick={() => setTraces(current => current.filter(item => item.trace.id !== entry.trace.id))}><X className="h-3 w-3" /></Button></div>
            <p className="ml-6 text-[10px] text-muted-foreground">{entry.trace.coverage} · loaded {entry.trace.loadedAt}</p>
          </div>)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setTableView(value => !value)}>{tableView ? 'Show chart' : 'Show table'}</Button>
          <Checkbox id="comparison-log" checked={effectiveLogScale} disabled={!logUsable} onCheckedChange={value => setLogScale(value === true)} /><Label htmlFor="comparison-log" className="text-xs">Log Y (non-positive values become gaps)</Label>
          <Button size="sm" variant="outline" className="ml-auto gap-1.5" disabled={!visible.length} onClick={saveCsv}><Download className="h-3.5 w-3.5" />CSV (visible curves)</Button>
          <Button size="sm" variant="outline" className="gap-1.5" disabled={!exportSource} onClick={() => setExportOpen(true)}><ImageIcon className="h-3.5 w-3.5" />Save chart…</Button>
        </div>
        <div className="min-h-60 flex-1 flex-shrink-0 overflow-auto rounded border">
          {tableView ? (
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-muted"><tr><th className="p-2">Curve / provenance</th><th className="p-2">Coordinate</th><th className="p-2">Value</th></tr></thead>
              <tbody>{tableRows.map(row => (
                <tr key={`${row.trace.id}-${row.index}`} className="border-t">
                  <td className="p-2">{row.trace.label}</td>
                  <td className="p-2 font-mono">{row.x}</td>
                  <td className="p-2 font-mono">{row.y === null ? '— (gap)' : row.y}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : axisRows.length ? (
            <ResponsiveContainer width="100%" height="100%" minHeight={240}>
              <ComposedChart data={axisRows} margin={{ top: 10, right: 20, bottom: 24, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" dataKey="x" domain={['dataMin', 'dataMax']} label={{ value: visible[0]?.trace.axis, position: 'insideBottom', offset: -14 }} />
                <YAxis type="number" scale={effectiveLogScale ? 'log' : 'linear'} domain={['auto', 'auto']} width={75} />
                <Tooltip<number, string> content={({ active, payload }) => active && payload?.length ? (
                  <div className="max-w-md rounded border bg-background p-2 text-[11px] shadow">
                    <p className="mb-1 text-muted-foreground">Each sample uses its own coordinate</p>
                    {payload.map((entry, index) => (
                      <p key={index} style={{ color: entry.color }}>
                        {entry.name}<br />
                        <span className="font-mono">{visible[0]?.trace.axis} = {entry.payload?.x}; value = {entry.value}</span>
                      </p>
                    ))}
                  </div>
                ) : null} />
                {plotted.filter(entry => !entry.blocked).map(entry => (
                  <Line
                    key={entry.trace.id} data={entry.points} dataKey="y" name={entry.trace.label}
                    stroke={entry.color} type="linear" connectNulls={false} isAnimationActive={false}
                    dot={props => props.payload?.isolated ? <circle key={props.index} cx={props.cx} cy={props.cy} r={2} fill={entry.color} /> : <g key={props.index} />}
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <p className="p-8 text-center text-xs text-muted-foreground">{visible.length ? 'No curves can be drawn within the current chart limits.' : 'Add or enable a curve to view the comparison.'}</p>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">{tableView ? `Table: first ${tableRows.length} of ${visible.reduce((sum, entry) => sum + entry.trace.points.length, 0)} loaded rows. CSV includes every loaded row, including gaps.` : `Chart: ${plotted.map(entry => `${entry.points.length}/${entry.trace.points.length}`).join(', ') || '0'} points per visible curve; cap ${COMPARISON_CHART_LIMIT}/curve. CSV uses loaded source rows, independent of this preview.`}{plotted.some(entry => entry.blocked) && <span className="text-warning"> Some curves are withheld because source or chart sampling omitted important boundaries; inspect the table/CSV.</span>}</p>
      </DialogContent>
    </Dialog>
    <ChartExportDialog open={exportOpen} onOpenChange={setExportOpen} source={exportSource} />
  </>;
}

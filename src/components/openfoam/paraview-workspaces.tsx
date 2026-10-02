'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Download, FolderOpen, Loader2, Save, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { confirmDialog } from '@/components/ui/confirm-host';
import { listAnalysisDocuments, saveAnalysisDocument, deleteAnalysisDocument, type AnalysisDocument } from '@/lib/analysis-documents';
import { MAX_WORKSPACE_BYTES, parseParaViewWorkspace, type ParaViewWorkspace } from '@/lib/paraview-workspace';
import type { ParaViewWorkbenchState } from '@/lib/paraview';
import type { VideoRequest } from '@/lib/paraview-video';

async function workspaceCommand(command: string, data: Record<string, unknown> = {}) {
  const response = await fetch('/api/paraview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'command', command, data }),
  });
  const result = await response.json() as { workspace?: unknown; state?: ParaViewWorkbenchState; error?: string };
  if (!response.ok) throw new Error(result.error || 'The workspace command failed.');
  return result;
}

export default function ParaViewWorkspaces({ caseName, locked, getVideo, onBusyChange, onRestored }: {
  caseName: string;
  locked: boolean;
  getVideo: () => VideoRequest | null;
  onBusyChange: (value: boolean) => void;
  onRestored: (state: ParaViewWorkbenchState, workspace: ParaViewWorkspace) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [documents, setDocuments] = useState<AnalysisDocument[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const revision = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    const invalidate = () => { revision.current++; setDocuments([]); setOpen(false); };
    window.addEventListener('foam-version-changed', invalidate);
    return () => { revision.current++; window.removeEventListener('foam-version-changed', invalidate); };
  }, [caseName]);

  useEffect(() => {
    if (!open) return;
    const ticket = revision.current;
    setError('');
    void listAnalysisDocuments('paraview', caseName).then(items => {
      if (revision.current === ticket) setDocuments(items);
    }).catch(cause => { if (revision.current === ticket) setError(String(cause instanceof Error ? cause.message : cause)); });
  }, [open, caseName]);

  const run = async (job: (ticket: number) => Promise<void>) => {
    if (busyRef.current || locked) return;
    busyRef.current = true; setBusy(true); onBusyChange(true); setError('');
    const ticket = revision.current;
    try { await job(ticket); }
    catch (cause) {
      if (revision.current === ticket) {
        const message = cause instanceof Error ? cause.message : 'Could not save or open the workspace.';
        setError(message); toast.error(message);
      }
    } finally { busyRef.current = false; setBusy(false); onBusyChange(false); }
  };

  const capture = async (): Promise<ParaViewWorkspace> => {
    const result = await workspaceCommand('workspace_capture');
    const workspace = parseParaViewWorkspace(result.workspace);
    if (workspace.caseName !== caseName) throw new Error('The active ParaView case changed. Try again in the original case.');
    const video = getVideo();
    return parseParaViewWorkspace({ ...workspace, ...(video ? { video } : {}) });
  };

  const download = (workspace: ParaViewWorkspace, label: string) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(workspace, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = `${label.replace(/[^a-z0-9_-]/gi, '_') || 'workspace'}.paraview.json`;
    anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const restore = async (raw: unknown, ticket: number) => {
    const workspace = parseParaViewWorkspace(raw);
    if (workspace.caseName !== caseName) throw new Error(`This workspace belongs to ${workspace.caseName}. Open that case first.`);
    if (!(await confirmDialog('Replace the current pipeline, camera and video timeline with this workspace?', { title: 'Open workspace', confirmLabel: 'Open' }))) return;
    if (revision.current !== ticket) return;
    const result = await workspaceCommand('workspace_restore', { workspace });
    if (!result.state) throw new Error('ParaView did not return the restored workspace.');
    if (revision.current !== ticket) return;
    await onRestored(result.state, workspace); setOpen(false); toast.success('Workspace opened.');
  };

  return <>
    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={locked} onClick={() => setOpen(true)}><FolderOpen className="h-3.5 w-3.5" /> Workspaces</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>ParaView workspaces</DialogTitle><DialogDescription>Save named views with their complete pipeline, reader regions, filter parameters, colors, camera, timestep and video timeline. Workspaces use the current installation and case; source data stays in the case.</DialogDescription></DialogHeader>
        <p className="text-xs text-muted-foreground">Reopening reads current results at the saved timestep. Missing files, regions, fields or timesteps produce an error and preserve the active pipeline. This app JSON format does not import native ParaView state files.</p>
        <div className="flex gap-2"><Input aria-label="Workspace name" placeholder="Pressure slice…" maxLength={100} value={name} onChange={event => setName(event.target.value)} disabled={busy} /><Button disabled={busy || !name.trim()} onClick={() => void run(async ticket => {
          const workspace = await capture(); if (revision.current !== ticket) return;
          const document = await saveAnalysisDocument('paraview', caseName, { id: crypto.randomUUID(), name: name.trim(), savedAt: new Date().toISOString(), data: workspace });
          if (revision.current === ticket) { setDocuments(items => [document, ...items]); setName(''); toast.success('Workspace saved.'); }
        })}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save</Button></div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="max-h-72 space-y-2 overflow-auto">
          {!documents.length && <p className="py-4 text-sm text-muted-foreground">No saved workspaces in this case yet.</p>}
          {documents.map(item => <div key={item.id} className="flex items-center gap-2 rounded border p-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{item.name}</p><p className="text-xs text-muted-foreground">{new Date(item.savedAt).toLocaleString()}</p></div><Button size="sm" variant="outline" disabled={busy} onClick={() => void run(ticket => restore(item.data, ticket))}>Open</Button><Button size="icon" variant="ghost" disabled={busy} aria-label={`Export ${item.name}`} onClick={() => void run(async () => download(parseParaViewWorkspace(item.data), item.name))}><Download className="h-4 w-4" /></Button><Button size="icon" variant="ghost" disabled={busy} aria-label={`Delete ${item.name}`} onClick={() => void run(async ticket => {
            if (!(await confirmDialog(`Delete the saved workspace “${item.name}”?`, { title: 'Delete workspace', confirmLabel: 'Delete', destructive: true }))) return;
            if (revision.current !== ticket) return;
            await deleteAnalysisDocument('paraview', caseName, item.id);
            if (revision.current === ticket) setDocuments(items => items.filter(saved => saved.id !== item.id));
          })}><Trash2 className="h-4 w-4" /></Button></div>)}
        </div>
        <div className="flex gap-2 border-t pt-3"><Button variant="outline" disabled={busy} onClick={() => void run(async ticket => { const workspace = await capture(); if (revision.current === ticket) download(workspace, name || caseName); })}><Download className="h-4 w-4" /> Export current JSON</Button><Button variant="outline" disabled={busy} onClick={() => inputRef.current?.click()}><Upload className="h-4 w-4" /> Import JSON…</Button></div>
        <input ref={inputRef} type="file" accept="application/json,.json" className="hidden" aria-label="Import workspace JSON" onChange={event => {
          const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
          void run(async ticket => { if (file.size > MAX_WORKSPACE_BYTES) throw new Error('The workspace file is too large.'); await restore(JSON.parse(await file.text()), ticket); });
        }} />
      </DialogContent>
    </Dialog>
  </>;
}

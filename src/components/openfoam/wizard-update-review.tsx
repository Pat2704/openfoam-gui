'use client';

/**
 * The review "Update case" shows before it touches anything: what will be
 * rewritten, created and removed, and — one by one — the files someone changed
 * since the wizard wrote them, each with the user's choice. The safe choice is
 * preselected (leave the file as it is), so applying without reading never
 * overwrites anybody's work. See src/lib/wizard-state.ts.
 */

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AlertTriangle, Info, Loader2, FileDiff } from 'lucide-react';
import type { ConflictReason, Decision, PlanEntry } from '@/lib/wizard-state';

const CHOICES: Record<ConflictReason, { why: string; keep: string; apply: string }> = {
  modified: { why: 'edited since the wizard wrote it', keep: 'Keep my version', apply: "Use the wizard's" },
  missing: { why: 'deleted since the wizard wrote it', keep: 'Leave it deleted', apply: 'Recreate it' },
  foreign: { why: 'already exists, not written by the wizard', keep: 'Keep the existing file', apply: 'Replace it' },
  'obsolete-modified': { why: 'no longer generated, and edited since', keep: 'Keep it', apply: 'Delete it' },
};

function Group({ title, paths, tone = 'plain' }: { title: string; paths: string[]; tone?: 'plain' | 'remove' }) {
  if (!paths.length) return null;
  return (
    <div>
      <div className="text-xs font-medium mb-1">{title} ({paths.length})</div>
      <div className={`font-mono text-[11px] columns-2 ${tone === 'remove' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}>
        {paths.map(p => <div key={p}>{p}</div>)}
      </div>
    </div>
  );
}

export default function UpdateReview({
  open, onOpenChange, caseName, plan, decisions, onDecide, onApply, applying, wizardContent, meshWillChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caseName: string;
  plan: PlanEntry[];
  decisions: Record<string, Decision>;
  onDecide: (path: string, d: Decision) => void;
  onApply: () => void;
  applying: boolean;
  /** The wizard's text for a path; null for geometry and for files it no longer writes. */
  wizardContent: (path: string) => string | null;
  meshWillChange: boolean;
}) {
  const [compare, setCompare] = useState<{ path: string; disk: string | null; wizard: string | null; error?: string } | null>(null);

  const of = (a: PlanEntry['action']) => plan.filter(e => e.action === a).map(e => e.path);
  const conflicts = plan.filter(e => e.action === 'conflict');
  const same = of('same').length;
  const undecided = conflicts.filter(e => !decisions[e.path]).length;

  const openCompare = async (path: string) => {
    const wizard = wizardContent(path);
    setCompare({ path, disk: null, wizard });
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}?action=read&path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setCompare({ path, disk: String(data.content ?? ''), wizard });
    } catch (e) {
      setCompare({ path, disk: null, wizard, error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { if (!applying) onOpenChange(o); }}>
        <DialogContent className="max-w-3xl max-h-[85vh]">
          <DialogHeader>
            <DialogTitle>Update &quot;{caseName}&quot;</DialogTitle>
            <DialogDescription>Nothing has been written yet. This is what applying the new settings does.</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh] pr-3">
            <div className="space-y-3">
              {conflicts.length > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="w-4 h-4" /> Changed outside the wizard: choose for each file
                  </div>
                  {conflicts.map(e => {
                    const c = CHOICES[e.reason ?? 'modified'];
                    const d = decisions[e.path];
                    const text = !e.path.startsWith('constant/geometry/');
                    return (
                      <div key={e.path} className="flex items-center gap-2 flex-wrap text-xs">
                        <span className="font-mono">{e.path}</span>
                        <span className="text-muted-foreground">{c.why}</span>
                        <div className="ml-auto flex items-center gap-1">
                          {text && (e.reason === 'modified' || e.reason === 'foreign') && (
                            <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => openCompare(e.path)}>
                              <FileDiff className="w-3 h-3 mr-1" /> Compare
                            </Button>
                          )}
                          <div role="radiogroup" aria-label={`What to do with ${e.path}`} className="flex rounded-md border overflow-hidden">
                            {(['keep', 'apply'] as const).map(opt => (
                              <button
                                key={opt}
                                type="button"
                                role="radio"
                                aria-checked={d === opt}
                                onClick={() => onDecide(e.path, opt)}
                                className={`px-2 h-6 text-[11px] border-r last:border-r-0 ${d === opt
                                  ? (opt === 'keep' ? 'bg-primary text-primary-foreground' : 'bg-red-600 text-white')
                                  : 'hover:bg-accent'}`}
                              >
                                {opt === 'keep' ? c.keep : c.apply}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <Group title="Rewritten (unchanged since the wizard wrote them)" paths={of('write')} />
              <Group title="Created" paths={of('create')} />
              <Group title="Removed (no longer generated, never edited)" paths={of('delete')} tone="remove" />
              {same > 0 && <p className="text-xs text-muted-foreground">{same} file{same === 1 ? '' : 's'} already match the new settings and are left alone.</p>}

              {meshWillChange && (
                <div className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
                  <Info className="w-4 h-4 flex-shrink-0 text-primary" />
                  <span>The mesh is built from files this update changes, so a mesh already in the case will no longer match them. You will be offered to rebuild it afterwards; nothing is re-meshed on its own.</span>
                </div>
              )}
            </div>
          </ScrollArea>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>Cancel</Button>
            <Button onClick={onApply} disabled={applying || undecided > 0}>
              {applying ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Applying…</> : 'Apply update'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!compare} onOpenChange={(o) => { if (!o) setCompare(null); }}>
        <DialogContent className="max-w-5xl max-h-[85vh]">
          <DialogHeader><DialogTitle className="font-mono text-sm">{compare?.path}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {([['On disk now', compare?.error ? `Could not read it: ${compare.error}` : compare?.disk ?? 'Reading…'],
               ["The wizard's version", compare?.wizard ?? '(the wizard no longer writes this file)']] as const).map(([title, text]) => (
              <div key={title}>
                <div className="text-xs font-medium mb-1">{title}</div>
                <ScrollArea className="h-[60vh] rounded border bg-muted/30">
                  <pre className="text-[11px] font-mono whitespace-pre p-2">{text}</pre>
                </ScrollArea>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

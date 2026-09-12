'use client';

/**
 * Case preflight in the File Editor, in two pieces that share one state:
 *
 *   CasePreflightTrigger   the green box beside Clean TS in the file tree's
 *                          toolbar, so it stays reachable at any window size;
 *   CasePreflightResults   the section under the tree and the editor. It only
 *                          exists while open, takes the height the editor
 *                          gives it and scrolls inside, so the tree and the
 *                          open file stay on screen.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  FileCode2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type {
  CasePreflightReport,
  PreflightIssue,
  PreflightSeverity,
  PreflightStatus,
} from '@/lib/case-preflight';

const severityUi: Record<PreflightSeverity, {
  label: string;
  icon: typeof AlertCircle;
  badge: string;
  panel: string;
}> = {
  error: {
    label: 'Errors',
    icon: AlertCircle,
    badge: 'border-danger/40 bg-danger-soft text-danger',
    panel: 'border-danger/35 bg-danger-soft/50',
  },
  warning: {
    label: 'Warnings',
    icon: AlertTriangle,
    badge: 'border-warning/40 bg-warning-soft text-warning',
    panel: 'border-warning/35 bg-warning-soft/45',
  },
  unverified: {
    label: 'Not verified',
    icon: CircleHelp,
    badge: 'border-info/40 bg-info-soft text-info',
    panel: 'border-info/35 bg-info-soft/45',
  },
};

function statusIcon(status: PreflightStatus) {
  if (status === 'error') return <AlertCircle className="h-4 w-4 text-danger" />;
  if (status === 'warning') return <AlertTriangle className="h-4 w-4 text-warning" />;
  if (status === 'unverified') return <CircleHelp className="h-4 w-4 text-info" />;
  return <CheckCircle2 className="h-4 w-4 text-success" />;
}

function issueLocation(issue: PreflightIssue): string | null {
  if (!issue.file) return null;
  return issue.line ? `${issue.file}:${issue.line}` : issue.file;
}

export interface CasePreflight {
  report: CasePreflightReport | null;
  running: boolean;
  error: string;
  /** Whether the results section is shown. */
  open: boolean;
  /** Buffer with unsaved edits; the run waits for it to be saved. */
  unsavedFile: string | null;
  /** Open the results section and check the case on disk. */
  run: () => void;
  close: () => void;
}

export function useCasePreflight(caseName: string, unsavedFile: string | null): CasePreflight {
  const [report, setReport] = useState<CasePreflightReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setReport(null);
    setError('');
    setOpen(false);
  }, [caseName]);

  useEffect(() => {
    const installationChanged = () => {
      setReport(null);
      setError('');
    };
    window.addEventListener('foam-version-changed', installationChanged);
    return () => window.removeEventListener('foam-version-changed', installationChanged);
  }, []);

  const run = useCallback(() => {
    setOpen(true);
    // The section opens anyway and says why nothing ran: the report must match
    // the case on disk, which an unsaved buffer does not.
    if (unsavedFile || running) return;
    setRunning(true);
    setError('');
    void (async () => {
      try {
        const response = await fetch(`/api/cases/${encodeURIComponent(caseName)}?action=preflight`, {
          cache: 'no-store',
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || 'Case preflight failed');
        setReport(data as CasePreflightReport);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Case preflight failed');
      } finally {
        setRunning(false);
      }
    })();
  }, [caseName, unsavedFile, running]);

  const close = useCallback(() => setOpen(false), []);

  return { report, running, error, open, unsavedFile, run, close };
}

function summaryOf(report: CasePreflightReport): string {
  if (report.counts.error > 0) return `${report.counts.error} blocking ${report.counts.error === 1 ? 'error' : 'errors'}`;
  if (report.counts.warning > 0) return 'No blocking errors · review warnings';
  return 'No blocking errors found';
}

/** The green box in the file tree's toolbar. */
export function CasePreflightTrigger({ preflight }: { preflight: CasePreflight }) {
  const { report, running, unsavedFile } = preflight;
  const errors = report?.counts.error ?? 0;
  return (
    <button
      type="button"
      onClick={preflight.run}
      disabled={running}
      aria-expanded={preflight.open}
      title={unsavedFile
        ? `Save ${unsavedFile} first: preflight reads the case on disk`
        : 'Read-only checks of this case with the selected OpenFOAM installation'}
      className="flex h-6 min-w-0 items-center gap-1 rounded-md border border-success/45 bg-success-soft px-2 text-[10px] font-medium text-success transition-colors hover:border-success hover:bg-success hover:text-white disabled:opacity-70"
    >
      {running
        ? <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />
        : <ShieldCheck className="h-3 w-3 flex-shrink-0" />}
      <span className="truncate">{running ? 'Checking…' : 'Preflight'}</span>
      {report && !running && (
        <span className={`rounded px-1 text-[9px] leading-4 ${errors ? 'bg-danger text-white' : 'bg-success text-white'}`}>
          {errors || '✓'}
        </span>
      )}
    </button>
  );
}

/** The results section. The parent decides its height; the content scrolls. */
export function CasePreflightResults({ preflight, onOpenFile, className = '' }: {
  preflight: CasePreflight;
  onOpenFile: (path: string) => void;
  className?: string;
}) {
  const { report, running, error, unsavedFile } = preflight;

  const grouped = useMemo(() => {
    const result: Record<PreflightSeverity, PreflightIssue[]> = {
      error: [], warning: [], unverified: [],
    };
    for (const issue of report?.issues || []) result[issue.severity].push(issue);
    return result;
  }, [report]);

  return (
    <Card className={`min-h-0 gap-0 overflow-hidden py-0 ${className}`} aria-label="Case preflight results">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <ShieldCheck className="h-4 w-4 flex-shrink-0 text-success" />
        <h3 className="text-sm font-semibold">Case preflight</h3>
        {report && (
          <Badge variant="outline" className={report.counts.error ? 'border-danger/40 text-danger' : 'border-success/40 text-success'}>
            {summaryOf(report)}
          </Badge>
        )}
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground lg:inline">
          Read-only · no solver, mesher or case copy
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={preflight.run} disabled={running || Boolean(unsavedFile)}>
            {running
              ? <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />Checking…</>
              : <><RefreshCw className="mr-1 h-3.5 w-3.5" />Run again</>}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={preflight.close} aria-label="Close the preflight results" title="Close the preflight results">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {unsavedFile && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" />
            <p><span className="font-medium">Save {unsavedFile} first.</span> Preflight reads the case on disk so it cannot include unsaved editor changes.</p>
          </div>
        )}

        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div><p className="font-medium">Preflight could not complete</p><p className="mt-0.5 text-foreground">{error}</p></div>
          </div>
        )}

        {running && !report && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking the case with the selected installation…
          </div>
        )}

        {report && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              {(Object.keys(severityUi) as PreflightSeverity[]).map(severity => {
                const ui = severityUi[severity];
                const Icon = ui.icon;
                return (
                  <Badge key={severity} variant="outline" className={`gap-1 ${ui.badge}`}>
                    <Icon className="h-3 w-3" />{report.counts[severity]} {ui.label.toLowerCase()}
                  </Badge>
                );
              })}
              <span className="ml-auto text-muted-foreground">
                OpenFOAM {report.version} · initial time {report.initialTime ?? '—'} · {report.filesInspected} files · {report.dictionaryFilesParsed} dictionaries · {(report.durationMs / 1000).toFixed(1)} s
              </span>
            </div>

            <div className="mb-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {report.sections.map(section => (
                <div key={section.id} className="flex items-start gap-2 rounded-lg border bg-muted/20 px-3 py-2">
                  <span className="mt-0.5 flex-shrink-0">{statusIcon(section.status)}</span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium">{section.title}</p>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{section.summary}</p>
                  </div>
                </div>
              ))}
            </div>

            {report.issues.length === 0 ? (
              <div className="flex items-center gap-3 rounded-lg border border-success/35 bg-success-soft px-4 py-3">
                <CheckCircle2 className="h-5 w-5 flex-shrink-0 text-success" />
                <div><p className="text-sm font-medium">All bounded checks passed</p><p className="text-xs text-muted-foreground">No actionable findings were produced for the inspected files.</p></div>
              </div>
            ) : (
              <div className="space-y-3">
                {(Object.keys(severityUi) as PreflightSeverity[]).map(severity => {
                  const issues = grouped[severity];
                  if (!issues.length) return null;
                  const ui = severityUi[severity];
                  const Icon = ui.icon;
                  return (
                    <section key={severity} aria-labelledby={`preflight-${severity}`}>
                      <div className="mb-2 flex items-center gap-2">
                        <Icon className={`h-4 w-4 ${severity === 'error' ? 'text-danger' : severity === 'warning' ? 'text-warning' : 'text-info'}`} />
                        <h4 id={`preflight-${severity}`} className="text-xs font-semibold uppercase tracking-wide">{ui.label}</h4>
                        <span className="text-xs text-muted-foreground">{issues.length}</span>
                      </div>
                      <div className="grid gap-2 lg:grid-cols-2">
                        {issues.map(issue => {
                          const location = issueLocation(issue);
                          return (
                            <article key={issue.id} className={`rounded-lg border px-3 py-3 ${ui.panel}`}>
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <p className="text-xs font-semibold">{issue.title}</p>
                                    <Badge variant="outline" className="h-5 bg-background/60 px-1.5 text-[9px] font-normal">{issue.category}</Badge>
                                  </div>
                                  <p className="mt-1 text-xs leading-5 text-foreground/90">{issue.message}</p>
                                </div>
                                {location && issue.openable !== false && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="h-7 max-w-[45%] flex-shrink-0 gap-1 bg-background px-2 text-[10px]"
                                    title={`Open ${location}`}
                                    onClick={() => onOpenFile(issue.file!)}
                                  >
                                    <FileCode2 className="h-3 w-3 flex-shrink-0" />
                                    <span className="truncate font-mono">{location}</span>
                                  </Button>
                                )}
                                {location && issue.openable === false && (
                                  <span className="max-w-[45%] flex-shrink-0 truncate rounded-md border bg-background/60 px-2 py-1.5 font-mono text-[10px]" title={`Create ${location}`}>
                                    {location}
                                  </span>
                                )}
                              </div>
                              {issue.suggestion && (
                                <p className="mt-2 border-t border-current/10 pt-2 text-[11px] leading-4 text-muted-foreground">
                                  <span className="font-medium text-foreground">Suggested action:</span> {issue.suggestion}
                                </p>
                              )}
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}

            <details className="mt-3 rounded-md border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
              <summary className="cursor-pointer select-none font-medium text-foreground">Coverage and deliberate limits</summary>
              <ul className="mt-2 list-disc space-y-1 pl-4">
                {report.scope.map(item => <li key={item}>{item}</li>)}
              </ul>
            </details>
          </>
        )}
      </div>
    </Card>
  );
}

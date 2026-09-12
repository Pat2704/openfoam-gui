'use client';

/**
 * Case preflight in the File Editor, in two pieces that share one state:
 *
 *   CasePreflightTrigger   the green box beside Clean TS in the file tree's
 *                          toolbar, so it stays reachable at any window size;
 *   CasePreflightResults   the section under the tree and the editor. It is
 *                          capped to a modest share of the height and scrolls
 *                          inside, and it can be hidden to a one-line bar (or
 *                          closed) without losing the report: showing it again
 *                          never re-runs the check.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
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
  if (status === 'error') return <AlertCircle className="h-3.5 w-3.5 text-danger" />;
  if (status === 'warning') return <AlertTriangle className="h-3.5 w-3.5 text-warning" />;
  if (status === 'unverified') return <CircleHelp className="h-3.5 w-3.5 text-info" />;
  return <CheckCircle2 className="h-3.5 w-3.5 text-success" />;
}

function issueLocation(issue: PreflightIssue): string | null {
  if (!issue.file) return null;
  return issue.line ? `${issue.file}:${issue.line}` : issue.file;
}

export interface CasePreflight {
  report: CasePreflightReport | null;
  running: boolean;
  error: string;
  /** Whether the results section is on screen at all. */
  open: boolean;
  /** Shown as its one-line bar only. */
  collapsed: boolean;
  /** Buffer with unsaved edits; the run waits for it to be saved. */
  unsavedFile: string | null;
  /** Open the results section and check the case on disk. */
  run: () => void;
  /** Show the last results again, expanded, without re-running. */
  show: () => void;
  /** Fold to the one-line bar, keeping the results. */
  hide: () => void;
  /** Remove the section; the green box brings the same results back. */
  close: () => void;
}

export function useCasePreflight(caseName: string, unsavedFile: string | null): CasePreflight {
  const [report, setReport] = useState<CasePreflightReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setReport(null);
    setError('');
    setOpen(false);
    setCollapsed(false);
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
    setCollapsed(false);
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

  const show = useCallback(() => { setOpen(true); setCollapsed(false); }, []);
  const hide = useCallback(() => { setOpen(true); setCollapsed(true); }, []);
  const close = useCallback(() => setOpen(false), []);

  return { report, running, error, open, collapsed, unsavedFile, run, show, hide, close };
}

function summaryOf(report: CasePreflightReport): string {
  if (report.counts.error > 0) return `${report.counts.error} blocking ${report.counts.error === 1 ? 'error' : 'errors'}`;
  if (report.counts.warning > 0) return 'No blocking errors · review warnings';
  return 'No blocking errors found';
}

/**
 * The green box in the file tree's toolbar. Before any result it runs the
 * check; afterwards it shows or hides the results ("Run again" re-checks).
 */
export function CasePreflightTrigger({ preflight }: { preflight: CasePreflight }) {
  const { report, running, unsavedFile, open, collapsed } = preflight;
  const errors = report?.counts.error ?? 0;
  const hasResult = Boolean(report || preflight.error);
  const visible = open && !collapsed;
  const onClick = () => {
    if (!hasResult && !running) preflight.run();
    else if (visible) preflight.hide();
    else preflight.show();
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={visible}
      title={!hasResult
        ? unsavedFile
          ? `Save ${unsavedFile} first: preflight reads the case on disk`
          : 'Read-only checks of this case with the selected OpenFOAM installation'
        : visible ? 'Hide the preflight results' : 'Show the preflight results'}
      className={`flex h-6 min-w-0 items-center gap-1 rounded-md border px-2 text-[10px] font-medium transition-colors ${
        visible
          ? 'border-success bg-success text-white hover:bg-success/90'
          : 'border-success/45 bg-success-soft text-success hover:border-success'
      }`}
    >
      {running
        ? <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />
        : <ShieldCheck className="h-3 w-3 flex-shrink-0" />}
      <span className="truncate">{running ? 'Checking…' : 'Preflight'}</span>
      {report && !running && (
        <span className={`rounded px-1 text-[9px] leading-4 ${errors ? 'bg-danger text-white' : visible ? 'bg-white/25 text-white' : 'bg-success text-white'}`}>
          {errors || '✓'}
        </span>
      )}
    </button>
  );
}

/** The results section: a one-line bar, or the bar plus a capped, scrolling body. */
export function CasePreflightResults({ preflight, onOpenFile, className = '' }: {
  preflight: CasePreflight;
  onOpenFile: (path: string) => void;
  className?: string;
}) {
  const { report, running, error, unsavedFile, collapsed } = preflight;

  const grouped = useMemo(() => {
    const result: Record<PreflightSeverity, PreflightIssue[]> = {
      error: [], warning: [], unverified: [],
    };
    for (const issue of report?.issues || []) result[issue.severity].push(issue);
    return result;
  }, [report]);

  return (
    <Card
      className={`flex-shrink-0 gap-0 overflow-hidden py-0 ${className}`}
      // At most about a third of the editor's height, and never tall.
      style={collapsed ? undefined : { maxHeight: 'min(34%, 17rem)' }}
      aria-label="Case preflight results"
    >
      <div className={`flex flex-shrink-0 items-center gap-2 px-3 py-1.5 ${collapsed ? '' : 'border-b'}`}>
        <ShieldCheck className="h-3.5 w-3.5 flex-shrink-0 text-success" />
        <h3 className="text-xs font-semibold">Preflight</h3>
        {running && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        {report && (
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <Badge variant="outline" className={`h-5 px-1.5 text-[10px] ${report.counts.error ? 'border-danger/40 text-danger' : 'border-success/40 text-success'}`}>
              {summaryOf(report)}
            </Badge>
            {(Object.keys(severityUi) as PreflightSeverity[]).map(severity => {
              const ui = severityUi[severity];
              const Icon = ui.icon;
              return (
                <Badge key={severity} variant="outline" className={`hidden h-5 gap-1 px-1.5 text-[10px] sm:inline-flex ${ui.badge}`}>
                  <Icon className="h-3 w-3" />{report.counts[severity]} {ui.label.toLowerCase()}
                </Badge>
              );
            })}
          </div>
        )}
        {!report && error && <span className="truncate text-[11px] text-danger">Could not complete</span>}
        <div className="ml-auto flex flex-shrink-0 items-center gap-0.5">
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={preflight.run} disabled={running || Boolean(unsavedFile)}
            title={unsavedFile ? `Save ${unsavedFile} first` : 'Check the case again'}>
            {running ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
            <span className="hidden sm:inline">Run again</span>
          </Button>
          <Button
            size="sm" variant="ghost" className="h-6 px-2 text-[11px]"
            onClick={collapsed ? preflight.show : preflight.hide}
            aria-expanded={!collapsed}
            title={collapsed ? 'Show the results' : 'Hide the results (they are kept)'}
          >
            {collapsed ? <ChevronUp className="mr-1 h-3 w-3" /> : <ChevronDown className="mr-1 h-3 w-3" />}
            {collapsed ? 'Show' : 'Hide'}
          </Button>
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={preflight.close}
            aria-label="Close the preflight bar" title="Close the bar (the Preflight box shows the results again)">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {unsavedFile && (
            <div className="mb-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-2.5 py-1.5 text-[11px]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning" />
              <p><span className="font-medium">Save {unsavedFile} first.</span> Preflight reads the case on disk so it cannot include unsaved editor changes.</p>
            </div>
          )}

          {error && (
            <div className="mb-2 flex items-start gap-2 rounded-md border border-danger/40 bg-danger-soft px-2.5 py-1.5 text-[11px] text-danger">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <div><p className="font-medium">Preflight could not complete</p><p className="mt-0.5 text-foreground">{error}</p></div>
            </div>
          )}

          {running && !report && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking the case with the selected installation…
            </div>
          )}

          {report && (
            <>
              <div className="mb-2 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
                {report.sections.map(section => (
                  <div key={section.id} className="flex items-start gap-1.5 rounded-md border bg-muted/20 px-2 py-1" title={section.summary}>
                    <span className="mt-0.5 flex-shrink-0">{statusIcon(section.status)}</span>
                    <div className="min-w-0">
                      <p className="truncate text-[11px] font-medium">{section.title}</p>
                      <p className="truncate text-[10px] text-muted-foreground">{section.summary}</p>
                    </div>
                  </div>
                ))}
              </div>

              {report.issues.length === 0 ? (
                <div className="flex items-center gap-2 rounded-md border border-success/35 bg-success-soft px-2.5 py-1.5 text-[11px]">
                  <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-success" />
                  <span><span className="font-medium">All bounded checks passed.</span> No actionable findings for the inspected files.</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {(Object.keys(severityUi) as PreflightSeverity[]).map(severity => {
                    const issues = grouped[severity];
                    if (!issues.length) return null;
                    const ui = severityUi[severity];
                    const Icon = ui.icon;
                    return (
                      <section key={severity} aria-labelledby={`preflight-${severity}`}>
                        <div className="mb-1 flex items-center gap-1.5">
                          <Icon className={`h-3.5 w-3.5 ${severity === 'error' ? 'text-danger' : severity === 'warning' ? 'text-warning' : 'text-info'}`} />
                          <h4 id={`preflight-${severity}`} className="text-[10px] font-semibold uppercase tracking-wide">{ui.label}</h4>
                          <span className="text-[10px] text-muted-foreground">{issues.length}</span>
                        </div>
                        <div className="grid gap-1.5 lg:grid-cols-2">
                          {issues.map(issue => {
                            const location = issueLocation(issue);
                            return (
                              <article key={issue.id} className={`rounded-md border px-2.5 py-1.5 ${ui.panel}`}>
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      <p className="text-[11px] font-semibold">{issue.title}</p>
                                      <Badge variant="outline" className="h-4 bg-background/60 px-1 text-[9px] font-normal">{issue.category}</Badge>
                                    </div>
                                    <p className="mt-0.5 text-[11px] leading-4 text-foreground/90">{issue.message}</p>
                                    {issue.suggestion && (
                                      <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                                        <span className="font-medium text-foreground">Suggested:</span> {issue.suggestion}
                                      </p>
                                    )}
                                  </div>
                                  {location && issue.openable !== false && (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      className="h-6 max-w-[45%] flex-shrink-0 gap-1 bg-background px-1.5 text-[10px]"
                                      title={`Open ${location}`}
                                      onClick={() => onOpenFile(issue.file!)}
                                    >
                                      <FileCode2 className="h-3 w-3 flex-shrink-0" />
                                      <span className="truncate font-mono">{location}</span>
                                    </Button>
                                  )}
                                  {location && issue.openable === false && (
                                    <span className="max-w-[45%] flex-shrink-0 truncate rounded-md border bg-background/60 px-1.5 py-1 font-mono text-[10px]" title={`Create ${location}`}>
                                      {location}
                                    </span>
                                  )}
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}

              <details className="mt-2 rounded-md border bg-muted/20 px-2.5 py-1 text-[10px] text-muted-foreground">
                <summary className="cursor-pointer select-none font-medium text-foreground">
                  Coverage and limits · OpenFOAM {report.version} · initial time {report.initialTime ?? '—'} · {report.filesInspected} files · {report.dictionaryFilesParsed} dictionaries · {(report.durationMs / 1000).toFixed(1)} s
                </summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {report.scope.map(item => <li key={item}>{item}</li>)}
                </ul>
              </details>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

'use client';

/**
 * Builds the mesh of a case the wizard wrote: blockMesh, then — with a
 * geometry — surfaceFeatures and snappyHexMesh, then checkMesh.
 *
 * Never started on its own: after an update the wizard only proposes a new
 * mesh (the user's decision), and this runs on their click. Each step goes
 * through /api/commands with its output streamed here and kept in the case as
 * log.<application>, as a tutorial's Allrun would; a failing step stops the
 * sequence and says why. checkMesh reporting issues is not a failure of the
 * sequence — it is the answer, and it is shown as such.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  Play, Loader2, CheckCircle2, XCircle, AlertTriangle, Box, Circle, ChevronRight,
} from 'lucide-react';
import { parseCheckMeshOutput, type CheckMeshReport } from '@/lib/check-mesh';

type StepState = 'pending' | 'running' | 'done' | 'failed';

interface StepResult { state: StepState; log: string; reason?: string }

/** Characters of output kept per step; snappyHexMesh prints a lot. */
const LOG_LIMIT = 400_000;

async function runStreamed(
  caseName: string, command: string, onChunk: (chunk: string) => void,
): Promise<{ exitCode: number; output: string }> {
  const res = await fetch('/api/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caseName, command, parallel: false, nProcs: 1, background: false, stream: true }),
  });
  if (!res.ok || !res.body) {
    const msg = await res.json().catch(() => ({} as { error?: string }));
    throw new Error(msg.error || `the server refused the command (HTTP ${res.status})`);
  }

  // Newline-delimited JSON, as the Commands panel reads it: a network chunk
  // can end mid-line, so the tail waits for the next read.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let exitCode = -1;
  let output = '';
  let ended = false;
  let failure: string | null = null;
  const handle = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    let msg: { t?: string; d?: string; exitCode?: number; output?: string; message?: string };
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.t === 'out' && typeof msg.d === 'string') onChunk(msg.d);
    else if (msg.t === 'end') {
      ended = true;
      exitCode = typeof msg.exitCode === 'number' ? msg.exitCode : 0;
      output = typeof msg.output === 'string' ? msg.output : '';
    } else if (msg.t === 'error') failure = msg.message || 'the command could not be started';
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) { handle(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); }
  }
  if (buffer) handle(buffer);
  if (failure) throw new Error(failure);
  if (!ended) throw new Error('the connection closed before the command finished');
  return { exitCode, output };
}

/** OpenFOAM's own sentence: the line after "FOAM FATAL …", else the last line. */
function failureReason(log: string): string {
  const lines = log.split('\n').map(l => l.trim()).filter(Boolean);
  const fatal = lines.findIndex(l => /FOAM FATAL/.test(l));
  const reason = (fatal >= 0 && lines.slice(fatal + 1).find(l => !/^From |^in file |^\s*$/.test(l)))
    || lines.reverse().find(l => /cannot|not found|unable|error|failed/i.test(l))
    || 'no reason was printed';
  return reason.slice(0, 300);
}

export default function MeshRunPanel({ caseName, steps, onShowMesh }: {
  caseName: string;
  steps: string[];
  onShowMesh: (caseName: string) => void;
}) {
  const [results, setResults] = useState<Record<string, StepResult>>({});
  const [running, setRunning] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<CheckMeshReport | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  // A different case or sequence is a different run.
  const signature = `${caseName}|${steps.join(',')}`;
  useEffect(() => { setResults({}); setVerdict(null); setShown(null); }, [signature]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [results, shown]);

  const run = async () => {
    setRunning(true);
    setVerdict(null);
    setResults(Object.fromEntries(steps.map(s => [s, { state: 'pending', log: '' }])));
    let failed = false;

    for (const app of steps) {
      setShown(app);
      setResults(prev => ({ ...prev, [app]: { state: 'running', log: '' } }));
      // Output is gathered here and pushed to the screen a few times a second:
      // one state update per chunk makes a long snappyHexMesh log crawl.
      let log = '';
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        timer = null;
        const text = log;
        setResults(prev => ({ ...prev, [app]: { ...prev[app], log: text } }));
      };
      const onChunk = (chunk: string) => {
        log = (log + chunk).slice(-LOG_LIMIT);
        if (!timer) timer = setTimeout(flush, 150);
      };

      try {
        // `tee` keeps log.<app> in the case for the Monitor; pipefail makes the
        // application's exit status, not tee's, the command's.
        const { exitCode, output } = await runStreamed(caseName, `set -o pipefail; ${app} 2>&1 | tee log.${app}`, onChunk);
        if (timer) clearTimeout(timer);
        const text = (log || output).slice(-LOG_LIMIT);

        if (app === 'checkMesh') {
          const report = parseCheckMeshOutput(text);
          if (report.verdictFound) {
            setVerdict(report);
            setResults(prev => ({ ...prev, [app]: { state: 'done', log: text } }));
            continue;
          }
        }
        if (exitCode !== 0) {
          failed = true;
          setResults(prev => ({ ...prev, [app]: { state: 'failed', log: text, reason: failureReason(text) } }));
          toast.error(`${app} failed: ${failureReason(text)}`);
          break;
        }
        setResults(prev => ({ ...prev, [app]: { state: 'done', log: text } }));
      } catch (e) {
        if (timer) clearTimeout(timer);
        failed = true;
        const reason = e instanceof Error ? e.message : String(e);
        setResults(prev => ({ ...prev, [app]: { state: 'failed', log, reason } }));
        toast.error(`${app} could not run: ${reason}`);
        break;
      }
    }

    setRunning(false);
    if (!failed) toast.success(`Mesh built for "${caseName}"`);
  };

  const finished = steps.length > 0 && steps.every(s => results[s]?.state === 'done');
  const failedStep = steps.find(s => results[s]?.state === 'failed');
  const label = steps.length > 2 ? 'the meshing sequence' : steps[0] ?? 'blockMesh';
  const current = shown ? results[shown] : undefined;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 flex-wrap text-xs">
        {steps.map((s, i) => {
          const st = results[s]?.state;
          return (
            <React.Fragment key={s}>
              {i > 0 && <ChevronRight className="w-3 h-3 text-muted-foreground" />}
              <button
                type="button"
                onClick={() => results[s] && setShown(s)}
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono ${shown === s ? 'border-primary bg-primary/10' : 'border-border'}`}
                title={results[s] ? `Show the output of ${s}` : s}
              >
                {st === 'running' ? <Loader2 className="w-3 h-3 animate-spin" />
                  : st === 'done' ? <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                    : st === 'failed' ? <XCircle className="w-3 h-3 text-red-500" />
                      : <Circle className="w-3 h-3 text-muted-foreground" />}
                {s}
              </button>
            </React.Fragment>
          );
        })}
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" className="h-7 text-xs" onClick={run} disabled={running}>
            {running
              ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Running…</>
              : <><Play className="w-3 h-3 mr-1" /> {finished || failedStep ? 'Run again' : `Run ${label}`}</>}
          </Button>
          {finished && (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onShowMesh(caseName)}>
              <Box className="w-3 h-3 mr-1" /> Show in the Mesh tab
            </Button>
          )}
        </div>
      </div>

      {failedStep && results[failedStep]?.reason && (
        <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-xs">
          <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
          <span><span className="font-mono">{failedStep}</span> stopped: {results[failedStep].reason}. The steps after it did not run; the full output is below and in <span className="font-mono">log.{failedStep}</span>.</span>
        </div>
      )}

      {verdict && (verdict.meshOk ? (
        <div className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20 px-3 py-2 text-xs">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" /> checkMesh: Mesh OK
          {verdict.overallStats.find(s => s.key === 'cells') && <span className="font-mono text-muted-foreground">· {verdict.overallStats.find(s => s.key === 'cells')!.value} cells</span>}
        </div>
      ) : (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs space-y-1">
          <div className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="w-4 h-4" /> checkMesh reports {verdict.failedChecks.length} issue{verdict.failedChecks.length === 1 ? '' : 's'}. The mesh was built; judge whether it is good enough.
          </div>
          <ul className="list-disc pl-5 space-y-0.5">
            {verdict.failedChecks.map((c, i) => <li key={i} className="font-mono">{c.message}</li>)}
          </ul>
        </div>
      ))}

      {current && (
        <pre ref={logRef} className="max-h-64 overflow-auto rounded-md bg-muted/40 p-2 text-[11px] font-mono whitespace-pre-wrap">
          {current.log ? current.log.slice(-40_000) : current.state === 'running' ? `Starting ${shown}…` : '(no output)'}
        </pre>
      )}
    </div>
  );
}

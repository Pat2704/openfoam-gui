'use client';

/**
 * checkMesh report for a case.
 *
 * Lifted out of the Monitor tab: mesh quality belongs next to the 3D view of
 * the mesh, not next to the solver logs. The component owns its own state so
 * both the panel and its data disappear when the case changes.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, XCircle as XCircleIcon, Loader2 } from 'lucide-react';

interface CheckMeshData {
  success: boolean;
  raw: string;
  overallStats: { key: string; value: string }[];
  failedChecks: { severity: 'fail' | 'warning'; message: string }[];
  meshOk: boolean;
}

export default function CheckMeshPanel({ caseName }: { caseName: string }) {
  const [checkMeshResult, setCheckMeshResult] = useState<CheckMeshData | null>(null);
  const [checkMeshLoading, setCheckMeshLoading] = useState(false);
  const [showCheckMesh, setShowCheckMesh] = useState(false);

  const runCheckMeshAction = useCallback(async () => {
    if (!caseName) return;
    setCheckMeshLoading(true);
    setShowCheckMesh(true);
    setCheckMeshResult(null);
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}?action=checkMesh`);
      const data = await res.json();
      setCheckMeshResult(data);
      if (!data.success) {
        toast.error('checkMesh failed: ' + (data.raw || 'unknown error'));
      } else if (data.meshOk) {
        toast.success('Mesh OK');
      } else {
        toast.warning('Mesh with detected issues');
      }
    } catch {
      toast.error('Error communicating with the server');
      setCheckMeshResult({ success: false, raw: 'Network error', overallStats: [], failedChecks: [], meshOk: false });
    }
    setCheckMeshLoading(false);
  }, [caseName]);

  useEffect(() => {
    setShowCheckMesh(false);
    setCheckMeshResult(null);
  }, [caseName]);

  if (!caseName) return null;

  return (
    <>
  {/* ═══ CheckMesh Report ═══ */}
  <Card>
    <CardHeader className="pb-2 pt-3 px-3">
      <div className="flex items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <AlertTriangle className="w-4 h-4" /> CheckMesh
        </CardTitle>
        <Button size="sm" variant="outline" className="h-7 text-xs"
          onClick={runCheckMeshAction} disabled={checkMeshLoading}>
          {checkMeshLoading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <AlertTriangle className="w-3 h-3 mr-1" />}
          Run checkMesh
        </Button>
      </div>
    </CardHeader>
    {showCheckMesh && checkMeshResult && (
      <CardContent className="px-3 pb-3">
        {/* Overall verdict */}
        <div className={`flex items-center gap-2 p-2.5 rounded-md mb-3 text-sm font-medium ${
          checkMeshResult.meshOk
            ? 'bg-green-500/10 text-green-400 border border-green-500/30'
            : 'bg-red-500/10 text-red-400 border border-red-500/30'
        }`}>
          {checkMeshResult.meshOk
            ? <><CheckCircle2 className="w-4 h-4" /> Mesh OK — no issues detected</>
            : <><XCircleIcon className="w-4 h-4" /> Mesh issues detected</>}
        </div>

        {/* Mesh stats table */}
        {checkMeshResult.overallStats.length > 0 && (
          <div className="mb-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 font-semibold">Mesh Statistics</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {checkMeshResult.overallStats.map((s, i) => (
                <div key={i} className="bg-muted/50 rounded px-2.5 py-1.5">
                  <p className="text-[10px] text-muted-foreground leading-tight">{s.key}</p>
                  <p className="text-xs font-mono font-semibold">{s.value}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Failed checks */}
        {checkMeshResult.failedChecks.length > 0 && (
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 font-semibold">
              Issues ({checkMeshResult.failedChecks.length})
            </p>
            <div className="space-y-1">
              {checkMeshResult.failedChecks.map((c, i) => (
                <div key={i} className={`flex items-start gap-2 px-2.5 py-1.5 rounded text-xs ${
                  c.severity === 'fail'
                    ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                    : 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20'
                }`}>
                  {c.severity === 'fail'
                    ? <XCircleIcon className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />}
                  <span className="font-mono text-[11px] leading-snug break-all">{c.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Raw output toggle */}
        <details className="mt-3">
          <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
            Raw checkMesh output
          </summary>
          <pre className="mt-1.5 p-2 bg-muted/50 rounded text-[10px] font-mono max-h-48 overflow-auto whitespace-pre-wrap break-words">
            {checkMeshResult.raw}
          </pre>
        </details>
      </CardContent>
    )}
  </Card>
    </>
  );
}

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import MeshViewer from '@/components/openfoam/mesh-viewer';
import { loadFoamyConfig, patchFoamyConfig } from '@/lib/foamy-store';
import { AlertTriangle, CheckCircle2, Cuboid, FolderSearch, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

interface ParaViewStatus {
  found: boolean;
  pvpythonPath?: string;
  version?: string;
  source?: string;
  searched?: string[];
  error?: string;
}

export default function ParaViewViewer({ caseName, active = true }: {
  caseName: string;
  active?: boolean;
}) {
  const [status, setStatus] = useState<ParaViewStatus | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [checking, setChecking] = useState(true);

  const detect = useCallback(async (manualPath: string, refresh = false, save = false) => {
    setChecking(true);
    try {
      const query = new URLSearchParams({ action: 'status' });
      if (manualPath.trim()) query.set('path', manualPath.trim());
      if (refresh) query.set('refresh', '1');
      const response = await fetch(`/api/paraview?${query}`);
      const data = await response.json() as ParaViewStatus;
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setStatus(data);
      if (save) {
        const written = await patchFoamyConfig({ 'paraview-path': manualPath.trim() });
        if (!written) toast.error('ParaView path could not be saved.');
        else if (data.found) toast.success(`ParaView ${data.version || ''} is ready.`.trim());
      }
    } catch (error) {
      setStatus({ found: false, error: error instanceof Error ? error.message : 'ParaView detection failed.' });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadFoamyConfig().then(config => {
      if (cancelled) return;
      const saved = config['paraview-path'] || '';
      setPathInput(saved);
      return detect(saved);
    });
    return () => { cancelled = true; };
  }, [detect]);

  const selectedPath = status?.pvpythonPath || pathInput.trim();

  return (
    <div className="space-y-3">
      <Card className="border-cyan-500/30 bg-gradient-to-r from-cyan-500/5 via-card to-blue-500/5">
        <CardHeader className="py-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle className="text-sm flex items-center gap-2">
              <Cuboid className="w-4 h-4 text-cyan-500" /> ParaView Engine
              {checking && <Badge variant="secondary" className="text-[10px]"><Loader2 className="w-3 h-3 animate-spin" /> Detecting</Badge>}
              {!checking && status?.found && (
                <Badge className="text-[10px] bg-emerald-600 hover:bg-emerald-600">
                  <CheckCircle2 className="w-3 h-3" /> v{status.version || 'unknown'}
                </Badge>
              )}
            </CardTitle>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={checking}
              onClick={() => void detect(pathInput, true)}
            >
              {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Look again
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          <p className="text-xs text-muted-foreground">
            ParaView runs invisibly through pvpython. Loading a case executes <code className="font-mono text-foreground">paraFoam -touch</code> in WSL, then ParaView reads that marker and returns an interactive 3D surface here.
          </p>

          {!checking && status?.found ? (
            <div className="rounded-md border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-xs flex gap-2 items-start">
              <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-600 flex-shrink-0" />
              <div className="min-w-0">
                <p className="font-medium">Detected from {status.source || 'this computer'}</p>
                <p className="font-mono text-[10px] text-muted-foreground break-all mt-0.5">{status.pvpythonPath}</p>
              </div>
            </div>
          ) : !checking ? (
            <div className="rounded-md border border-amber-400/40 bg-amber-500/5 px-3 py-2 text-xs flex gap-2 items-start">
              <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600 flex-shrink-0" />
              <div>
                <p className="font-medium">ParaView is not ready</p>
                <p className="text-muted-foreground mt-0.5">{status?.error}</p>
                {status?.searched && status.searched.length > 0 && (
                  <p className="text-[10px] text-muted-foreground mt-1">Checked {status.searched.length} possible executable paths.</p>
                )}
              </div>
            </div>
          ) : null}

          <div className="flex gap-2 items-center flex-wrap">
            <div className="relative flex-1 min-w-[260px]">
              <FolderSearch className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
              <Input
                value={pathInput}
                onChange={event => setPathInput(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') void detect(pathInput, true, true);
                }}
                className="pl-9 font-mono text-xs"
                placeholder="Optional: ParaView folder, paraview.exe, or pvpython.exe"
                spellCheck={false}
              />
            </div>
            <Button size="sm" disabled={checking} onClick={() => void detect(pathInput, true, true)}>
              Use path
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Automatic discovery checks PATH, the Windows registry, Program Files and Local AppData without assuming a ParaView version or folder name. The manual path covers portable or unusually located copies.
          </p>
        </CardContent>
      </Card>

      {status?.found && (
        <MeshViewer
          key={`${caseName || 'none'}:${selectedPath}`}
          caseName={caseName}
          active={active}
          source="paraview"
          sourcePath={selectedPath}
        />
      )}
    </div>
  );
}

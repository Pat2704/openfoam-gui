'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Database, Loader2 } from 'lucide-react';

interface KnowledgeStatusData {
  ready: boolean;
  stale: boolean;
  building: boolean;
  version: string;
  distro: string;
  builtAt?: string;
  counts?: { names?: number; keyedTypes?: number; applications?: number };
  corpus?: {
    ready: boolean; stale: boolean; building: boolean; chunks: number; files: number;
    builtAt?: string; version?: string;
  };
}

/** Compact, shared evidence-state indicator for all three AI surfaces. */
export function KnowledgeStatus({ className = '' }: { className?: string }) {
  const [status, setStatus] = useState<KnowledgeStatusData | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/foam-index?action=status', { cache: 'no-store' });
      if (response.ok) setStatus(await response.json());
    } catch { /* the AI panel remains usable while WSL starts */ }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, status?.building || status?.corpus?.building || status?.corpus?.stale ? 4000 : 30000);
    const changed = () => {
      setStatus(previous => previous ? { ...previous, ready: false, stale: true, building: true } : previous);
      window.setTimeout(load, 750);
    };
    window.addEventListener('foam-version-changed', changed);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('foam-version-changed', changed);
    };
  }, [load, status?.building, status?.corpus?.building, status?.corpus?.stale]);

  if (!status) {
    return <div className={`text-[10px] text-muted-foreground ${className}`}>Reading local knowledge status…</div>;
  }

  const corpusReady = status.corpus?.ready === true;
  const stale = status.stale || status.corpus?.stale;
  const building = status.building || status.corpus?.building || (!status.ready && !stale);
  const indexed = status.builtAt
    ? new Date(status.builtAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '';
  const label = stale
    ? 'stale — rebuilding'
    : status.ready && corpusReady
      ? 'ready'
      : building ? 'building' : 'partial';

  return (
    <div
      className={`flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/35 px-2 py-1.5 text-[10px] text-muted-foreground ${className}`}
      title={indexed ? `Installation knowledge indexed ${indexed}` : 'Installation knowledge is not indexed yet'}
    >
      {building || stale
        ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-warning" />
        : <Database className={`h-3 w-3 shrink-0 ${status.ready && corpusReady ? 'text-success' : 'text-warning'}`} />}
      <span className="font-medium text-foreground">Knowledge {status.version ? `OpenFOAM ${status.version}` : 'OpenFOAM'}</span>
      <span>· {label}</span>
      {status.counts?.names !== undefined && <span>· {status.counts.names.toLocaleString()} names</span>}
      {status.corpus?.chunks !== undefined && <span>· {status.corpus.chunks.toLocaleString()} tutorial chunks</span>}
      {indexed && <span className="truncate">· {indexed}</span>}
    </div>
  );
}

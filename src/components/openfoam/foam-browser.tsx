'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardTitle, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import {
  Folder, File, FileCode, ChevronRight, ChevronDown, RefreshCw,
  Loader2, ArrowLeft, Boxes, FolderTree, Copy, AlertCircle
} from 'lucide-react';

interface FoamFileItem {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

interface LsResult {
  exists: boolean;
  rootDir: string;
  relPath: string;
  items: FoamFileItem[];
}

type Section = 'applications' | 'src';

const SECTION_META: Record<Section, { label: string; icon: React.ReactNode; desc: string }> = {
  applications: { label: 'Applications', icon: <Boxes className="w-4 h-4" />,     desc: 'OpenFOAM Applications — applications/ (solvers, utilities)' },
  src:          { label: 'Src',          icon: <FolderTree className="w-4 h-4" />, desc: 'Core library sources — src' },
};

function formatSize(bytes: number): string {
  if (bytes === 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export default function OpenFoamBrowser({ section }: { section: Section }) {
  const meta = SECTION_META[section];
  const [currentPath, setCurrentPath] = useState(''); // relative path inside the section
  const [lsResult, setLsResult] = useState<LsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [rootDir, setRootDir] = useState('');

  // Currently open file (for the reader pane)
  const [openFile, setOpenFile] = useState<{ path: string; content: string; size: number; truncated: boolean; binary: boolean } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const fetchLs = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/foam-files?action=ls&section=${section}&path=${encodeURIComponent(path)}`, {
        cache: 'no-store',
      });
      const data = await res.json();
      setLsResult(data);
      if (data.rootDir) setRootDir(data.rootDir);
    } catch {
      setLsResult({ exists: false, rootDir: '', relPath: path, items: [] });
    }
    setLoading(false);
  }, [section]);

  // Fetch root dir on mount
  useEffect(() => {
    fetch('/api/foam-files?action=root&section=' + section)
      .then(r => r.json())
      .then(d => { if (d.rootDir) setRootDir(d.rootDir); })
      .catch(() => {});
    fetchLs('');
  }, [section, fetchLs]);

  const navigateInto = (item: FoamFileItem) => {
    if (!item.isDir) {
      openFileReader(item);
      return;
    }
    setOpenFile(null);
    setCurrentPath(item.path);
    fetchLs(item.path);
  };

  const navigateUp = () => {
    if (!currentPath) return;
    const parts = currentPath.split('/');
    parts.pop();
    const parent = parts.join('/');
    setCurrentPath(parent);
    fetchLs(parent);
  };

  const openFileReader = async (item: FoamFileItem) => {
    setFileLoading(true);
    setOpenFile(null);
    try {
      const res = await fetch(`/api/foam-files?action=read&section=${section}&path=${encodeURIComponent(item.path)}`, {
        cache: 'no-store',
      });
      const data = await res.json();
      if (data.success) {
        setOpenFile({ path: item.path, content: data.content, size: data.size, truncated: data.truncated, binary: false });
      } else {
        setOpenFile({ path: item.path, content: data.content || 'Unable to read the file', size: data.size || 0, truncated: false, binary: data.binary });
      }
    } catch {
      setOpenFile({ path: item.path, content: 'Network error', size: 0, truncated: false, binary: false });
    }
    setFileLoading(false);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => toast.success('Copied to clipboard'));
  };

  // Breadcrumb segments
  const crumbs = currentPath ? currentPath.split('/').filter(Boolean) : [];

  return (
    // Fixed-height container (viewport minus header/tabs/padding) so each panel
    // scrolls INDEPENDENTLY: the file tree on the left and the reader on the
    // right each have their own ScrollArea/overflow, so opening a large file in
    // the reader does NOT expand the layout or push the tree out of view — the
    // tree stays scrollable on its own regardless of what's open in the reader.
    <div className="flex gap-3 w-full" style={{ height: 'calc(100vh - 180px)', minHeight: '480px' }}>
      {/* ═══ Browser Sidebar ═══ */}
      <Card className="w-80 flex-shrink-0 flex flex-col overflow-hidden">
        <CardHeader className="pb-2 pt-3 px-3 flex-shrink-0">
          <CardTitle className="text-sm flex items-center gap-1.5">
            {meta.icon}
            <span>{meta.label} OpenFOAM</span>
            <button
              className="ml-auto p-0.5 rounded hover:bg-accent transition-colors"
              onClick={() => fetchLs(currentPath)}
              title="Refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-muted-foreground hover:text-foreground ${loading ? 'animate-spin' : ''}`} />
            </button>
          </CardTitle>
          <p className="text-[10px] text-muted-foreground">{meta.desc}</p>
        </CardHeader>

        {/* Breadcrumb */}
        <div className="px-3 pb-1 flex items-center gap-1 text-xs flex-wrap flex-shrink-0">
          <button
            className="px-1.5 py-0.5 rounded hover:bg-accent font-mono text-muted-foreground"
            onClick={() => { setCurrentPath(''); fetchLs(''); }}
            title="Section root"
          >
            /
          </button>
          {crumbs.map((c, i) => {
            const p = crumbs.slice(0, i + 1).join('/');
            const isLast = i === crumbs.length - 1;
            return (
              <span key={p} className="flex items-center gap-1">
                <ChevronRight className="w-3 h-3 text-muted-foreground" />
                <button
                  className={`px-1.5 py-0.5 rounded hover:bg-accent font-mono ${isLast ? 'text-foreground font-medium' : 'text-muted-foreground'}`}
                  onClick={() => { setCurrentPath(p); fetchLs(p); }}
                >
                  {c}
                </button>
              </span>
            );
          })}
        </div>

        {currentPath && (
          <div className="px-3 pb-1 flex-shrink-0">
            <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2" onClick={navigateUp}>
              <ArrowLeft className="w-3 h-3 mr-1" /> Up
            </Button>
          </div>
        )}

        <CardContent className="p-0 flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-2 space-y-0.5">
              {loading ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Loader2 className="w-5 h-5 mx-auto mb-2 animate-spin" />
                  <p className="text-xs">Loading…</p>
                </div>
              ) : !lsResult || !lsResult.exists ? (
                <div className="text-center py-8 text-muted-foreground text-xs">
                  <AlertCircle className="w-5 h-5 mx-auto mb-2 opacity-50" />
                  Directory not found.
                  <p className="text-[10px] mt-1">The section may not be available in this installation.</p>
                </div>
              ) : lsResult.items.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-xs">
                  <Folder className="w-5 h-5 mx-auto mb-2 opacity-30" />
                  Empty folder
                </div>
              ) : (
                lsResult.items.map(item => (
                  <button
                    key={item.path}
                    className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-accent transition-colors flex items-center gap-2 ${
                      openFile?.path === item.path ? 'bg-accent' : ''
                    }`}
                    onClick={() => navigateInto(item)}
                    title={item.isDir ? `Open ${item.name}/` : `${item.name} (${formatSize(item.size)})`}
                  >
                    {item.isDir ? (
                      <Folder className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                    ) : (
                      <FileCode className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                    )}
                    <span className="font-mono truncate flex-1 min-w-0">{item.name}</span>
                    {!item.isDir && (
                      <span className="text-[9px] text-muted-foreground flex-shrink-0">{formatSize(item.size)}</span>
                    )}
                    {item.isDir && (
                      <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                    )}
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </CardContent>

        {rootDir && (
          <div className="border-t px-3 py-1.5 flex-shrink-0">
            <div className="text-[9px] text-muted-foreground truncate" title={rootDir}>
              <code className="font-mono">{rootDir}</code>
            </div>
          </div>
        )}
      </Card>

      {/* ═══ Reader Pane ═══ */}
      <Card className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {openFile ? (
          <>
            <div className="flex items-center justify-between px-4 py-2 border-b flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <FileCode className="w-4 h-4 text-blue-500 flex-shrink-0" />
                <span className="font-mono text-sm font-medium truncate" title={openFile.path}>
                  {meta.label}/{openFile.path}
                </span>
                <Badge variant="outline" className="text-[9px] flex-shrink-0">{formatSize(openFile.size)}</Badge>
                {openFile.truncated && (
                  <Badge variant="outline" className="text-[9px] border-amber-500/50 text-amber-600 flex-shrink-0">
                    truncated 1MB
                  </Badge>
                )}
                {openFile.binary && (
                  <Badge variant="outline" className="text-[9px] border-orange-500/50 text-orange-600 flex-shrink-0">
                    binary
                  </Badge>
                )}
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <Button size="sm" variant="ghost" onClick={() => copyToClipboard(openFile.content)}>
                  <Copy className="w-3 h-3 mr-1" /> Copy
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-auto">
              {openFile.binary ? (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm p-8 text-center">
                  <div>
                    <AlertCircle className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p>{openFile.content}</p>
                    <p className="text-xs mt-2 text-muted-foreground">
                      Binary files (.so, .o, executables) cannot be displayed as text.
                    </p>
                  </div>
                </div>
              ) : (
                <pre className="text-xs font-mono p-3 whitespace-pre-wrap break-all bg-muted/20 min-h-full">
                  {openFile.content || '(empty file)'}
                </pre>
              )}
            </div>
          </>
        ) : fileLoading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            <div className="text-center max-w-md">
              <FolderTree className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p className="font-medium">{meta.label} OpenFOAM</p>
              <p className="text-xs mt-1">
                Browse the tree on the left to explore {meta.desc}.<br />
                Text files (.C, .H, .so meta, etc.) are readable; binaries (.so) are flagged.
              </p>
              <p className="text-[10px] mt-3 text-muted-foreground/70">
                Generic section: uses OpenFOAM environment variables (FOAM_LIBBIN / FOAM_SOLVERS / FOAM_SRC),
                not hard-coded to a specific path.
              </p>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

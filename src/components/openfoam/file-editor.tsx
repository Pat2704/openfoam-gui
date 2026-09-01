'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import {
  Plus, Trash2, FileCode, FolderPlus, Save, Copy,
  FolderTree, ChevronDown, ChevronRight, File, FileText,
  RotateCcw, Folder, CheckSquare, Square, XCircle, Timer,
  Loader2, RefreshCw, Search, WrapText, X, Pencil
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useCaseContext } from '@/lib/case-context';
import { confirmDialog } from '@/components/ui/confirm-host';

// Canonical timestep regex: matches integer (0, 100), decimal (0.001, 1.5),
// and scientific notation (1e-5, 1.5E-3, 1e+5). Mirrors the WSL-side regex in
// src/lib/wsl.ts so the frontend count stays consistent with the backend deletion.
const TIMESTEP_RE = /^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$/;
const NON_TIMESTEP_DIRS = new Set(['0', 'system', 'constant', 'postProcessing']);

interface FileItem {
  name: string;
  path: string;
  isDir: boolean;
}

export default function FileEditor({ caseName }: { caseName: string }) {
  const { setActiveFile } = useCaseContext();
  // directories maps a relative dir path to its contents (array of FileItem).
  // First-level dirs: key = dir name (e.g. '0', 'system', 'constant', '0.5')
  // Nested dirs:     key = full relative path (e.g. 'constant/polyMesh')
  // Root-level files: key = '_root'
  const [directories, setDirectories] = useState<Record<string, FileItem[]>>({});
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(['0', 'system', 'constant']));
  const [loadedDirs, setLoadedDirs] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [newFileName, setNewFileName] = useState('');
  const [newFileDir, setNewFileDir] = useState('0');
  const [newDirName, setNewDirName] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [searchVisible, setSearchVisible] = useState(false);
  const [wordWrap, setWordWrap] = useState(true);
  const [searchMatches, setSearchMatches] = useState(0);

  // Cache of already-read files — avoids refetching from WSL when reopening a file.
  // The cache is invalidated when the file is saved (because the content changes).
  const fileCacheRef = useRef<Map<string, string>>(new Map());
  // Ref to loadFile so fetchCaseInfo's forced-refresh path can call it without a
  // forward-reference / dependency cycle (loadFile is defined below fetchCaseInfo).
  const loadFileRef = useRef<(filePath: string) => Promise<void>>(async () => {});
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const saveFileRef = useRef<() => Promise<void>>(async () => {});
  const toggleSelectionRef = useRef<(path: string) => void>(() => {});

  // Multi-select state
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [deletingTimesteps, setDeletingTimesteps] = useState(false);

  // Rename / move. The dialog edits the FULL relative path, so renaming a file
  // and moving it to another folder are the same operation — and there is no
  // ambiguity about what a '/' in the box means.
  const [renameTarget, setRenameTarget] = useState<{ path: string; isDir: boolean } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  // Radix animates the dialog out over ~150ms, and `renameTarget` is null by
  // then — long enough to see the title and the "Was …" hint blank out as it
  // fades. Keep the last one for the exit; `open` still follows renameTarget.
  const [closingRename, setClosingRename] = useState<{ path: string; isDir: boolean } | null>(null);
  const shownRename = renameTarget ?? closingRename;

  const closeRename = useCallback(() => {
    setClosingRename(renameTarget);
    setRenameTarget(null);
  }, [renameTarget]);

  // Scroll to top on mount
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }); }, []);

  // Ctrl+S / Cmd+S shortcut to save the current file
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (currentFile && !saving) {
          saveFileRef.current();
          toast.success('File saved (Ctrl+S)');
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentFile, saving]);

  // Ctrl+F shortcut to toggle search bar (only when a file is open)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        if (currentFile) {
          e.preventDefault();
          setSearchVisible(prev => {
            if (prev) setSearchTerm('');
            return !prev;
          });
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentFile]);

  // Compute search match count whenever search term or file content changes
  useEffect(() => {
    if (!searchTerm) { setSearchMatches(0); return; }
    const lines = fileContent.split('\n');
    let count = 0;
    for (const line of lines) {
      const lower = line.toLowerCase();
      const term = searchTerm.toLowerCase();
      let idx = 0;
      while ((idx = lower.indexOf(term, idx)) !== -1) { count++; idx++; }
    }
    setSearchMatches(count);
  }, [searchTerm, fileContent]);

  // ── Initial case info fetch (first-level only) ──
  // `force`: when true, wipes ALL client-side state (file content cache, lazy-loaded
  // subdirs, expanded dirs) so the tree is rebuilt from scratch on the next render.
  // This is what the "Refresh" button calls — a plain fetchCaseInfo() without force
  // would leave stale subdir listings and cached file contents in place, which is
  // why the button "didn't work well" (the tree visually didn't change).
  const fetchCaseInfo = useCallback(async (force = false) => {
    if (!caseName) return;
    if (force) {
      // Wipe everything so the next render refetches from WSL:
      //  - fileCacheRef: cached file CONTENTS (must be invalidated or reopening a
      //    file would show the old content even after an external edit)
      //  - loadedDirs: which subdirs have already been lazy-loaded (so they reload)
      //  - expandedDirs: collapse the tree to a clean state
      fileCacheRef.current.clear();
      setLoadedDirs(new Set());
      setExpandedDirs(new Set(['0', 'system', 'constant']));
      // If the currently-open file was edited externally, reload it from WSL too.
      if (currentFile) {
        fileCacheRef.current.delete(currentFile);
      }
    }
    setLoading(true);
    try {
      // cache: 'no-store' defeats any browser/intermediate HTTP cache so we always
      // hit the server (and thus WSL) on a forced refresh.
      const res = await fetch(`/api/cases?action=info&name=${encodeURIComponent(caseName)}`, {
        cache: force ? 'no-store' : 'default',
      });
      const data = await res.json();
      if (data.exists) {
        setDirectories(data.files || {});
        // Mark all first-level directories as loaded (they come from getCaseInfo)
        const topLevelKeys = Object.keys(data.files || {}).filter(k => k !== '_root');
        setLoadedDirs(new Set(topLevelKeys));
      }
    } catch { /* silent */ }
    setLoading(false);
    // On a forced refresh, also reload the currently-open file from WSL so the
    // textarea reflects any external edits (the cache was wiped above, so loadFile
    // will fetch fresh content instead of serving the stale cached version).
    if (force && currentFile) {
      // Reset the visible content first so the user sees the refresh happening.
      setFileContent('');
      setOriginalContent('');
      await loadFileRef.current(currentFile);
    }
  }, [caseName, currentFile]);

  useEffect(() => {
    fetchCaseInfo();
  }, [fetchCaseInfo]);

  // ── Lazy-load directory contents on demand ──
  const loadDirectory = useCallback(async (dirPath: string) => {
    if (!caseName) return;
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}?action=ls&path=${encodeURIComponent(dirPath)}`);
      const data = await res.json();
      if (data.items) {
        setDirectories(prev => ({ ...prev, [dirPath]: data.items }));
        setLoadedDirs(prev => new Set(prev).add(dirPath));
      }
    } catch { /* silent */ }
  }, [caseName]);

  const loadFile = async (filePath: string) => {
    if (multiSelectMode) {
      // In multi-select mode, toggle selection
      toggleSelectionRef.current(filePath);
      return;
    }
    // Check the cache first — if the file has already been read, show it instantly
    const cached = fileCacheRef.current.get(filePath);
    if (cached !== undefined) {
      setFileContent(cached);
      setOriginalContent(cached);
      setCurrentFile(filePath);
      setActiveFile({ path: filePath, content: cached });
      return; // cache hit — no loading spinner, no WSL call
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}?action=read&path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      const content = data.content || '';
      // Save in cache for future openings
      fileCacheRef.current.set(filePath, content);
      setFileContent(content);
      setOriginalContent(content);
      setCurrentFile(filePath);
      setActiveFile({ path: filePath, content });
    } catch {
      toast.error('Error loading');
    }
    setLoading(false);
  };

  // Keep loadFileRef in sync with loadFile on every render, so fetchCaseInfo's
  // forced-refresh path can call the latest loadFile without a forward reference.
  useEffect(() => {
    loadFileRef.current = loadFile;
  });

  const saveFile = async () => {
    if (!currentFile) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'write', path: currentFile, content: fileContent }),
      });
      if (res.ok) {
        setOriginalContent(fileContent);
        setActiveFile({ path: currentFile, content: fileContent });
        // Update the cache with the new content (invalidates the old version)
        fileCacheRef.current.set(currentFile, fileContent);
        toast.success(`Saved: ${currentFile}`);
        fetchCaseInfo();
      } else toast.error('Error saving');
    } catch { toast.error('Error saving'); }
    setSaving(false);
  };

  useEffect(() => { saveFileRef.current = saveFile; });

  const createNewFile = async () => {
    if (!newFileName.trim()) return;
    const dir = newFileDir === '__root__' ? '' : newFileDir;
    const filePath = dir ? `${dir}/${newFileName.trim()}` : newFileName.trim();
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'write', path: filePath, content: '' }),
      });
      if (res.ok) { toast.success(`Created: ${filePath}`); setNewFileName(''); fetchCaseInfo(); }
      else { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Error'); }
    } catch { toast.error('Error'); }
  };

  const createDirectory = async () => {
    if (!newDirName.trim()) return;
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mkdir', dirPath: newDirName.trim() }),
      });
      if (res.ok) { toast.success(`Folder: ${newDirName}`); setNewDirName(''); fetchCaseInfo(); }
    } catch { toast.error('Error'); }
  };

  const handleDeleteTimesteps = async () => {
    const tsDirs = allDirNames.filter(d => !NON_TIMESTEP_DIRS.has(d) && !d.startsWith('processor') && TIMESTEP_RE.test(d));
    if (tsDirs.length === 0) { toast.info('No timesteps to delete'); return; }
    if (!(await confirmDialog(`Delete ${tsDirs.length} timestep folders (all except 0/)?`, { title: 'Delete timesteps', confirmLabel: 'Delete', destructive: true }))) return;
    setDeletingTimesteps(true);
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deleteTimesteps' }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(data.message);
        fetchCaseInfo();
      } else toast.error('Error');
    } catch { toast.error('Error'); }
    setDeletingTimesteps(false);
  };

  const deleteSingle = async (path: string) => {
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deletePath', path }),
      });
      if (res.ok) {
        if (currentFile === path) { setCurrentFile(null); setFileContent(''); setOriginalContent(''); setActiveFile(null); }
        // Clear cache for any parent directory of the deleted item
        setDirectories(prev => {
          const next = { ...prev };
          // Remove the deleted item from its parent's listing
          for (const [dir, items] of Object.entries(next)) {
            if (dir === '_root') continue;
            const filtered = (items as FileItem[]).filter(i => !i.path.startsWith(path));
            if (filtered.length !== (items as FileItem[]).length) next[dir] = filtered;
          }
          return next;
        });
        // Invalidate cache for deleted path and any child
        setLoadedDirs(prev => { const n = new Set(prev); n.delete(path); return n; });
        setExpandedDirs(prev => {
          const n = new Set(prev);
          n.delete(path);
          return n;
        });
        toast.success(`Deleted: ${path}`);
        fetchCaseInfo();
      } else toast.error('Error');
    } catch { toast.error('Error'); }
  };

  const startRename = (path: string, isDir: boolean) => {
    setRenameTarget({ path, isDir });
    setRenameValue(path);
  };

  const doRename = async () => {
    if (!renameTarget) return;
    const from = renameTarget.path;
    const to = renameValue.trim().replace(/^\/+|\/+$/g, '');
    if (!to) { toast.error('Enter a name'); return; }
    if (to === from) { closeRename(); return; }

    setRenaming(true);
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename', path: from, newPath: to }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error || 'Rename failed'); return; }

      // The content did not change, so carry the cached text over to the new
      // path instead of making the next open go back to WSL for it.
      const cached = fileCacheRef.current.get(from);
      fileCacheRef.current.delete(from);
      if (cached !== undefined) fileCacheRef.current.set(to, cached);

      if (currentFile === from) {
        setCurrentFile(to);
        setActiveFile({ path: to, content: fileContent });
      } else if (currentFile && currentFile.startsWith(from + '/')) {
        // The open file lived inside a renamed folder.
        const moved = to + currentFile.slice(from.length);
        setCurrentFile(moved);
        setActiveFile({ path: moved, content: fileContent });
      }

      closeRename();
      toast.success(`Renamed: ${from} → ${to}`);
      // Forced refresh: both the old and the new parent listing changed, and a
      // renamed folder invalidates every cached path under it.
      await fetchCaseInfo(true);
    } catch {
      toast.error('Rename failed');
    } finally {
      setRenaming(false);
    }
  };

  const deleteSelected = async () => {
    if (selectedItems.size === 0) return;
    const items = Array.from(selectedItems);
    const label = items.length <= 3 ? items.join(', ') : `${items.length} items`;
    if (!(await confirmDialog(`Delete ${label}?`, { title: 'Delete selected', confirmLabel: 'Delete', destructive: true }))) return;

    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deleteBatch', paths: items }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(data.message);
        if (items.includes(currentFile || '')) { setCurrentFile(null); setFileContent(''); setOriginalContent(''); setActiveFile(null); }
        setSelectedItems(new Set());
        setMultiSelectMode(false);
        fetchCaseInfo();
      }
    } catch { toast.error('Error'); }
  };

  const toggleSelection = (path: string) => {
    const next = new Set(selectedItems);
    if (next.has(path)) next.delete(path); else next.add(path);
    setSelectedItems(next);
  };
  useEffect(() => { toggleSelectionRef.current = toggleSelection; });

  const toggleDirSelection = (dirPath: string) => {
    // Toggle selection for the directory itself (not its children)
    const next = new Set(selectedItems);
    if (next.has(dirPath)) {
      next.delete(dirPath);
    } else {
      // Remove any children of this dir from selection (they'd be redundant)
      const items = directories[dirPath] || [];
      items.forEach(item => next.delete(item.path));
      // Select the directory itself — deletePath uses rm -rf
      next.add(dirPath);
    }
    setSelectedItems(next);
  };

  const toggleDir = async (dirPath: string) => {
    const next = new Set(expandedDirs);
    if (next.has(dirPath)) {
      next.delete(dirPath);
      setExpandedDirs(next);
    } else {
      next.add(dirPath);
      setExpandedDirs(next);
      // Lazy-load directory contents if not yet fetched
      if (!loadedDirs.has(dirPath)) {
        setLoadingDirs(prev => new Set(prev).add(dirPath));
        await loadDirectory(dirPath);
        setLoadingDirs(prev => { const n = new Set(prev); n.delete(dirPath); return n; });
      }
    }
  };

  const isModified = fileContent !== originalContent;

  // Build top-level dir list
  const allDirNames = Object.keys(directories).filter(k => k !== '_root' && !k.includes('/'));
  const rootFileItems: FileItem[] = directories['_root'] || [];

  // Directories offered in the "new file" target picker: root + the standard
  // three (always available, even when empty — writeFile creates them on demand)
  // + every other first-level directory actually present in the case (e.g.
  // postProcessing, processor0, custom folders). Lets users create files in
  // the case root or any folder, not only 0/system/constant.
  const fileDirOptions = ['__root__', ...Array.from(new Set(['0', 'system', 'constant', ...allDirNames]))];

  // ── Recursive tree renderer ──
  // Renders items inside a directory at any depth.
  // dirPath: relative path of the parent directory (e.g. 'constant/polyMesh')
  // items:   children of that directory
  // depth:   nesting level (0 = first-level contents, 1 = inside sub-folder, …)
  const renderTreeItems = (dirPath: string, items: FileItem[], depth: number) => {
    // Sort: directories first, then files, each group alphabetically
    const sorted = [...items].sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name);
    });

    return sorted.map(item => {
      const itemPath = item.path; // full relative path within the case

      if (item.isDir) {
        // ── Directory node ──
        const isExpanded = expandedDirs.has(itemPath);
        const subItems = directories[itemPath] || [];
        const isLoading = loadingDirs.has(itemPath);
        // Determine if this is a first-level "standard" dir (special icon)
        const isStandardDir = depth === 0 && ['0', 'system', 'constant'].includes(item.name);

        return (
          <div key={itemPath}>
            <div className="flex items-center gap-0 group">
              {/* Multi-select checkbox */}
              {multiSelectMode && (() => {
                const isSel = selectedItems.has(itemPath);
                return (
                  <button className="p-0 hover:bg-accent rounded flex-shrink-0" onClick={() => toggleDirSelection(itemPath)}>
                    <div className={`w-3 h-3 rounded border ${isSel ? 'bg-primary border-primary' : 'border-muted-foreground'} flex items-center justify-center`}>
                      {isSel && <span className="text-[8px] text-primary-foreground leading-none">✓</span>}
                    </div>
                  </button>
                );
              })()}
              <button
                className="w-full flex items-center gap-1 rounded hover:bg-accent text-left text-sm"
                style={{ paddingLeft: `${8 + depth * 16}px`, paddingRight: '4px' }}
                onClick={() => toggleDir(itemPath)}
              >
                {isExpanded ? <ChevronDown className="w-3 h-3 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 flex-shrink-0" />}
                {isStandardDir ? (
                  <FolderPlus className="w-3.5 h-3.5 text-yellow-500 flex-shrink-0" />
                ) : (
                  <Folder className="w-3.5 h-3.5 text-yellow-600 flex-shrink-0" />
                )}
                <span className="font-medium truncate">{item.name}/</span>
                {subItems.length > 0 && (
                  <Badge variant="secondary" className="text-[10px] px-1 ml-auto flex-shrink-0">{subItems.length}</Badge>
                )}
              </button>
              {/* Rename works on any folder, standard ones included: a case can
                  legitimately need 0.orig, and moving a folder is a rename. */}
              <button
                type="button"
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity flex-shrink-0 mr-1"
                onClick={(e) => { e.stopPropagation(); startRename(itemPath, true); }}
                title="Rename or move folder"
                aria-label={`Rename folder ${item.name}`}
              >
                <Pencil className="w-3 h-3" />
              </button>
              {/* Delete button for directories (first-level non-standard get icon, nested dirs too) */}
              {(depth === 0 && !isStandardDir) || depth > 0 ? (
                <button
                  type="button"
                  className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 transition-opacity flex-shrink-0"
                  onClick={async (e) => { e.stopPropagation(); if (await confirmDialog(`Delete folder "${item.name}/" and all its contents?`, { title: 'Delete folder', confirmLabel: 'Delete', destructive: true })) deleteSingle(itemPath); }}
                  title="Delete folder"
                  aria-label={`Delete folder ${item.name}`}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              ) : null}
            </div>
            {/* Expanded children */}
            {isExpanded && isLoading && subItems.length === 0 && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground" style={{ paddingLeft: `${28 + depth * 16}px` }}>
                <Loader2 className="w-3 h-3 animate-spin" /> Loading…
              </div>
            )}
            {isExpanded && !isLoading && subItems.length > 0 && (
              <div className="space-y-0">
                {renderTreeItems(itemPath, subItems, depth + 1)}
              </div>
            )}
            {isExpanded && !isLoading && subItems.length === 0 && loadedDirs.has(itemPath) && (
              <div className="text-xs text-muted-foreground italic" style={{ paddingLeft: `${28 + depth * 16}px` }}>
                empty
              </div>
            )}
          </div>
        );
      } else {
        // ── File node ──
        const isSel = selectedItems.has(itemPath);
        return (
          <div key={itemPath} className="flex items-center gap-0 group">
            {multiSelectMode && (
              <button className="p-0 hover:bg-accent rounded flex-shrink-0" onClick={() => toggleSelection(itemPath)}>
                <div className={`w-3 h-3 rounded border ${isSel ? 'bg-primary border-primary' : 'border-muted-foreground'}`}>
                  {isSel && <span className="text-[8px] text-primary-foreground leading-none">✓</span>}
                </div>
              </button>
            )}
            <button
              className={`w-full flex items-center gap-1.5 rounded hover:bg-accent text-left text-xs flex-1 min-w-0 ${
                currentFile === itemPath ? 'bg-accent text-accent-foreground' : ''
              }`}
              style={{ paddingLeft: `${28 + depth * 16}px`, paddingRight: '4px' }}
              onClick={() => loadFile(itemPath)}
            >
              <FileText className="w-3 h-3 text-blue-400 flex-shrink-0" />
              <span className="truncate">{item.name}</span>
            </button>
            <button
              type="button"
              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity flex-shrink-0 mr-1"
              onClick={(e) => { e.stopPropagation(); startRename(itemPath, false); }}
              title="Rename or move file"
              aria-label={`Rename ${item.name}`}
            >
              <Pencil className="w-3 h-3" />
            </button>
            <Trash2
              className="w-3 h-3 opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 transition-opacity flex-shrink-0 cursor-pointer"
              onClick={(e) => { e.stopPropagation(); deleteSingle(itemPath); }}
            />
          </div>
        );
      }
    });
  };

  return (
    <div className="flex gap-3 h-full" style={{ minHeight: '600px' }}>
      {/* ═══ File Tree Sidebar ═══ */}
      <Card className="w-72 flex-shrink-0 flex flex-col">
        <div className="px-2 pt-2 pb-0 flex items-center gap-1">
          <Button
            size="sm" variant="destructive" className="h-6 text-[10px] px-2"
            disabled={deletingTimesteps}
            onClick={handleDeleteTimesteps}
            title="Delete all timestep folders except 0/"
          >
            <Timer className="w-3 h-3 mr-0.5" />{deletingTimesteps ? '...' : 'Clean TS'}
          </Button>
          <Button
            size="sm" variant={multiSelectMode ? 'default' : 'ghost'}
            className="h-6 w-6 p-0"
            title="Multi-select mode"
            onClick={() => { setMultiSelectMode(!multiSelectMode); if (multiSelectMode) setSelectedItems(new Set()); }}
          >
            {multiSelectMode ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
          </Button>
        </div>

        <div className="px-2 pb-0.5">
          <CardTitle className="text-sm flex items-center gap-1">
            <FolderTree className="w-4 h-4" /> <span className="truncate">{caseName}</span>
            <button
              className="ml-auto p-0.5 rounded hover:bg-accent transition-colors"
              onClick={() => fetchCaseInfo(true)}
              title="Refresh files (force reload)"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-muted-foreground hover:text-foreground ${loading ? 'animate-spin' : ''}`} />
            </button>
          </CardTitle>
        </div>

        {/* Multi-select action bar */}
        {multiSelectMode && selectedItems.size > 0 && (
          <div className="mx-2 mb-1 p-1.5 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded flex items-center gap-1.5">
            <Badge variant="destructive" className="text-[10px]">{selectedItems.size} selected</Badge>
            <Button size="sm" variant="destructive" className="h-6 text-[10px] px-2 flex-1"
              onClick={deleteSelected}>
              <Trash2 className="w-3 h-3 mr-0.5" /> Delete
            </Button>
            <Button size="sm" variant="ghost" className="h-6 w-6 p-0"
              onClick={() => { setSelectedItems(new Set()); }}>
              <XCircle className="w-3 h-3" />
            </Button>
          </div>
        )}

        <CardContent className="p-0 flex-1 overflow-hidden">
          <ScrollArea className="h-full" style={{ maxHeight: 'calc(100vh - 300px)' }}>
            <div className="px-2 py-1 space-y-0">
              {/* Standard directories rendered first (0, system, constant) */}
              {['0', 'system', 'constant']
                .filter(d => allDirNames.includes(d))
                .map(d => {
                  const items = directories[d] || [];
                  return (
                    <div key={d}>
                      {/* Dir header */}
                      <div className="flex items-center gap-0">
                        {multiSelectMode && (
                          <button className="p-0 hover:bg-accent rounded" onClick={() => toggleDirSelection(d)}>
                            <div className="w-3 h-3 rounded border border-muted-foreground" />
                          </button>
                        )}
                        <button
                          className="w-full flex items-center gap-1 px-2 py-0.5 rounded hover:bg-accent text-left text-sm"
                          onClick={() => toggleDir(d)}
                        >
                          {expandedDirs.has(d) ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                          <FolderPlus className="w-3.5 h-3.5 text-yellow-500" />
                          <span className="font-medium">{d}/</span>
                          <Badge variant="secondary" className="text-[10px] px-1 ml-auto">{items.length}</Badge>
                        </button>
                      </div>
                      {/* Recursive children (sub-dirs are expandable!) */}
                      {expandedDirs.has(d) && (
                        <>
                          {loadingDirs.has(d) && items.length === 0 && (
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground ml-5">
                              <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                            </div>
                          )}
                          {items.length > 0 && (
                            <div className="space-y-0">
                              {renderTreeItems(d, items, 1)}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}

              {/* Other directories (timesteps, processor*, etc.) — sorted numerically then alphabetically */}
              {allDirNames
                .filter(d => !['0', 'system', 'constant'].includes(d))
                .sort((a, b) => {
                  const aNum = parseFloat(a);
                  const bNum = parseFloat(b);
                  if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
                  if (!isNaN(aNum)) return -1;
                  if (!isNaN(bNum)) return 1;
                  return a.localeCompare(b);
                })
                .map((dir) => {
                  const items = directories[dir] || [];
                  const isSel = selectedItems.has(dir);
                  return (
                    <div key={`other-${dir}`}>
                      <div className="flex items-center gap-0 group">
                        {multiSelectMode && (
                          <button className="p-0 hover:bg-accent rounded" onClick={() => toggleSelection(dir)}>
                            <div className={`w-3 h-3 rounded border ${isSel ? 'bg-primary border-primary' : 'border-muted-foreground'}`}>
                              {isSel && <span className="text-[8px] text-primary-foreground leading-none">✓</span>}
                            </div>
                          </button>
                        )}
                        <button
                          className="w-full flex items-center gap-1 px-2 py-0.5 rounded hover:bg-accent text-left text-sm"
                          onClick={() => toggleDir(dir)}
                        >
                          {expandedDirs.has(dir) ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                          <Folder className="w-3.5 h-3.5 text-yellow-600" />
                          <span className="font-medium truncate">{dir}/</span>
                          <Badge variant="secondary" className="text-[10px] px-1 ml-auto">{items.length}</Badge>
                        </button>
                        <button
                          type="button"
                          className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 transition-opacity flex-shrink-0"
                          onClick={async (e) => { e.stopPropagation(); if (await confirmDialog(`Delete folder "${dir}/" and all its contents?`, { title: 'Delete folder', confirmLabel: 'Delete', destructive: true })) deleteSingle(dir); }}
                          title="Delete folder"
                          aria-label={`Delete folder ${dir}`}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      {/* Recursive children (sub-dirs are expandable!) */}
                      {expandedDirs.has(dir) && (
                        <>
                          {loadingDirs.has(dir) && items.length === 0 && (
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground ml-5">
                              <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                            </div>
                          )}
                          {items.length > 0 && (
                            <div className="space-y-0">
                              {renderTreeItems(dir, items, 1)}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}

              {/* Root files */}
              {rootFileItems.length > 0 && (
                <div>
                  <div className="px-2 py-0.5 text-xs text-muted-foreground font-medium">Root files</div>
                  {rootFileItems.map((item: FileItem) => {
                    const isSel = selectedItems.has(item.path);
                    return (
                      <div key={item.path} className="flex items-center gap-0 group">
                        {multiSelectMode && (
                          <button className="p-0 hover:bg-accent rounded" onClick={() => toggleSelection(item.path)}>
                            <div className={`w-3 h-3 rounded border ${isSel ? 'bg-primary border-primary' : 'border-muted-foreground'}`}>
                              {isSel && <span className="text-[8px] text-primary-foreground leading-none">✓</span>}
                            </div>
                          </button>
                        )}
                        <button
                          className={`w-full flex items-center gap-1 px-2 py-0.5 rounded hover:bg-accent text-left text-xs flex-1 min-w-0 ${
                            currentFile === item.path ? 'bg-accent text-accent-foreground' : ''
                          }`}
                          onClick={() => loadFile(item.path)}
                        >
                          <File className="w-3 h-3" />
                          <span className="truncate">{item.name}</span>
                        </button>
                        <Trash2
                          className="w-3 h-3 opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 transition-opacity flex-shrink-0 cursor-pointer"
                          onClick={(e) => { e.stopPropagation(); deleteSingle(item.path); }}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </ScrollArea>
        </CardContent>

        {/* New file/dir creation */}
        <div className="border-t p-2 space-y-2">
          <div className="flex gap-1">
            <Select value={newFileDir} onValueChange={setNewFileDir}>
              <SelectTrigger className="h-7 text-xs w-24"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__root__">(root)</SelectItem>
                {fileDirOptions.filter(o => o !== '__root__').map(d => (
                  <SelectItem key={d} value={d}>{d}/</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input value={newFileName} onChange={(e) => setNewFileName(e.target.value)}
              placeholder="name or subdir/file..." className="h-7 text-xs"
              onKeyDown={(e) => e.key === 'Enter' && createNewFile()} />
            <Button size="sm" className="h-7 w-7 p-0" onClick={createNewFile}><Plus className="w-3 h-3" /></Button>
          </div>
          <div className="flex gap-1">
            <Input value={newDirName} onChange={(e) => setNewDirName(e.target.value)}
              placeholder="new folder..." className="h-7 text-xs"
              onKeyDown={(e) => e.key === 'Enter' && createDirectory()} />
            <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={createDirectory}>
              <FolderPlus className="w-3 h-3" />
            </Button>
          </div>
        </div>
      </Card>

      {/* ═══ Editor Area ═══ */}
      <Card className="flex-1 flex flex-col min-w-0">
        {currentFile ? (
          <>
            <div className="flex items-center justify-between px-4 py-2 border-b">
              <div className="flex items-center gap-2">
                <FileCode className="w-4 h-4 text-primary" />
                <span className="font-mono text-sm font-medium">{caseName}/{currentFile}</span>
                {isModified && <Badge variant="secondary" className="text-[10px] text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/30">modified</Badge>}
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => currentFile && startRename(currentFile, false)} title="Rename or move this file">
                  <Pencil className="w-3 h-3 mr-1" /> Rename
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setFileContent(originalContent); toast.info('Changes discarded'); }}>
                  <RotateCcw className="w-3 h-3 mr-1" /> Undo
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(fileContent); toast.success('Copied'); }}>
                  <Copy className="w-3 h-3" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setWordWrap(w => !w)} title="Toggle word wrap">
                  <WrapText className="w-3 h-3" />
                </Button>
                <Button size="sm" onClick={saveFile} disabled={saving || !isModified}>
                  <Save className="w-3 h-3 mr-1" /> Save
                </Button>
              </div>
            </div>
            {searchVisible && currentFile && (
              <div className="px-3 py-1.5 border-b bg-muted/30 flex items-center gap-2">
                <Search className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                <input
                  autoFocus
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search in file..."
                  className="flex-1 text-xs font-mono bg-transparent focus:outline-none placeholder:text-muted-foreground/50"
                />
                {searchTerm && (
                  <span className="text-[10px] text-muted-foreground flex-shrink-0">{searchMatches} results</span>
                )}
                <button onClick={() => { setSearchVisible(false); setSearchTerm(''); }} className="p-0.5 hover:bg-muted rounded">
                  <X className="w-3 h-3 text-muted-foreground" />
                </button>
              </div>
            )}
            <div className="flex-1 overflow-hidden relative">
              <div className="absolute inset-0 flex">
                <div
                  ref={lineNumbersRef}
                  className="flex-shrink-0 w-12 py-3 px-2 text-right select-none border-r bg-muted/30 overflow-hidden"
                >
                  {fileContent.split('\n').map((_, i) => (
                    <div key={i} className="text-xs leading-5 text-muted-foreground font-mono">{i + 1}</div>
                  ))}
                </div>
                <textarea
                  value={fileContent} onChange={(e) => setFileContent(e.target.value)}
                  onScroll={(e) => {
                    if (lineNumbersRef.current) {
                      lineNumbersRef.current.scrollTop = e.currentTarget.scrollTop;
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Tab') {
                      e.preventDefault();
                      const ta = e.currentTarget;
                      const start = ta.selectionStart;
                      const end = ta.selectionEnd;

                      if (e.shiftKey) {
                        // Shift+Tab: outdent (remove up to 4 leading spaces on current line)
                        const lineStart = fileContent.lastIndexOf('\n', start - 1) + 1;
                        const removeCount = Math.min(
                          (fileContent.substring(lineStart, start).match(/^ */) || [''])[0].length,
                          4
                        );
                        if (removeCount > 0) {
                          const updated = fileContent.substring(0, lineStart) + fileContent.substring(lineStart + removeCount);
                          setFileContent(updated);
                          requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start - removeCount; });
                        }
                      } else {
                        // Tab: insert 4 spaces
                        const spaces = '    ';
                        const updated = fileContent.substring(0, start) + spaces + fileContent.substring(end);
                        setFileContent(updated);
                        requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + spaces.length; });
                      }
                    }
                  }}
                  className={`flex-1 p-3 font-mono text-xs leading-5 bg-transparent resize-none focus:outline-none min-h-full ${wordWrap ? 'whitespace-pre-wrap' : 'whitespace-pre overflow-x-auto'}`}
                  spellCheck={false} style={{ tabSize: 4, whiteSpace: wordWrap ? 'pre-wrap' : 'pre' }}
                />
              </div>
            </div>
            <div className="px-4 py-1.5 border-t text-xs text-muted-foreground flex justify-between">
              <span>{fileContent.split('\n').length} lines | {fileContent.length} characters</span>
              <span className={isModified ? 'text-amber-500' : 'text-green-500'}>
                {isModified ? 'Not saved' : 'Saved'}
              </span>
            </div>
          </>
        ) : multiSelectMode ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <CheckSquare className="w-16 h-16 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Multi-select mode active</p>
              <p className="text-xs mt-1">Click files and folders to select them, then &quot;Delete&quot;</p>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <FileCode className="w-16 h-16 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Select a file from the tree to edit its content</p>
              <p className="text-xs mt-1">Or create a new file using the panel below</p>
            </div>
          </div>
        )}
      </Card>

      {/* ═══ Rename / move ═══ */}
      <Dialog open={renameTarget !== null} onOpenChange={(open) => { if (!open) closeRename(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Rename {shownRename?.isDir ? 'folder' : 'file'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-1">
            <div>
              <Label className="text-xs">Path, relative to the case</Label>
              <Input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => { if (e.key === 'Enter' && !renaming) void doRename(); }}
                className="font-mono text-sm mt-0.5"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Was <span className="font-mono">{shownRename?.path}</span>. Changing the folder part
                moves it; an existing destination is refused.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={closeRename} disabled={renaming}>Cancel</Button>
              <Button onClick={doRename} disabled={renaming || !renameValue.trim() || renameValue.trim() === renameTarget?.path}>
                {renaming ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Renaming…</> : <><Pencil className="w-3 h-3 mr-1" /> Rename</>}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

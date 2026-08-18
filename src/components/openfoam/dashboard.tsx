'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import {
  Box, Trash2, FolderOpen, RefreshCw, Settings, Play, Terminal as TerminalIcon,
  CheckCircle2, XCircle, Activity, Terminal, ChevronRight,
  AlertTriangle, Copy, BookOpen, FolderTree, HardDrive, Clock,
  FileText, Zap, GitBranch, Pencil, Loader2
} from 'lucide-react';

interface WslStatus {
  running: boolean; name: string; error?: string;
  version?: string; runDir?: string; tutorialDir?: string; env?: string; processes?: string; distros?: string[];
  cases?: CaseSummary[];
}

interface CaseSummary {
  name: string;
  dirs: string[];
  fileCount: Record<string, number>;
  timeStepCount: number;
  lastTimeStep: string;
  hasLog: boolean;
  logFiles: string[];
}

interface TutorialCategory { name: string; path: string; }
interface TutorialCase { name: string; fullPath: string; }

export default function Dashboard({
  selectedCase, onSelectCase, onRefresh
}: {
  selectedCase: string | null; onSelectCase: (name: string) => void; onRefresh: () => void;
}) {
  const [status, setStatus] = useState<WslStatus | null>(null);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [distroInput, setDistroInput] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  // OpenFOAM version selection (replaces the old Ubuntu distro selector).
  const [foamVersions, setFoamVersions] = useState<{ version: string; bashrcPath: string; installDir: string }[]>([]);
  const [selectedFoamBashrc, setSelectedFoamBashrc] = useState<string | null>(null);
  const [switchingFoam, setSwitchingFoam] = useState(false);
  const [switchingFoamBashrc, setSwitchingFoamBashrc] = useState<string | null>(null);
  const [loadingFoamVersions, setLoadingFoamVersions] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newCaseName, setNewCaseName] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  // Tutorials state
  const [tutCategories, setTutCategories] = useState<TutorialCategory[]>([]);
  const [tutDir, setTutDir] = useState('');
  const [selectedTutCat, setSelectedTutCat] = useState<string | null>(null);
  const [tutCases, setTutCases] = useState<TutorialCase[]>([]);
  const [tutLoading, setTutLoading] = useState(false);
  const [copyingTut, setCopyingTut] = useState<string | null>(null);
  const [copyDialogCase, setCopyDialogCase] = useState<TutorialCase | null>(null);
  const [copyNewName, setCopyNewName] = useState('');

  // Clone case state
  const [cloneDialogCase, setCloneDialogCase] = useState<string | null>(null);
  const [cloneNewName, setCloneNewName] = useState('');
  const [cloningCase, setCloningCase] = useState<string | null>(null);

  // Rename case state
  const [renameDialogCase, setRenameDialogCase] = useState<string | null>(null);
  const [renameNewName, setRenameNewName] = useState('');
  const [renamingCase, setRenamingCase] = useState<string | null>(null);

  // Cache to avoid unnecessary re-fetches — stores the last fetch timestamp
  const lastFetchRef = useRef<{ status: number; tutorials: number }>({ status: 0, tutorials: 0 });
  const STATUS_CACHE_MS = 2000; // don't refetch status if done < 2s ago

  // Single fetch: only fullStatus (already includes batch cases in a single WSL call).
  const fetchAll = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && now - lastFetchRef.current.status < STATUS_CACHE_MS) return;
    lastFetchRef.current.status = now;
    try {
      const statusRes = await fetch('/api/wsl?action=fullStatus');
      const statusData = await statusRes.json();
      setStatus(statusData);
      // fullStatus already includes cases (from getQuickStatus → listCasesBatch)
      const casesList = (Array.isArray(statusData.cases)
        ? statusData.cases
        : []) as CaseSummary[];
      setCases(casesList);
      if (statusData.name) setDistroInput(statusData.name);
    } catch {
      setStatus({ running: false, name: '', error: 'Cannot connect to WSL' });
    }
  }, []);

  const fetchTutorials = useCallback(async () => {
    try {
      const res = await fetch('/api/tutorials?action=categories');
      const data = await res.json();
      setTutCategories(data.categories || []);
      setTutDir(data.tutorialDir || '');
    } catch {}
  }, []);

  const fetchTutorialCases = async (category: string) => {
    setTutLoading(true);
    setSelectedTutCat(category);
    try {
      const res = await fetch(`/api/tutorials?action=cases&category=${encodeURIComponent(category)}`);
      const data = await res.json();
      setTutCases(data.cases || []);
    } catch { setTutCases([]); }
    setTutLoading(false);
  };

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await fetchAll();
      setLoading(false);
    };
    init();
  }, [fetchAll]);

  useEffect(() => {
    if (status?.running) fetchTutorials();
  }, [status?.running, fetchTutorials]);

  const handleSetDistro = async () => {
    if (!distroInput.trim()) return;
    try {
      const response = await fetch(`/api/wsl?action=setDistro&name=${encodeURIComponent(distroInput.trim())}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to select the distro');
      setLoading(true);
      lastFetchRef.current.status = 0;
      await fetchAll(true);
      setLoading(false);
      setShowSettings(false);
      toast.success(`Distro: ${data.distro}`);
    } catch (error) {
      setLoading(false);
      toast.error(error instanceof Error ? error.message : 'Unable to select the distro');
    }
  };

  // Fetch all installed OpenFOAM versions (for the settings dialog).
  const fetchFoamVersions = useCallback(async () => {
    setLoadingFoamVersions(true);
    try {
      const res = await fetch('/api/wsl?action=foamVersions');
      const data = await res.json();
      setFoamVersions(data.versions || []);
      setSelectedFoamBashrc(data.selectedBashrc || null);
    } catch {
      setFoamVersions([]);
    }
    setLoadingFoamVersions(false);
  }, []);

  // Select an OpenFOAM version — resets all server caches and refreshes.
  const handleSetFoamVersion = async (bashrcPath: string, versionLabel: string) => {
    setSwitchingFoam(true);
    setSwitchingFoamBashrc(bashrcPath);
    try {
      const res = await fetch(`/api/wsl?action=setFoamVersion&bashrc=${encodeURIComponent(bashrcPath)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      setSelectedFoamBashrc(bashrcPath);
      toast.success(`OpenFOAM ${data.version || versionLabel} active — ${data.runDir || 'run dir updated'}`);
      // Notify other components (e.g. CommandPanel) that the active OpenFOAM
      // version changed, so they can re-fetch version-filtered data.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('foam-version-changed', { detail: { version: data.version } }));
      }
      // Full refresh: cases AND tutorials must follow the new version.
      // fetchAll refreshes cases + status; fetchTutorials refreshes the
      // tutorial categories + tutorial dir (which change with the version).
      // Without explicitly calling fetchTutorials here, the tutorial list
      // would stay stale until the user clicks Refresh manually.
      setLoading(true);
      lastFetchRef.current.status = 0;
      await fetchAll(true);
      await fetchTutorials();
      setLoading(false);
      setShowSettings(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Error switching version');
    }
    setSwitchingFoam(false);
    setSwitchingFoamBashrc(null);
  };

  const handleCreateCase = async () => {
    if (!newCaseName.trim()) { toast.error('Enter a name'); return; }
    if (newCaseName.includes(' ')) { toast.error('No spaces in the name'); return; }
    const name = newCaseName.trim();
    setCreating(true);
    // Optimistic UI: immediately add the case to the list (empty), then confirm with fetch
    const optimisticCase: CaseSummary = {
      name, dirs: ['0', 'system', 'constant'], fileCount: { '0': 0, system: 0, constant: 0 },
      timeStepCount: 0, lastTimeStep: '', hasLog: false, logFiles: [],
    };
    setCases(prev => [...prev, optimisticCase]);
    setNewCaseName('');
    try {
      const res = await fetch('/api/cases', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', caseName: name }),
      });
      if (res.ok) {
        toast.success(`"${name}" created`);
        await fetchAll(true); onRefresh();
      } else {
        // Rollback: remove the optimistic case
        setCases(prev => prev.filter(c => c.name !== name));
        const data = await res.json();
        toast.error(data.error || 'Error');
      }
    } catch {
      setCases(prev => prev.filter(c => c.name !== name));
      toast.error('WSL error');
    }
    setCreating(false);
  };

  const handleDeleteCase = async (name: string) => {
    setDeleting(name);
    // Optimistic UI: immediately remove the case from the list, then confirm with fetch
    const prevCases = cases;
    setCases(prev => prev.filter(c => c.name !== name));
    try {
      const res = await fetch('/api/cases', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', caseName: name }),
      });
      if (res.ok) {
        if (selectedCase === name) onSelectCase('');
        toast.success(`"${name}" deleted`);
        await fetchAll(true); onRefresh();
      } else {
        // Rollback: restore the case
        setCases(prevCases);
        toast.error('Error');
      }
    } catch { toast.error('Error'); }
    setDeleting(null);
  };

  const handleCopyTutorial = async (tutorialPath: string, newName: string) => {
    if (!newName.trim()) { toast.error('Enter a name'); return; }
    if (newName.includes(' ')) { toast.error('No spaces in the name'); return; }
    setCopyingTut(tutorialPath);
    try {
      const res = await fetch('/api/tutorials', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'copy', tutorialPath, newCaseName: newName.trim() }),
      });
      if (res.ok) {
        toast.success(`Tutorial copied as "${newName.trim()}"`);
        setCopyDialogCase(null);
        await fetchAll(true); onRefresh();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Copy error');
      }
    } catch { toast.error('WSL error'); }
    setCopyingTut(null);
  };

  const handleCloneCase = async (sourceName: string, newName: string) => {
    if (!newName.trim()) { toast.error('Enter a name'); return; }
    if (newName.includes(' ')) { toast.error('No spaces in the name'); return; }
    setCloningCase(sourceName);
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(sourceName)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clone', newName: newName.trim() }),
      });
      if (res.ok) {
        toast.success(`"${sourceName}" cloned as "${newName.trim()}"`);
        setCloneDialogCase(null);
        await fetchAll(true); onRefresh();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Clone error');
      }
    } catch { toast.error('WSL error'); }
    setCloningCase(null);
  };

  // Rename a case: atomic mv on the server side. If the renamed case was the
  // currently-selected one, update the selection so the editor/monitor follow.
  const handleRenameCase = async (oldName: string, newName: string) => {
    if (!newName.trim()) { toast.error('Enter a name'); return; }
    if (newName.includes(' ')) { toast.error('No spaces in the name'); return; }
    if (newName.trim() === oldName) { setRenameDialogCase(null); return; }
    setRenamingCase(oldName);
    try {
      const res = await fetch('/api/cases', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename', caseName: oldName, newName: newName.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(`"${oldName}" renamed to "${data.caseName}"`);
        // If the renamed case was open, switch the selection to the new name
        if (selectedCase === oldName) onSelectCase(data.caseName);
        setRenameDialogCase(null);
        await fetchAll(true); onRefresh();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Rename error');
      }
    } catch { toast.error('WSL error'); }
    setRenamingCase(null);
  };

  const handleRefresh = async () => {
    setLoading(true);
    await fetchAll(true);
    await fetchTutorials();
    setLoading(false);
    onRefresh();
  };

  // Skeleton loading state
  if (loading && !status) {
    return (
      <div className="space-y-3">
        {/* WSL Status skeleton */}
        <Card className="p-3">
          <div className="flex items-center gap-3">
            <Skeleton className="w-5 h-5 rounded-full" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-32 ml-auto" />
          </div>
        </Card>
        {/* Cases grid skeleton */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="p-4">
              <Skeleton className="h-5 w-3/4 mb-3" />
              <div className="space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-3 w-2/3" />
              </div>
              <div className="flex gap-2 mt-3">
                <Skeleton className="h-5 w-12" />
                <Skeleton className="h-5 w-12" />
              </div>
            </Card>
          ))}
        </div>
        {/* Tutorials skeleton */}
        <Card className="p-4">
          <Skeleton className="h-5 w-40 mb-3" />
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-24 rounded-full" />
            ))}
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* ══ WSL Status Bar (compact) ══ */}
      <Card className={status?.running ? 'border-green-500/50 bg-green-950/20' : 'border-red-500/50 bg-red-950/20'}>
        <CardContent className="p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {status?.running ? <CheckCircle2 className="w-5 h-5 text-green-500 flex-shrink-0" /> : <XCircle className="w-5 h-5 text-red-500 flex-shrink-0" />}
              <div className="min-w-0">
                <span className="font-mono text-sm font-semibold">{status?.name || 'N/A'}</span>
                {status?.running && (
                  <span className="text-xs text-muted-foreground ml-2">
                    OF {status.version} | {cases.length} cases
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {status?.running && (
                <Badge variant="secondary" className="text-[10px] font-mono hidden sm:inline-flex">
                  {status.runDir?.split('/').slice(-2).join('/')}
                </Badge>
              )}
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleRefresh} disabled={loading}>
                <RefreshCw className={`w-3 h-3 mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setShowSettings(true); fetchFoamVersions(); }}>
                <Settings className="w-3 h-3" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Settings Dialog — OpenFOAM version selection */}
      <Dialog open={showSettings} onOpenChange={setShowSettings}>
        <DialogContent>
          <DialogHeader><DialogTitle>OpenFOAM Version</DialogTitle></DialogHeader>
          <div className="space-y-4 pt-2">
            <p className="text-sm text-muted-foreground">
              Select which version of OpenFOAM to use. All paths (installation, cases, tutorials) will be updated automatically.
            </p>
            <div className="flex flex-wrap gap-2">
              {foamVersions.map((v) => {
                const isActive = v.bashrcPath === selectedFoamBashrc;
                return (
                  <Button
                    key={v.bashrcPath}
                    variant={isActive ? 'default' : 'outline'}
                    className="text-sm px-4 py-2"
                    disabled={switchingFoam}
                    onClick={() => handleSetFoamVersion(v.bashrcPath, v.version)}
                  >
                    {switchingFoam && switchingFoamBashrc === v.bashrcPath ? (
                      <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
                    ) : null}
                    OpenFOAM {v.version}
                  </Button>
                );
              })}
            </div>
            {foamVersions.length === 0 && !loadingFoamVersions && (
              <p className="text-xs text-muted-foreground italic">
                No OpenFOAM version found. Verify that OpenFOAM is installed in /opt, /usr/lib or /usr/local.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ══ Main Content ══ */}
      {status?.running && (
        <Tabs defaultValue="cases" className="space-y-3">
          <div className="flex items-center justify-between">
            <TabsList>
              <TabsTrigger value="cases" className="text-xs">
                <Box className="w-3 h-3 mr-1" /> Cases ({cases.length})
              </TabsTrigger>
              <TabsTrigger value="tutorials" className="text-xs">
                <BookOpen className="w-3 h-3 mr-1" /> Tutorial
              </TabsTrigger>
            </TabsList>
          </div>

          {/* ══ MY CASES — simple and fast list ══ */}
          <TabsContent value="cases" className="space-y-2">
            {/* Create new case inline */}
            <div className="flex gap-2">
              <Input
                value={newCaseName} onChange={(e) => setNewCaseName(e.target.value)}
                placeholder="New case..." className="flex-1 font-mono h-8 text-xs"
                onKeyDown={(e) => e.key === 'Enter' && handleCreateCase()}
              />
              <Button onClick={handleCreateCase} disabled={creating || !newCaseName.trim()} size="sm" className="h-8 text-xs">
                <FolderOpen className="w-3 h-3 mr-1" /> Create
              </Button>
            </div>

            {cases.length === 0 ? (
              <Card className="p-6 text-center text-muted-foreground">
                <FolderOpen className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No cases in $FOAM_RUN</p>
              </Card>
            ) : (
              <div className="space-y-1">
                {cases.map(c => (
                  <div
                    key={c.name}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-all hover:bg-accent/50 ${
                      selectedCase === c.name ? 'bg-accent ring-1 ring-primary/50' : ''
                    }`}
                    onClick={() => onSelectCase(c.name)}
                  >
                    {/* Icon + Name */}
                    <Box className="w-4 h-4 text-primary flex-shrink-0" />
                    <span className="font-mono text-sm font-medium truncate flex-1 min-w-0">{c.name}</span>

                    {/* Badges: file counts */}
                    <div className="hidden sm:flex items-center gap-1.5 flex-shrink-0">
                      {c.fileCount['0'] > 0 && (
                        <Badge variant="outline" className="text-[9px] h-5 px-1.5 text-orange-600 border-orange-300">
                          0/ {c.fileCount['0']}
                        </Badge>
                      )}
                      {c.fileCount.system > 0 && (
                        <Badge variant="outline" className="text-[9px] h-5 px-1.5 text-blue-600 border-blue-300">
                          sys {c.fileCount.system}
                        </Badge>
                      )}
                      {c.fileCount.constant > 0 && (
                        <Badge variant="outline" className="text-[9px] h-5 px-1.5 text-green-600 border-green-300">
                          con {c.fileCount.constant}
                        </Badge>
                      )}
                      {c.timeStepCount > 0 && (
                        <Badge variant="secondary" className="text-[9px] h-5 px-1.5">
                          <Clock className="w-2.5 h-2.5 mr-0.5" /> {c.timeStepCount}ts
                          {c.lastTimeStep && <span className="ml-0.5 opacity-60">→{c.lastTimeStep}</span>}
                        </Badge>
                      )}
                      {c.hasLog && (
                        <Badge variant="secondary" className="text-[9px] h-5 px-1.5 bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                          <FileText className="w-2.5 h-2.5 mr-0.5" /> log
                        </Badge>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex gap-0.5 flex-shrink-0">
                      <Button
                        size="sm" variant="ghost" className="h-7 w-7 p-0 text-primary"
                        onClick={(e) => { e.stopPropagation(); onSelectCase(c.name); }}
                      >
                        <Terminal className="w-3 h-3" />
                      </Button>
                      <Button
                        size="sm" variant="ghost" className="h-7 w-7 p-0 text-blue-500 hover:text-blue-700 hover:bg-blue-50"
                        onClick={(e) => { e.stopPropagation(); setCloneDialogCase(c.name); setCloneNewName(c.name + '_copy'); }}
                        title="Clone case"
                      >
                        <GitBranch className="w-3 h-3" />
                      </Button>
                      <Button
                        size="sm" variant="ghost" className="h-7 w-7 p-0 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                        onClick={(e) => { e.stopPropagation(); setRenameDialogCase(c.name); setRenameNewName(c.name); }}
                        title="Rename case"
                      >
                        <Pencil className="w-3 h-3" />
                      </Button>
                      <Button
                        size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                        onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${c.name}"?`)) handleDeleteCase(c.name); }}
                        disabled={deleting === c.name}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* ══ TUTORIALS TAB ══ */}
          <TabsContent value="tutorials">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3" style={{ minHeight: '400px' }}>
              <Card className="flex flex-col">
                <CardHeader className="pb-2 pt-3 px-3">
                  <CardTitle className="text-sm flex items-center gap-1">
                    <BookOpen className="w-4 h-4" /> Categories
                    <Badge variant="secondary" className="ml-auto text-[10px]">{tutCategories.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0 flex-1 overflow-hidden">
                  <ScrollArea className="h-full">
                    <div className="p-2 space-y-0.5">
                      {tutCategories.map((cat) => (
                        <button
                          key={cat.path}
                          className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-accent transition-colors flex items-center justify-between ${
                            selectedTutCat === cat.path ? 'bg-accent font-medium' : ''
                          }`}
                          onClick={() => fetchTutorialCases(cat.path)}
                        >
                          <span className="truncate font-mono">{cat.name}</span>
                          <ChevronRight className="w-3 h-3 flex-shrink-0 ml-1 text-muted-foreground" />
                        </button>
                      ))}
                    </div>
                  </ScrollArea>
                </CardContent>
              </Card>

              <Card className="md:col-span-2 flex flex-col">
                <CardHeader className="pb-2 pt-3 px-3">
                  <CardTitle className="text-sm flex items-center gap-1">
                    {selectedTutCat ? (
                      <>Tutorial: <span className="font-mono text-primary">{selectedTutCat}</span></>
                    ) : 'Select a category'}
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0 flex-1 overflow-hidden">
                  <ScrollArea className="h-full">
                    <div className="p-2 space-y-1">
                      {tutLoading && <div className="text-xs text-muted-foreground p-2 animate-pulse">Loading...</div>}
                      {!selectedTutCat && !tutLoading && (
                        <div className="text-xs text-muted-foreground p-4 text-center">
                          Select a category to copy a tutorial.
                        </div>
                      )}
                      {tutCases.map((tc) => (
                        <div key={tc.fullPath} className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-accent group">
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium truncate">{tc.name}</div>
                            <div className="text-[10px] text-muted-foreground font-mono truncate">{tc.fullPath}</div>
                          </div>
                          <Button
                            size="sm" variant="outline" className="h-7 text-xs opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 ml-2"
                            onClick={() => { setCopyDialogCase(tc); setCopyNewName(tc.name); }}
                          >
                            <Copy className="w-3 h-3 mr-1" /> Copy
                          </Button>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      )}

      {/* Copy Tutorial Dialog */}
      <Dialog open={!!copyDialogCase} onOpenChange={(open) => { if (!open) setCopyDialogCase(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Copy Tutorial</DialogTitle></DialogHeader>
          {copyDialogCase && (
            <div className="space-y-4 pt-2">
              <div>
                <div className="text-xs text-muted-foreground">From</div>
                <div className="font-mono text-sm bg-muted/50 px-2 py-1 rounded">{copyDialogCase.fullPath}</div>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">New case name</label>
                <Input
                  value={copyNewName} onChange={(e) => setCopyNewName(e.target.value)}
                  placeholder="e.g. myCavityTest" className="font-mono"
                  onKeyDown={(e) => e.key === 'Enter' && handleCopyTutorial(copyDialogCase.fullPath, copyNewName)}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setCopyDialogCase(null)}>Cancel</Button>
                <Button
                  onClick={() => handleCopyTutorial(copyDialogCase.fullPath, copyNewName)}
                  disabled={!copyNewName.trim() || copyingTut === copyDialogCase.fullPath}
                >
                  {copyingTut === copyDialogCase.fullPath ? '...' : <><Copy className="w-4 h-4 mr-1" /> Copy</>}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Clone Case Dialog */}
      <Dialog open={!!cloneDialogCase} onOpenChange={(open) => { if (!open) setCloneDialogCase(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Clone Case</DialogTitle></DialogHeader>
          {cloneDialogCase && (
            <div className="space-y-4 pt-2">
              <div>
                <div className="text-xs text-muted-foreground">Copy from</div>
                <div className="font-mono text-sm bg-muted/50 px-2 py-1 rounded">{cloneDialogCase}</div>
                <div className="text-[10px] text-muted-foreground mt-1">
                  Only 0/, system/, constant/ will be copied (no timesteps, log or postProcessing)
                </div>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">New case name</label>
                <Input
                  value={cloneNewName} onChange={(e) => setCloneNewName(e.target.value)}
                  placeholder="e.g. cavity_variant1" className="font-mono"
                  onKeyDown={(e) => e.key === 'Enter' && handleCloneCase(cloneDialogCase, cloneNewName)}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setCloneDialogCase(null)}>Cancel</Button>
                <Button
                  onClick={() => handleCloneCase(cloneDialogCase, cloneNewName)}
                  disabled={!cloneNewName.trim() || cloningCase === cloneDialogCase}
                >
                  {cloningCase === cloneDialogCase ? '...' : <><GitBranch className="w-4 h-4 mr-1" /> Clone</>}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Rename Case Dialog */}
      <Dialog open={!!renameDialogCase} onOpenChange={(open) => { if (!open) setRenameDialogCase(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Rename Case</DialogTitle></DialogHeader>
          {renameDialogCase && (
            <div className="space-y-4 pt-2">
              <div>
                <div className="text-xs text-muted-foreground">Current name</div>
                <div className="font-mono text-sm bg-muted/50 px-2 py-1 rounded">{renameDialogCase}</div>
                <div className="text-[10px] text-muted-foreground mt-1">
                  The case is renamed atomically (mv). Files open in the editor and active processes will follow the new path.
                </div>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">New name</label>
                <Input
                  value={renameNewName} onChange={(e) => setRenameNewName(e.target.value)}
                  placeholder="e.g. cavity_v2" className="font-mono"
                  onKeyDown={(e) => e.key === 'Enter' && handleRenameCase(renameDialogCase, renameNewName)}
                  autoFocus
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setRenameDialogCase(null)}>Cancel</Button>
                <Button
                  onClick={() => handleRenameCase(renameDialogCase, renameNewName)}
                  disabled={!renameNewName.trim() || renameNewName.trim() === renameDialogCase || renamingCase === renameDialogCase}
                >
                  {renamingCase === renameDialogCase ? '...' : <><Pencil className="w-4 h-4 mr-1" /> Rename</>}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Not Running */}
      {!status?.running && (
        <Alert className="border-amber-500/50 bg-amber-950/20">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <AlertDescription>
            WSL &quot;{status?.name}&quot; unavailable.
            <code className="ml-1 px-1.5 py-0.5 bg-muted rounded text-xs font-mono cursor-pointer" onClick={() => setShowSettings(true)}>
              wsl -d {status?.name || 'Ubuntu-22.04'}
            </code>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

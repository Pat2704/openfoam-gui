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
import { useCaseContext } from '@/lib/case-context';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import {
  Box, Trash2, FolderOpen, RefreshCw, Settings, Play, Terminal as TerminalIcon,
  CheckCircle2, XCircle, Activity, Terminal, ChevronRight,
  AlertTriangle, Copy, BookOpen, FolderTree, HardDrive, Clock,
  FileText, Zap, GitBranch, Pencil, Loader2, Cuboid, FolderSearch, Wand2,
  Folder, FolderPlus, FolderInput, ChevronDown
} from 'lucide-react';
import { confirmDialog } from '@/components/ui/confirm-host';
import { loadFoamyConfig, patchFoamyConfig } from '@/lib/foamy-store';
import { joinCaseRef, parseCaseRef } from '@/lib/case-name';

interface WslStatus {
  running: boolean; name: string; error?: string;
  version?: string; runDir?: string; tutorialDir?: string; env?: string; processes?: string; distros?: string[];
  cases?: CaseSummary[];
  containers?: string[];
}

/** The Select value that stands for "directly in the run directory". */
const RUN_FOLDER = '__run__';

/**
 * Where a case goes: directly in the run directory, or in one of the
 * containers. `value` is the container's name, or '' for the run directory.
 * Rendered only when there is a container to choose.
 */
function LocationSelect({ value, onChange, containers, label }: {
  value: string; onChange: (container: string) => void; containers: string[]; label: string;
}) {
  if (containers.length === 0) return null;
  return (
    <Select value={value || RUN_FOLDER} onValueChange={v => onChange(v === RUN_FOLDER ? '' : v)}>
      <SelectTrigger className="h-8 text-xs font-mono w-auto min-w-[9rem]" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={RUN_FOLDER} className="text-xs">Run folder</SelectItem>
        {containers.map(c => (
          <SelectItem key={c} value={c} className="text-xs font-mono">{c}/</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The folder name of a case reference, and the container it is in ('' for none). */
function caseLeaf(ref: string): string { return parseCaseRef(ref)?.name ?? ref; }
function caseContainer(ref: string): string { return parseCaseRef(ref)?.container ?? ''; }

interface CaseSummary {
  name: string;
  dirs: string[];
  fileCount: Record<string, number>;
  timeStepCount: number;
  lastTimeStep: string;
  hasLog: boolean;
  logFiles: string[];
  /** Carries the New Case wizard's record, so it can be updated from there. */
  wizard?: boolean;
}

interface TutorialCategory { name: string; path: string; }
/** `name` is the path below the category; `wrapper` marks a folder whose own Allrun runs the tutorials under it. */
interface TutorialCase { name: string; fullPath: string; wrapper?: boolean; }

interface ParaViewStatus {
  found: boolean;
  pvpythonPath?: string;
  version?: string;
  source?: string;
  searched?: string[];
  error?: string;
}

/** The background load that leaves ParaView in the Windows cache. */
interface ParaViewWarmup {
  state: 'warming' | 'warm' | 'failed';
  pvpythonPath: string;
  elapsedMs: number;
  error?: string;
}

/**
 * How long after detection the warm-up begins. Long enough for the app's own
 * start — the WSL probe, the case list — to have had the disk first.
 */
const WARMUP_DELAY_MS = 5_000;

type RuntimeSettings = 'openfoam' | 'paraview' | null;

export default function Dashboard({
  selectedCase, onSelectCase, onRefresh, refreshSignal = 0, onUpdateCase
}: {
  selectedCase: string | null;
  onSelectCase: (name: string) => void;
  onRefresh: () => void;
  /** Reopen a wizard-made case in the New Case wizard ("Update case"). */
  onUpdateCase?: (name: string) => void;
  /**
   * Bumped by the page when something outside this component changed the case
   * list — creating a case in the wizard, for one. Without it the user lands
   * back here on a stale list and thinks the creation failed.
   */
  refreshSignal?: number;
}) {
  const [status, setStatus] = useState<WslStatus | null>(null);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  // Containers: folders of the run directory that group cases (see
  // src/lib/case-name.ts). Listed even when empty, which the case list alone
  // could not show.
  const [containers, setContainers] = useState<string[]>([]);
  const [collapsedContainers, setCollapsedContainers] = useState<Set<string>>(new Set());
  const [newCaseLocation, setNewCaseLocation] = useState('');
  const [containerBusy, setContainerBusy] = useState<string | null>(null);
  const [containerDialog, setContainerDialog] = useState<string | null>(null);
  const [containerNewName, setContainerNewName] = useState('');
  // Moving a case: the dialog's case, and the case being dragged over the list
  // with the place it is currently over ('' is the run directory).
  const [moveDialogCase, setMoveDialogCase] = useState<string | null>(null);
  const [draggedCase, setDraggedCase] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [distroInput, setDistroInput] = useState('');
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings>(null);
  // OpenFOAM version selection (replaces the old Ubuntu distro selector).
  const [foamVersions, setFoamVersions] = useState<{ version: string; bashrcPath: string; installDir: string }[]>([]);
  const [selectedFoamBashrc, setSelectedFoamBashrc] = useState<string | null>(null);
  const [switchingFoam, setSwitchingFoam] = useState(false);
  const [switchingFoamBashrc, setSwitchingFoamBashrc] = useState<string | null>(null);
  const [loadingFoamVersions, setLoadingFoamVersions] = useState(false);
  const [foamVersionsError, setFoamVersionsError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newCaseName, setNewCaseName] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [paraViewStatus, setParaViewStatus] = useState<ParaViewStatus | null>(null);
  const [paraViewPath, setParaViewPath] = useState('');
  const [checkingParaView, setCheckingParaView] = useState(true);
  const [paraViewWarmup, setParaViewWarmup] = useState<ParaViewWarmup | null>(null);
  /** On unless the user turned it off; the saved value is 'off' or absent. */
  const [warmupEnabled, setWarmupEnabled] = useState(true);
  const warmupEnabledRef = useRef(true);

  // Tutorials state
  const [tutCategories, setTutCategories] = useState<TutorialCategory[]>([]);
  const [tutDir, setTutDir] = useState('');
  const [selectedTutCat, setSelectedTutCat] = useState<string | null>(null);
  const [tutCases, setTutCases] = useState<TutorialCase[]>([]);
  const [tutLoading, setTutLoading] = useState(false);
  const [tutError, setTutError] = useState<string | null>(null);
  // Each category listing is a WSL call, so clicking through categories quickly
  // can have the answers arrive out of order; only the latest request may land.
  const tutRequestRef = useRef(0);
  // The File Editor's unsaved file, if any: renaming the open case reopens it.
  const { unsavedFile, setUnsavedFile } = useCaseContext();
  // The tutorial directory the open category belongs to (see fetchTutorials).
  const tutDirRef = useRef('');
  const [copyingTut, setCopyingTut] = useState<string | null>(null);
  const [copyDialogCase, setCopyDialogCase] = useState<TutorialCase | null>(null);
  const [copyNewName, setCopyNewName] = useState('');
  const [copyLocation, setCopyLocation] = useState('');
  /**
   * Height that ends the tutorials grid at the bottom of `main`, so the two
   * lists scroll on their own without the page scrolling as well. Measured, not
   * guessed: what sits above the grid changes height (the status cards stack
   * below `lg`, an alert can appear), and a `calc(100dvh - …)` constant was
   * 92 px off at 1366×768. Watching the Dashboard's own root as well as `main`
   * catches content above the grid changing without the window resizing.
   */
  const [tutGridHeight, setTutGridHeight] = useState<number | null>(null);
  const tutGridRef = useCallback((grid: HTMLDivElement | null) => {
    const main = grid?.closest('main');
    if (!grid || !main) return;
    const fit = () => {
      const top = grid.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      const padBottom = parseFloat(getComputedStyle(main).paddingBottom) || 0;
      setTutGridHeight(Math.max(400, Math.floor(main.clientHeight - top - padBottom)));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(main);
    const root = grid.closest('[data-slot="tabs"]')?.parentElement;
    if (root) observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // Clone case state
  const [cloneDialogCase, setCloneDialogCase] = useState<string | null>(null);
  const [cloneNewName, setCloneNewName] = useState('');
  const [cloneLocation, setCloneLocation] = useState('');
  const [cloningCase, setCloningCase] = useState<string | null>(null);

  // Rename case state
  const [renameDialogCase, setRenameDialogCase] = useState<string | null>(null);
  const [renameNewName, setRenameNewName] = useState('');
  const [renameLocation, setRenameLocation] = useState('');
  const [renamingCase, setRenamingCase] = useState<string | null>(null);

  // Cache to avoid unnecessary re-fetches — stores the last fetch timestamp
  const lastFetchRef = useRef<{ status: number; tutorials: number }>({ status: 0, tutorials: 0 });
  const foamVersionsRequestRef = useRef(0);
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
      setContainers(Array.isArray(statusData.containers) ? statusData.containers as string[] : []);
      if (statusData.name) setDistroInput(statusData.name);
    } catch {
      setStatus({ running: false, name: '', error: 'Cannot connect to WSL' });
    }
  }, []);

  const detectParaView = useCallback(async (
    pathOverride: string, refresh = false, save = false,
  ): Promise<ParaViewStatus | null> => {
    setCheckingParaView(true);
    try {
      const query = new URLSearchParams({ action: 'status' });
      if (pathOverride.trim()) query.set('path', pathOverride.trim());
      if (refresh) query.set('refresh', '1');
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 180_000);
      let response: Response;
      try {
        response = await fetch(`/api/paraview?${query}`, { signal: controller.signal });
      } finally {
        window.clearTimeout(timer);
      }
      const data = await response.json() as ParaViewStatus;
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setParaViewStatus(data);
      if (save) {
        if (pathOverride.trim() && data.source !== 'Custom path') {
          toast.error(data.found
            ? `That path holds no ParaView. The one in use is ${data.pvpythonPath}, so nothing was saved.`
            : 'That path holds no ParaView, and none was found elsewhere. Nothing was saved.');
          return data;
        }
        const saved = await patchFoamyConfig({ 'paraview-path': pathOverride.trim() });
        if (!saved) throw new Error('The ParaView path could not be saved.');
        window.dispatchEvent(new CustomEvent('paraview-config-changed'));
        if (data.found) toast.success(`ParaView ${data.version || ''} is ready.`.trim());
      }
      return data;
    } catch (error) {
      setParaViewStatus({
        found: false,
        error: error instanceof Error ? error.message : 'ParaView detection failed.',
      });
      return null;
    } finally {
      setCheckingParaView(false);
    }
  }, []);

  /**
   * Load ParaView once in the background so the ParaView tab starts warm.
   *
   * The server does the work and keeps it to once per installation per app
   * run, so asking again — a remount, a toggle switched back on — joins what
   * is already done rather than repeating it.
   */
  const startParaViewWarmup = useCallback(async (pathOverride: string) => {
    if (!warmupEnabledRef.current) return;
    try {
      const response = await fetch('/api/paraview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'warmup', path: pathOverride.trim() }),
      });
      if (!response.ok) return;
      const data = await response.json() as { warmup?: ParaViewWarmup | null };
      setParaViewWarmup(data.warmup ?? null);
    } catch { /* the workbench simply starts cold, as it always did */ }
  }, []);

  const toggleWarmup = async (enabled: boolean) => {
    warmupEnabledRef.current = enabled;
    setWarmupEnabled(enabled);
    const saved = await patchFoamyConfig({ 'paraview-warmup': enabled ? 'on' : 'off' });
    if (!saved) toast.error('The setting could not be saved.');
    if (enabled && paraViewStatus?.found) void startParaViewWarmup(paraViewPath);
    if (!enabled) {
      try {
        await fetch('/api/paraview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'warmup', enabled: false }),
        });
        setParaViewWarmup(null);
      } catch { /* the preference still applies at the next app start */ }
    }
  };

  // Follow a warm-up while it runs, so the card and the settings can say when
  // the ParaView tab has become fast. Nothing is polled once it has finished.
  useEffect(() => {
    if (paraViewWarmup?.state !== 'warming') return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch('/api/paraview?action=session', { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json() as { warmup?: ParaViewWarmup | null };
        if (data.warmup) setParaViewWarmup(data.warmup);
      } catch { /* the next tick asks again */ }
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [paraViewWarmup?.state]);

  const fetchTutorials = useCallback(async () => {
    try {
      const res = await fetch('/api/tutorials?action=categories');
      const data = await res.json();
      const dir: string = data.tutorialDir || '';
      // Another installation keeps its tutorials elsewhere: a category opened
      // under the old one kept listing paths the new one refuses to copy from.
      // Close it, and let any listing still on its way land nowhere.
      if (dir !== tutDirRef.current) {
        tutDirRef.current = dir;
        tutRequestRef.current++;
        setSelectedTutCat(null);
        setTutCases([]);
        setTutError(null);
        setTutLoading(false);
      }
      setTutCategories(data.categories || []);
      setTutDir(dir);
    } catch {}
  }, []);

  const fetchTutorialCases = async (category: string) => {
    const request = ++tutRequestRef.current;
    setSelectedTutCat(category);
    // Cleared at once: the previous category's tutorials used to stay on screen
    // under "Loading..." and could be copied from while the new list was coming.
    setTutCases([]);
    setTutError(null);
    setTutLoading(true);
    try {
      const res = await fetch(`/api/tutorials?action=cases&category=${encodeURIComponent(category)}`);
      const data = await res.json().catch(() => ({}));
      if (request !== tutRequestRef.current) return;
      if (res.ok) setTutCases(data.cases || []);
      else setTutError(data.error || `The tutorial list could not be read (HTTP ${res.status}).`);
    } catch {
      if (request === tutRequestRef.current) setTutError('The app could not reach its server.');
    } finally {
      if (request === tutRequestRef.current) setTutLoading(false);
    }
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
    let cancelled = false;
    let started = false;
    let warmupTimer: number | undefined;
    // Detection first, then — if ParaView is there and the user has not turned
    // it off — the background load, a few seconds later.
    const detectThenWarm = async (savedPath: string, warm: boolean) => {
      const found = await detectParaView(savedPath);
      if (cancelled || !warm || !found?.found) return;
      warmupTimer = window.setTimeout(() => {
        if (!cancelled) void startParaViewWarmup(savedPath);
      }, WARMUP_DELAY_MS);
    };
    void loadFoamyConfig().then(config => {
      if (cancelled || started) return;
      started = true;
      const savedPath = config['paraview-path'] || '';
      const warm = config['paraview-warmup'] !== 'off';
      warmupEnabledRef.current = warm;
      setParaViewPath(savedPath);
      setWarmupEnabled(warm);
      return detectThenWarm(savedPath, warm);
    });
    // Detection must run even if the config bridge never answers, or the card
    // would spin on "Detecting…" with nothing behind it.
    const fallback = window.setTimeout(() => {
      if (cancelled || started) return;
      started = true;
      void detectThenWarm('', true);
    }, 8_000);
    return () => {
      cancelled = true;
      window.clearTimeout(fallback);
      if (warmupTimer !== undefined) window.clearTimeout(warmupTimer);
    };
  }, [detectParaView, startParaViewWarmup]);

  useEffect(() => {
    if (status?.running) fetchTutorials();
  }, [status?.running, fetchTutorials]);

  // Refetch on demand, past the 2s throttle — the case really was just created.
  const seenSignal = useRef(refreshSignal);
  useEffect(() => {
    if (seenSignal.current === refreshSignal) return;
    seenSignal.current = refreshSignal;
    lastFetchRef.current.status = 0;
    void fetchAll(true);
  }, [refreshSignal, fetchAll]);

  const handleSetDistro = async () => {
    if (!distroInput.trim()) return;
    try {
      const response = await fetch(`/api/wsl?action=setDistro&name=${encodeURIComponent(distroInput.trim())}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to select the distro');
      // A distro change replaces the whole installation — a different OpenFOAM,
      // a different run directory — so it has to raise the same signal a
      // version change does. Without it the tabs that read the installation
      // went on showing the previous distro's.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('foam-version-changed', { detail: { distro: data.distro } }));
      }
      void fetch('/api/foam-index?action=rebuild').catch(() => {
        // The knowledge status stays stale and the next AI turn retries.
      });
      setLoading(true);
      lastFetchRef.current.status = 0;
      await fetchAll(true);
      // The tutorial tree belongs to the installation too.
      await fetchTutorials();
      setLoading(false);
      setRuntimeSettings(null);
      toast.success(`Distro: ${data.distro}`);
    } catch (error) {
      setLoading(false);
      toast.error(error instanceof Error ? error.message : 'Unable to select the distro');
    }
  };

  // Fetch all installed OpenFOAM versions (for the settings dialog).
  const fetchFoamVersions = useCallback(async (refresh = false) => {
    const requestId = ++foamVersionsRequestRef.current;
    setLoadingFoamVersions(true);
    setFoamVersionsError(null);
    try {
      const query = new URLSearchParams({ action: 'foamVersions' });
      if (refresh) query.set('refresh', '1');
      const res = await fetch(`/api/wsl?${query}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (requestId !== foamVersionsRequestRef.current) return;
      const detected = Array.isArray(data.versions) ? data.versions : [];
      if (detected.length === 0 && foamVersions.length > 0) {
        setFoamVersionsError('The latest scan returned no installations. Keeping the previously detected versions; use Look again to retry.');
        return;
      }
      setFoamVersions(detected);
      setSelectedFoamBashrc(data.selectedBashrc || null);
    } catch (error) {
      if (requestId !== foamVersionsRequestRef.current) return;
      // Preserve a previously valid list during a transient WSL failure. The
      // old code replaced it with [], making versions appear to vanish after
      // the app had been open for a while.
      setFoamVersionsError(error instanceof Error ? error.message : 'OpenFOAM detection failed.');
    } finally {
      if (requestId === foamVersionsRequestRef.current) setLoadingFoamVersions(false);
    }
  }, [foamVersions]);

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
      void fetch('/api/foam-index?action=rebuild').catch(() => {
        // The knowledge status stays stale and the next AI turn retries.
      });
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
      setRuntimeSettings(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Error switching version');
    }
    setSwitchingFoam(false);
    setSwitchingFoamBashrc(null);
  };

  const handleCreateCase = async () => {
    if (!newCaseName.trim()) { toast.error('Enter a name'); return; }
    if (newCaseName.includes(' ')) { toast.error('No spaces in the name'); return; }
    if (newCaseName.includes('/')) { toast.error('A name is one folder: choose the container beside it'); return; }
    // A container that has since been removed must not be used silently.
    const location = containers.includes(newCaseLocation) ? newCaseLocation : '';
    const name = joinCaseRef(location, newCaseName.trim());
    if (containers.includes(name)) { toast.error(`"${name}" is a container`); return; }
    // The server refuses an existing name; say so before the optimistic row
    // below would show the case twice.
    if (cases.some(c => c.name === name)) { toast.error(`A case called "${name}" already exists`); return; }
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
        // Rollback: remove the optimistic row only — by identity, so a real
        // case of the same name is not taken off the list with it.
        setCases(prev => prev.filter(c => c !== optimisticCase));
        const data = await res.json();
        toast.error(data.error || 'Error');
      }
    } catch {
      setCases(prev => prev.filter(c => c !== optimisticCase));
      toast.error('WSL error');
    }
    setCreating(false);
  };

  // ── Containers ──
  const postCases = async (body: Record<string, unknown>) => {
    const res = await fetch('/api/cases', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({} as Record<string, unknown>));
    return { ok: res.ok, data: data as { error?: string; name?: string; needsConfirmation?: boolean; folders?: string[] } };
  };

  const handleCreateContainer = async () => {
    const name = newCaseName.trim();
    if (!name) { toast.error('Enter a name for the container'); return; }
    if (/[\s/]/.test(name)) { toast.error('No spaces or slashes in the name'); return; }
    setCreating(true);
    try {
      const { ok, data } = await postCases({ action: 'createContainer', name });
      if (ok) {
        toast.success(`Container "${name}" created`);
        setNewCaseName(''); setNewCaseLocation(name);
        await fetchAll(true); onRefresh();
      } else toast.error(data.error || 'The container could not be created');
    } catch { toast.error('WSL error'); }
    setCreating(false);
  };

  const handleDeleteContainer = async (name: string) => {
    setContainerBusy(name);
    try {
      const { ok, data } = await postCases({ action: 'deleteContainer', name });
      if (ok) { toast.success(`Container "${name}" deleted`); await fetchAll(true); onRefresh(); }
      else toast.error(data.error || `Could not delete "${name}"`);
    } catch { toast.error('WSL error'); }
    setContainerBusy(null);
  };

  const handleRenameContainer = async (oldName: string, newName: string) => {
    const name = newName.trim();
    if (!name) { toast.error('Enter a name'); return; }
    if (name === oldName) { setContainerDialog(null); return; }
    const openInside = !!selectedCase && caseContainer(selectedCase) === oldName;
    if (openInside && unsavedFile && !(await confirmDialog(
      `"${unsavedFile}" has unsaved changes. Renaming the container reopens the open case and discards them.`,
      { title: 'Unsaved changes', confirmLabel: 'Discard and rename', destructive: true },
    ))) return;
    setContainerBusy(oldName);
    try {
      const { ok, data } = await postCases({ action: 'renameContainer', name: oldName, newName: name });
      if (ok) {
        toast.success(`Container "${oldName}" renamed to "${data.name}"`);
        if (openInside && selectedCase) {
          if (unsavedFile) setUnsavedFile(null);
          onSelectCase(joinCaseRef(data.name, caseLeaf(selectedCase)));
        }
        announceCaseListChange();
        setContainerDialog(null);
        await fetchAll(true); onRefresh();
      } else toast.error(data.error || 'Rename error');
    } catch { toast.error('WSL error'); }
    setContainerBusy(null);
  };

  /**
   * Turn a folder into a container, or a container back into a case. A folder
   * that already holds folders is asked about first: they become its cases,
   * and the server changes nothing until told the user agreed.
   */
  const handleSetKind = async (name: string, kind: 'container' | 'case') => {
    setContainerBusy(name);
    try {
      let { ok, data } = await postCases({ action: 'setKind', name, kind });
      if (ok && data.needsConfirmation) {
        const folders = data.folders ?? [];
        const listed = folders.length <= 8 ? folders.join(', ') : `${folders.slice(0, 8).join(', ')} and ${folders.length - 8} more`;
        if (!(await confirmDialog(
          `"${name}" becomes a container, and the ${folders.length === 1 ? 'folder' : `${folders.length} folders`} inside it ${folders.length === 1 ? 'is' : 'are'} listed as ${folders.length === 1 ? 'a case' : 'cases'}: ${listed}. Nothing is moved or deleted.`,
          { title: 'Turn this folder into a container?', confirmLabel: 'Turn into a container' },
        ))) { setContainerBusy(null); return; }
        ({ ok, data } = await postCases({ action: 'setKind', name, kind, confirmed: true }));
      }
      if (ok && !data.needsConfirmation) {
        toast.success(kind === 'container' ? `"${name}" is now a container` : `"${name}" is now a case`);
        if (kind === 'container' && selectedCase === name) onSelectCase('');
        announceCaseListChange();
        setRenameDialogCase(null); setContainerDialog(null);
        await fetchAll(true); onRefresh();
      } else toast.error(data.error || `"${name}" was not changed`);
    } catch { toast.error('WSL error'); }
    setContainerBusy(null);
  };

  /**
   * Tell the rest of the app that the set of cases changed, so the switcher
   * chips in the header can drop the ones that no longer exist.
   */
  const announceCaseListChange = () => {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('case-list-changed'));
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
        announceCaseListChange();
        toast.success(`"${name}" deleted`);
        await fetchAll(true); onRefresh();
      } else {
        // Rollback: restore the case
        setCases(prevCases);
        const detail = await res.json().catch(() => ({} as { error?: string }));
        toast.error(detail?.error ? `Could not delete "${name}": ${detail.error}` : `Could not delete "${name}"`);
      }
    } catch (e: unknown) {
      // This branch was missing its rollback, and it is the one that fires when
      // WSL is unreachable or the request never completes. The case had already
      // been removed from the list optimistically, so it stayed gone from the
      // UI while still existing on disk: the user was told "Error" — with no
      // subject — and saw the case vanish, which reads as a delete that worked.
      setCases(prevCases);
      toast.error(`Could not delete "${name}": ${e instanceof Error ? e.message : 'the app could not reach the server'}`);
    }
    setDeleting(null);
  };

  const handleCopyTutorial = async (tutorialPath: string, typedName: string) => {
    if (!typedName.trim()) { toast.error('Enter a name'); return; }
    if (/[\s/]/.test(typedName.trim())) { toast.error('No spaces or slashes in the name'); return; }
    const newName = joinCaseRef(containers.includes(copyLocation) ? copyLocation : '', typedName.trim());
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

  const handleCloneCase = async (sourceName: string, typedName: string) => {
    if (!typedName.trim()) { toast.error('Enter a name'); return; }
    if (/[\s/]/.test(typedName.trim())) { toast.error('No spaces or slashes in the name'); return; }
    const newName = joinCaseRef(containers.includes(cloneLocation) ? cloneLocation : '', typedName.trim());
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
  const handleRenameCase = async (oldName: string, typedName: string) => {
    if (!typedName.trim()) { toast.error('Enter a name'); return; }
    if (/[\s/]/.test(typedName.trim())) { toast.error('No spaces or slashes in the name'); return; }
    const newName = joinCaseRef(containers.includes(renameLocation) ? renameLocation : '', typedName.trim());
    if (newName.trim() === oldName) { setRenameDialogCase(null); return; }
    await renameCaseTo(oldName, newName, 'rename');
  };

  /**
   * Move a case to another container, or to the run directory (''), keeping
   * its name. The same atomic `mv` as a rename — a move IS a rename of the
   * reference — so everything a rename guards, a move guards too.
   */
  const handleMoveCase = async (caseRef: string, container: string) => {
    if (caseContainer(caseRef) === container) return;
    await renameCaseTo(caseRef, joinCaseRef(container, caseLeaf(caseRef)), 'move');
  };

  const renameCaseTo = async (oldName: string, newName: string, verb: 'rename' | 'move') => {
    if (cases.some(c => c.name === newName)) {
      toast.error(`A case called "${caseLeaf(newName)}" already exists ${caseContainer(newName) ? `in "${caseContainer(newName)}"` : 'in the run folder'}`);
      return;
    }
    const discardsEdits = selectedCase === oldName && !!unsavedFile;
    if (discardsEdits && !(await confirmDialog(
      `"${unsavedFile}" has unsaved changes. ${verb === 'move' ? 'Moving' : 'Renaming'} the open case reopens it and discards them.`,
      { title: 'Unsaved changes', confirmLabel: `Discard and ${verb}`, destructive: true },
    ))) return;
    setRenamingCase(oldName);
    try {
      const res = await fetch('/api/cases', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename', caseName: oldName, newName: newName.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(verb === 'move'
          ? `"${caseLeaf(oldName)}" moved to ${caseContainer(data.caseName) ? `"${caseContainer(data.caseName)}"` : 'the run folder'}`
          : `"${oldName}" renamed to "${data.caseName}"`);
        // If the renamed case was open, switch the selection to the new name.
        // The user already agreed to lose the buffer above; clearing the flag
        // keeps the switch from asking a second time.
        if (discardsEdits) setUnsavedFile(null);
        if (selectedCase === oldName) onSelectCase(data.caseName);
        announceCaseListChange();
        setRenameDialogCase(null); setMoveDialogCase(null);
        await fetchAll(true); onRefresh();
      } else {
        const data = await res.json();
        toast.error(data.error || (verb === 'move' ? 'Move error' : 'Rename error'));
      }
    } catch { toast.error('WSL error'); }
    setRenamingCase(null);
  };

  // ── Dragging a case onto a container, or onto the run folder strip ──
  // A drop target answers only while a case is being dragged and only when the
  // case is not already there, so nothing else on the page reacts to the drag.
  const acceptsDrop = (container: string) => draggedCase !== null && caseContainer(draggedCase) !== container;
  const handleDragOver = (e: React.DragEvent, container: string) => {
    if (!acceptsDrop(container)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropTarget !== container) setDropTarget(container);
  };
  const handleDragLeave = (container: string) => { if (dropTarget === container) setDropTarget(null); };
  const handleDrop = (e: React.DragEvent, container: string) => {
    if (!acceptsDrop(container) || !draggedCase) return;
    e.preventDefault();
    const moved = draggedCase;
    setDraggedCase(null); setDropTarget(null);
    void handleMoveCase(moved, container);
  };

  /**
   * The list as shown: each container followed by its cases (unless
   * collapsed), then the cases that sit directly in the run directory.
   */
  const listEntries: (
    | { kind: 'container'; name: string; count: number }
    | { kind: 'case'; c: CaseSummary; nested: boolean }
  )[] = [];
  for (const name of containers) {
    const inside = cases.filter(c => caseContainer(c.name) === name);
    listEntries.push({ kind: 'container', name, count: inside.length });
    if (!collapsedContainers.has(name)) for (const c of inside) listEntries.push({ kind: 'case', c, nested: true });
  }
  for (const c of cases) {
    if (!containers.includes(caseContainer(c.name))) listEntries.push({ kind: 'case', c, nested: false });
  }

  const handleRefresh = async () => {
    setLoading(true);
    await fetchAll(true);
    await fetchTutorials();
    await detectParaView(paraViewPath, true);
    setLoading(false);
    onRefresh();
  };

  // Skeleton loading state
  if (loading && !status) {
    return (
      <div className="space-y-3">
        {/* Runtime status skeletons */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {[0, 1].map(item => <Card key={item} className="p-3"><div className="flex items-center gap-3"><Skeleton className="w-5 h-5 rounded-full" /><Skeleton className="h-4 w-28" /><Skeleton className="h-4 w-32 ml-auto" /></div></Card>)}
        </div>
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
      {/* ══ Runtime status (compact) ══ */}
      {/* Same green when healthy, same red when not — but from tokens, which
          have a value per theme. `bg-green-950/20` is a DARK-mode green applied
          in both, so in light mode this strip was a dark green at 20% over
          white: a washed-out sage that read as "slightly unwell" rather than
          "connected". */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <Card className={status?.running ? 'border-success/40 bg-success-soft' : 'border-danger/40 bg-danger-soft'}>
        <CardContent className="p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {status?.running ? <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0" /> : <XCircle className="w-5 h-5 text-danger flex-shrink-0" />}
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
              <Button variant="ghost" size="sm" className="h-7 text-xs" aria-label="Open OpenFOAM settings" onClick={() => { setRuntimeSettings('openfoam'); void fetchFoamVersions(); }}>
                <Settings className="w-3 h-3" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className={paraViewStatus?.found ? 'border-info/40 bg-info-soft' : 'border-warning/40 bg-warning-soft'}>
        <CardContent className="p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              {checkingParaView ? <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin text-info" /> : paraViewStatus?.found ? <Cuboid className="h-5 w-5 flex-shrink-0 text-info" /> : <XCircle className="h-5 w-5 flex-shrink-0 text-warning" />}
              <div className="min-w-0">
                <div className="flex items-center gap-2"><span className="text-sm font-semibold">ParaView</span>{paraViewStatus?.found && <span className="text-xs text-muted-foreground">v{paraViewStatus.version || 'unknown'}</span>}{paraViewWarmup?.state === 'warming' && <span className="flex items-center gap-1 text-[10px] text-muted-foreground" title="Loading ParaView in the background so its tab opens in seconds"><Loader2 className="h-3 w-3 animate-spin" />warming up</span>}</div>
                <p className="truncate text-[10px] text-muted-foreground" title={paraViewStatus?.pvpythonPath || paraViewStatus?.error}>{checkingParaView ? 'Detecting the local installation…' : paraViewStatus?.found ? paraViewStatus.pvpythonPath : paraViewStatus?.error || 'Not detected'}</p>
              </div>
            </div>
            <div className="flex flex-shrink-0 items-center gap-1.5">
              {paraViewStatus?.source && <Badge variant="secondary" className="hidden max-w-36 truncate text-[10px] xl:inline-flex">{paraViewStatus.source}</Badge>}
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void detectParaView(paraViewPath, true)} disabled={checkingParaView}><RefreshCw className={`mr-1 h-3 w-3 ${checkingParaView ? 'animate-spin' : ''}`} /> Look again</Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs" aria-label="Open ParaView settings" onClick={() => setRuntimeSettings('paraview')}><Settings className="h-3 w-3" /></Button>
            </div>
          </div>
        </CardContent>
      </Card>
      </div>

      {/* Each status card opens only its own runtime configuration. Keeping the
          panels independent also prevents the ParaView gear from starting a
          comparatively expensive WSL installation scan. */}
      <Dialog open={runtimeSettings !== null} onOpenChange={(open) => { if (!open) setRuntimeSettings(null); }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{runtimeSettings === 'paraview' ? 'ParaView settings' : 'OpenFOAM settings'}</DialogTitle></DialogHeader>
          <div className="space-y-4 pt-2">
            {runtimeSettings === 'openfoam' && <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">OpenFOAM version</h3>
                <p className="text-sm text-muted-foreground">
                  Select which version to use. Installation, case and tutorial paths update automatically.
                </p>
              </div>
              <Button variant="outline" size="sm" className="flex-shrink-0" disabled={loadingFoamVersions || switchingFoam} onClick={() => void fetchFoamVersions(true)}>
                <RefreshCw className={`h-3.5 w-3.5 ${loadingFoamVersions ? 'animate-spin' : ''}`} /> Look again
              </Button>
            </div>
            {loadingFoamVersions && foamVersions.length === 0 && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Detecting installed versions…</div>
            )}
            {/* gap-3, not gap-2: these buttons carry an action that switches the
                whole installation, and at 8 px the versions read as one strip
                rather than as separate choices. */}
            <div className="flex flex-wrap gap-3">
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
            {foamVersionsError && <p className="text-xs text-danger">{foamVersionsError}</p>}
            </div>}

            {runtimeSettings === 'paraview' && <div className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold">ParaView</h3>
                <p className="text-xs text-muted-foreground">Discovery supports any version and install folder. Set a path only for a portable or unusually located copy.</p>
              </div>
              <div className={`rounded-md border px-3 py-2 text-xs ${paraViewStatus?.found ? 'border-info/30 bg-info-soft' : 'border-warning/30 bg-warning-soft'}`}>
                <div className="flex items-start gap-2">
                  {checkingParaView ? <Loader2 className="mt-0.5 h-4 w-4 animate-spin" /> : paraViewStatus?.found ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-info" /> : <AlertTriangle className="mt-0.5 h-4 w-4 text-warning" />}
                  <div className="min-w-0"><p className="font-medium">{checkingParaView ? 'Detecting…' : paraViewStatus?.found ? `ParaView ${paraViewStatus.version || ''} is ready` : 'ParaView was not found'}</p><p className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground">{paraViewStatus?.pvpythonPath || paraViewStatus?.error}</p></div>
                </div>
              </div>
              {/* Same reason as the version row above: Auto-detect and Save path
                  do different things and sat 8 px apart, against the field. */}
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative min-w-[280px] flex-1">
                  <FolderSearch className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input value={paraViewPath} onChange={event => setParaViewPath(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void detectParaView(paraViewPath, true, true); }} className="pl-9 font-mono text-xs" placeholder="Folder, paraview.exe, or pvpython.exe (optional)" spellCheck={false} />
                </div>
                <Button variant="outline" size="sm" disabled={checkingParaView} onClick={() => { setParaViewPath(''); void detectParaView('', true, true); }}><RefreshCw className="h-3.5 w-3.5" /> Auto-detect</Button>
                <Button size="sm" disabled={checkingParaView} onClick={() => void detectParaView(paraViewPath, true, true)}>Save path</Button>
              </div>
              {/* The first launch after a reboot is Windows reading ParaView's
                  libraries off the disk, not ParaView being slow; this pays for
                  it while the user is elsewhere. */}
              <label className="flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-xs">
                <Checkbox checked={warmupEnabled} onCheckedChange={value => void toggleWarmup(value === true)} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="font-medium">Load ParaView in the background at startup</span>
                  <span className="mt-0.5 block leading-snug text-muted-foreground">
                    The first launch after a reboot reads ParaView&apos;s libraries from disk and can take a
                    minute or two. Doing it a few seconds after the app opens, while you work on something
                    else, lets the ParaView tab start in seconds. Once per session, at low priority.
                  </span>
                  {paraViewWarmup && (
                    <span className={`mt-1 block ${paraViewWarmup.state === 'failed' ? 'text-warning' : 'text-muted-foreground'}`}>
                      {paraViewWarmup.state === 'warming'
                        ? `Loading now — ${Math.round(paraViewWarmup.elapsedMs / 1000)} s so far.`
                        : paraViewWarmup.state === 'warm'
                          ? `Loaded in ${Math.round(paraViewWarmup.elapsedMs / 1000)} s — the ParaView tab will start warm.`
                          : `The background load did not finish: ${paraViewWarmup.error || 'unknown error'}. ParaView will start the usual way.`}
                    </span>
                  )}
                </span>
              </label>
            </div>}
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
              <LocationSelect
                value={containers.includes(newCaseLocation) ? newCaseLocation : ''}
                onChange={setNewCaseLocation} containers={containers} label="Where to create the case"
              />
              <Button onClick={handleCreateCase} disabled={creating || !newCaseName.trim()} size="sm" className="h-8 text-xs">
                <FolderOpen className="w-3 h-3 mr-1" /> Create
              </Button>
              <Button
                onClick={handleCreateContainer} disabled={creating || !newCaseName.trim()} size="sm" variant="outline" className="h-8 text-xs"
                title="Create a container with this name: a folder that groups cases and is not a case itself"
              >
                <FolderPlus className="w-3 h-3 mr-1" /> Container
              </Button>
            </div>

            {cases.length === 0 && containers.length === 0 ? (
              <Card className="p-6 text-center text-muted-foreground">
                <FolderOpen className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No cases in $FOAM_RUN</p>
              </Card>
            ) : (
              <div className="space-y-1">
                {draggedCase !== null && caseContainer(draggedCase) !== '' && (
                  <div
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed text-xs text-muted-foreground ${
                      dropTarget === '' ? 'ring-2 ring-primary bg-primary/10 text-foreground' : ''
                    }`}
                    onDragOver={(e) => handleDragOver(e, '')}
                    onDragLeave={() => handleDragLeave('')}
                    onDrop={(e) => handleDrop(e, '')}
                  >
                    <FolderInput className="w-4 h-4" /> Drop here to move the case to the run folder
                  </div>
                )}
                {listEntries.map(entry => entry.kind === 'container' ? (
                  <div
                    key={`container:${entry.name}`}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/40 ${
                      dropTarget === entry.name ? 'ring-2 ring-primary bg-primary/10' : ''
                    }`}
                    onDragOver={(e) => handleDragOver(e, entry.name)}
                    onDragLeave={() => handleDragLeave(entry.name)}
                    onDrop={(e) => handleDrop(e, entry.name)}
                  >
                    <button
                      type="button"
                      className="flex items-center gap-2 flex-1 min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                      aria-expanded={!collapsedContainers.has(entry.name)}
                      aria-label={`${collapsedContainers.has(entry.name) ? 'Expand' : 'Collapse'} container ${entry.name}`}
                      onClick={() => setCollapsedContainers(prev => {
                        const next = new Set(prev);
                        if (next.has(entry.name)) next.delete(entry.name); else next.add(entry.name);
                        return next;
                      })}
                    >
                      {collapsedContainers.has(entry.name)
                        ? <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                        : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
                      <Folder className="w-4 h-4 text-amber-500 flex-shrink-0" />
                      <span className="font-mono text-sm font-medium truncate">{entry.name}</span>
                      <Badge variant="secondary" className="h-5 px-1.5 text-[9px] font-medium flex-shrink-0">
                        {entry.count} {entry.count === 1 ? 'case' : 'cases'}
                      </Badge>
                    </button>
                    <div className="flex gap-0.5 flex-shrink-0">
                      <Button
                        size="sm" variant="ghost" className="h-7 w-7 p-0 text-amber-600 hover:text-amber-500 hover:bg-amber-500/10"
                        onClick={() => { setContainerDialog(entry.name); setContainerNewName(entry.name); }}
                        title="Rename container, or turn it into a case"
                        aria-label={`Rename container ${entry.name}`}
                      >
                        <Pencil className="w-3 h-3" />
                      </Button>
                      <Button
                        size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-500 hover:text-red-600 hover:bg-destructive/10"
                        onClick={async () => {
                          if (entry.count > 0) { toast.error(`"${entry.name}" still holds ${entry.count} ${entry.count === 1 ? 'case' : 'cases'}: move or delete them first`); return; }
                          if (await confirmDialog(`Delete the empty container "${entry.name}"?`, { title: 'Delete container', confirmLabel: 'Delete', destructive: true })) handleDeleteContainer(entry.name);
                        }}
                        disabled={containerBusy === entry.name}
                        title={entry.count > 0 ? 'Delete container (only when it is empty)' : 'Delete container'}
                        aria-label={`Delete container ${entry.name}`}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ) : ((c: CaseSummary) => (
                  // Opening a case is the app's primary action and was reachable
                  // only with a mouse: a bare <div onClick>, absent from the tab
                  // order and announced as nothing. It cannot become a <button>
                  // — it contains the rename and delete buttons, and nesting
                  // those is invalid — so it takes the role explicitly, with the
                  // keyboard behaviour a button would have given for free.
                  <div
                    key={c.name}
                    role="button"
                    tabIndex={0}
                    aria-current={selectedCase === c.name ? 'true' : undefined}
                    aria-label={`Open case ${c.name}`}
                    // Draggable onto a container, or onto the run folder strip
                    // that appears above the list. Only useful with containers.
                    draggable={containers.length > 0}
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.name); setDraggedCase(c.name); }}
                    onDragEnd={() => { setDraggedCase(null); setDropTarget(null); }}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-all hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      selectedCase === c.name ? 'bg-accent ring-1 ring-primary/50' : ''
                    } ${entry.nested ? 'ml-6' : ''}`}
                    onClick={() => onSelectCase(c.name)}
                    onKeyDown={(e) => {
                      // Space must not scroll the list, and neither key should
                      // fire when the event came from one of the nested buttons.
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectCase(c.name);
                      }
                    }}
                  >
                    {/* Icon + Name */}
                    <Box className="w-4 h-4 text-primary flex-shrink-0" />
                    <span className="font-mono text-sm font-medium truncate flex-1 min-w-0" title={c.name}>{caseLeaf(c.name)}</span>

                    {/* Badges: file counts */}
                    <div className="hidden sm:flex items-center gap-1.5 flex-shrink-0">
                      {/* Three directories, three colours — that distinction is
                          the point and it stays. What changes is that each hue
                          now comes from a token with a light AND a dark value,
                          and each badge carries a faint wash of its own colour
                          so the row reads at a glance instead of as three
                          outlines. They were `border-orange-300` / `blue-300` /
                          `green-300`, light-mode borders shown in both themes:
                          barely visible on the dark ground. */}
                      {c.fileCount['0'] > 0 && (
                        <Badge variant="outline" title={`${c.fileCount['0']} files in 0/`}
                          className="h-5 px-1.5 text-[9px] font-medium text-warning border-warning/35 bg-warning-soft">
                          0/ {c.fileCount['0']}
                        </Badge>
                      )}
                      {c.fileCount.system > 0 && (
                        <Badge variant="outline" title={`${c.fileCount.system} files in system/`}
                          className="h-5 px-1.5 text-[9px] font-medium text-info border-info/35 bg-info-soft">
                          sys {c.fileCount.system}
                        </Badge>
                      )}
                      {c.fileCount.constant > 0 && (
                        <Badge variant="outline" title={`${c.fileCount.constant} files in constant/`}
                          className="h-5 px-1.5 text-[9px] font-medium text-success border-success/35 bg-success-soft">
                          con {c.fileCount.constant}
                        </Badge>
                      )}
                      {c.timeStepCount > 0 && (
                        <Badge variant="secondary" title={`${c.timeStepCount} time directories written`}
                          className="h-5 px-1.5 text-[9px] font-medium">
                          <Clock className="w-2.5 h-2.5 mr-0.5" /> {c.timeStepCount}ts
                          {c.lastTimeStep && <span className="ml-0.5 opacity-60">→{c.lastTimeStep}</span>}
                        </Badge>
                      )}
                      {c.hasLog && (
                        <Badge variant="secondary" title="This case has solver logs"
                          className="h-5 px-1.5 text-[9px] font-medium text-accent2 border-accent2/35 bg-accent2-soft">
                          <FileText className="w-2.5 h-2.5 mr-0.5" /> log
                        </Badge>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex gap-0.5 flex-shrink-0">
                      <Button
                        size="sm" variant="ghost" className="h-7 w-7 p-0 text-primary"
                        onClick={(e) => { e.stopPropagation(); onSelectCase(c.name); }}
                        title="Open case"
                        aria-label={`Open case ${c.name}`}
                      >
                        <Terminal className="w-3 h-3" />
                      </Button>
                      {/* Only cases the wizard made carry its record; the rest
                          have nothing to reopen and show no button. */}
                      {c.wizard && onUpdateCase && (
                        <Button
                          size="sm" variant="ghost" className="h-7 w-7 p-0 text-violet-500 hover:text-violet-600 hover:bg-violet-500/10"
                          onClick={(e) => { e.stopPropagation(); onUpdateCase(c.name); }}
                          title="Update case: reopen its settings in the New Case wizard"
                          aria-label={`Update case ${c.name} in the wizard`}
                        >
                          <Wand2 className="w-3 h-3" />
                        </Button>
                      )}
                      <Button
                        // `hover:bg-blue-50` is a near-white chip, which is what
                        // this button flashed in dark mode. A translucent tint of
                        // the icon's own colour reads correctly in both themes.
                        size="sm" variant="ghost" className="h-7 w-7 p-0 text-blue-500 hover:text-blue-600 hover:bg-blue-500/10"
                        onClick={(e) => { e.stopPropagation(); setCloneDialogCase(c.name); setCloneNewName(caseLeaf(c.name) + '_copy'); setCloneLocation(caseContainer(c.name)); }}
                        title="Clone case"
                        aria-label={`Clone case ${c.name}`}
                      >
                        <GitBranch className="w-3 h-3" />
                      </Button>
                      {containers.length > 0 && (
                        <Button
                          size="sm" variant="ghost" className="h-7 w-7 p-0 text-teal-600 hover:text-teal-500 hover:bg-teal-500/10"
                          onClick={(e) => { e.stopPropagation(); setMoveDialogCase(c.name); }}
                          title="Move case to a container or to the run folder (or drag it there)"
                          aria-label={`Move case ${c.name}`}
                        >
                          <FolderInput className="w-3 h-3" />
                        </Button>
                      )}
                      <Button
                        size="sm" variant="ghost" className="h-7 w-7 p-0 text-amber-600 hover:text-amber-500 hover:bg-amber-500/10"
                        onClick={(e) => { e.stopPropagation(); setRenameDialogCase(c.name); setRenameNewName(caseLeaf(c.name)); setRenameLocation(caseContainer(c.name)); }}
                        title="Rename or move case"
                        aria-label={`Rename case ${c.name}`}
                      >
                        <Pencil className="w-3 h-3" />
                      </Button>
                      <Button
                        size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-500 hover:text-red-600 hover:bg-destructive/10"
                        onClick={async (e) => { e.stopPropagation(); if (await confirmDialog(`Delete "${c.name}"?`, { title: 'Delete case', confirmLabel: 'Delete', destructive: true })) handleDeleteCase(c.name); }}
                        disabled={deleting === c.name}
                        title="Delete case"
                        aria-label={`Delete case ${c.name}`}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ))(entry.c))}
              </div>
            )}
          </TabsContent>

          {/* ══ TUTORIALS TAB ══ */}
          <TabsContent value="tutorials">
            {/* A bounded height is what lets the two lists scroll separately.
                Unbounded, both cards grew to their full length and `main`
                scrolled them together, so reaching the 20th tutorial of a
                category scrolled the category list out of sight. The single
                row is `minmax(0, 1fr)` and the cards `min-h-0` because grid and
                flex items otherwise refuse to shrink below their content. The
                height itself is measured by `tutGridRef`; the CSS formula is
                only the first-paint fallback. */}
            <div
              ref={tutGridRef}
              style={tutGridHeight ? ({ '--tut-grid-h': `${tutGridHeight}px` } as React.CSSProperties) : undefined}
              className="grid grid-cols-1 gap-3 md:grid-cols-3 md:grid-rows-[minmax(0,1fr)] md:h-[var(--tut-grid-h,max(400px,calc(100dvh-17rem)))]"
            >
              <Card className="flex flex-col min-h-0 max-h-[50vh] md:max-h-none">
                <CardHeader className="pb-2 pt-3 px-3">
                  <CardTitle className="text-sm flex items-center gap-1">
                    <BookOpen className="w-4 h-4" /> Categories
                    <Badge variant="secondary" className="ml-auto text-[10px]">{tutCategories.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0 flex-1 min-h-0 overflow-hidden">
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

              <Card className="md:col-span-2 flex flex-col min-h-0 max-h-[70vh] md:max-h-none">
                <CardHeader className="pb-2 pt-3 px-3">
                  <CardTitle className="text-sm flex items-center gap-1">
                    {selectedTutCat ? (
                      <>Tutorial: <span className="font-mono text-primary">{selectedTutCat}</span></>
                    ) : 'Select a category'}
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0 flex-1 min-h-0 overflow-hidden">
                  {/* Keyed by category: a new category starts at its first
                      tutorial instead of inheriting the previous list's scroll. */}
                  <ScrollArea key={selectedTutCat ?? ''} className="h-full">
                    <div className="p-2 space-y-1">
                      {tutLoading && <div className="text-xs text-muted-foreground p-2 animate-pulse">Loading...</div>}
                      {!selectedTutCat && !tutLoading && (
                        <div className="text-xs text-muted-foreground p-4 text-center">
                          Select a category to copy a tutorial.
                        </div>
                      )}
                      {tutError && !tutLoading && (
                        <div className="text-xs text-danger p-4 text-center">{tutError}</div>
                      )}
                      {selectedTutCat && !tutLoading && !tutError && tutCases.length === 0 && (
                        <div className="text-xs text-muted-foreground p-4 text-center">
                          No runnable tutorial in this folder.
                        </div>
                      )}
                      {tutCases.map((tc) => (
                        <div key={tc.fullPath} className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-accent group">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="text-sm font-medium truncate">{tc.name}</span>
                              {tc.wrapper && (
                                <Badge variant="secondary" className="text-[10px] flex-shrink-0" title="Its own Allrun runs the tutorials listed under it; copying it copies them all.">
                                  Allrun group
                                </Badge>
                              )}
                            </div>
                            <div className="text-[10px] text-muted-foreground font-mono truncate">{tc.fullPath}</div>
                          </div>
                          {/* Revealed on keyboard focus as well as on hover: tabbing
                              used to land on a button nobody could see. */}
                          <Button
                            size="sm" variant="outline" className="h-7 text-xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex-shrink-0 ml-2"
                            aria-label={`Copy tutorial ${tc.name}`}
                            onClick={() => { setCopyDialogCase(tc); setCopyNewName(tc.name.split('/').pop() || tc.name); }}
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
                <div className="flex gap-2">
                  <Input
                    value={copyNewName} onChange={(e) => setCopyNewName(e.target.value)}
                    placeholder="e.g. myCavityTest" className="font-mono flex-1"
                    onKeyDown={(e) => { if (e.key === 'Enter' && copyingTut !== copyDialogCase.fullPath) handleCopyTutorial(copyDialogCase.fullPath, copyNewName); }}
                  />
                  <LocationSelect value={containers.includes(copyLocation) ? copyLocation : ''} onChange={setCopyLocation} containers={containers} label="Where to copy the tutorial" />
                </div>
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
                <div className="flex gap-2">
                  <Input
                    value={cloneNewName} onChange={(e) => setCloneNewName(e.target.value)}
                    placeholder="e.g. cavity_variant1" className="font-mono flex-1"
                    onKeyDown={(e) => { if (e.key === 'Enter' && cloningCase !== cloneDialogCase) handleCloneCase(cloneDialogCase, cloneNewName); }}
                  />
                  <LocationSelect value={containers.includes(cloneLocation) ? cloneLocation : ''} onChange={setCloneLocation} containers={containers} label="Where to put the clone" />
                </div>
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
          <DialogHeader><DialogTitle>Rename or move case</DialogTitle></DialogHeader>
          {renameDialogCase && (
            <div className="space-y-4 pt-2">
              <div>
                <div className="text-xs text-muted-foreground">Current name</div>
                <div className="font-mono text-sm bg-muted/50 px-2 py-1 rounded">{renameDialogCase}</div>
                <div className="text-[10px] text-muted-foreground mt-1">
                  The case is renamed atomically (mv), and running processes follow the new path. The editor reopens the case, asking first if a file has unsaved changes.
                </div>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">New name{containers.length > 0 ? ' and location' : ''}</label>
                <div className="flex gap-2">
                  <Input
                    value={renameNewName} onChange={(e) => setRenameNewName(e.target.value)}
                    placeholder="e.g. cavity_v2" className="font-mono flex-1"
                    onKeyDown={(e) => { if (e.key === 'Enter' && renamingCase !== renameDialogCase) handleRenameCase(renameDialogCase, renameNewName); }}
                    autoFocus
                  />
                  <LocationSelect value={containers.includes(renameLocation) ? renameLocation : ''} onChange={setRenameLocation} containers={containers} label="Where the case is kept" />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                {/* Only a folder directly in the run directory can become a
                    container: containers are one level deep. */}
                {!caseContainer(renameDialogCase) && (
                  <Button
                    variant="ghost" className="mr-auto text-xs"
                    onClick={() => handleSetKind(renameDialogCase, 'container')}
                    disabled={containerBusy === renameDialogCase}
                    title="Make this folder a container: the folders inside it become its cases. Not for a case that has files of its own"
                  >
                    <Folder className="w-4 h-4 mr-1" /> Turn into a container
                  </Button>
                )}
                <Button variant="outline" onClick={() => setRenameDialogCase(null)}>Cancel</Button>
                <Button
                  onClick={() => handleRenameCase(renameDialogCase, renameNewName)}
                  disabled={!renameNewName.trim() || joinCaseRef(containers.includes(renameLocation) ? renameLocation : '', renameNewName.trim()) === renameDialogCase || renamingCase === renameDialogCase}
                >
                  {renamingCase === renameDialogCase ? '...' : <><Pencil className="w-4 h-4 mr-1" /> Rename</>}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Move Case Dialog: one click on the destination */}
      <Dialog open={!!moveDialogCase} onOpenChange={(open) => { if (!open) setMoveDialogCase(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Move case</DialogTitle></DialogHeader>
          {moveDialogCase && (
            <div className="space-y-4 pt-2">
              <div>
                <div className="text-xs text-muted-foreground">Case</div>
                <div className="font-mono text-sm bg-muted/50 px-2 py-1 rounded">{moveDialogCase}</div>
                <div className="text-[10px] text-muted-foreground mt-1">
                  The folder is moved as it is (mv), with its results and logs. Its name does not change.
                </div>
              </div>
              <div>
                <div className="text-sm font-medium mb-1">Move to</div>
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {['', ...containers].map(destination => {
                    const here = caseContainer(moveDialogCase) === destination;
                    return (
                      <Button
                        key={destination || RUN_FOLDER}
                        variant="outline" className="w-full justify-start font-mono text-sm"
                        disabled={here || renamingCase === moveDialogCase}
                        onClick={() => handleMoveCase(moveDialogCase, destination)}
                        aria-label={destination ? `Move to container ${destination}` : 'Move to the run folder'}
                      >
                        {destination ? <Folder className="w-4 h-4 mr-2 text-amber-500" /> : <HardDrive className="w-4 h-4 mr-2" />}
                        {destination ? `${destination}/` : 'Run folder'}
                        {here && <span className="ml-auto text-xs font-sans text-muted-foreground">it is here</span>}
                      </Button>
                    );
                  })}
                </div>
              </div>
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => setMoveDialogCase(null)}>Cancel</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Container Dialog: rename it, or turn it back into a case */}
      <Dialog open={!!containerDialog} onOpenChange={(open) => { if (!open) setContainerDialog(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Rename container</DialogTitle></DialogHeader>
          {containerDialog && (
            <div className="space-y-4 pt-2">
              <div>
                <div className="text-xs text-muted-foreground">Current name</div>
                <div className="font-mono text-sm bg-muted/50 px-2 py-1 rounded">{containerDialog}</div>
                <div className="text-[10px] text-muted-foreground mt-1">
                  A container groups cases and is not a case itself. The cases inside keep their names.
                </div>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">New name</label>
                <Input
                  value={containerNewName} onChange={(e) => setContainerNewName(e.target.value)}
                  className="font-mono" autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter' && containerBusy !== containerDialog) handleRenameContainer(containerDialog, containerNewName); }}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost" className="mr-auto text-xs"
                  onClick={() => handleSetKind(containerDialog, 'case')}
                  disabled={containerBusy === containerDialog}
                  title="Make this folder a case again (only when it holds no cases)"
                >
                  <Box className="w-4 h-4 mr-1" /> Turn into a case
                </Button>
                <Button variant="outline" onClick={() => setContainerDialog(null)}>Cancel</Button>
                <Button
                  onClick={() => handleRenameContainer(containerDialog, containerNewName)}
                  disabled={!containerNewName.trim() || containerNewName.trim() === containerDialog || containerBusy === containerDialog}
                >
                  {containerBusy === containerDialog ? '...' : <><Pencil className="w-4 h-4 mr-1" /> Rename</>}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Not Running.
          Amber either way, but from tokens: `bg-amber-950/20` is a dark-mode
          value that was being shown in light mode too, where a dark amber at
          20% over white is a dirty beige rather than a caution. */}
      {!status?.running && (
        <Alert className="border-warning/40 bg-warning-soft">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertDescription>
            WSL &quot;{status?.name}&quot; unavailable.
            <code className="ml-1 px-1.5 py-0.5 bg-muted rounded text-xs font-mono cursor-pointer" onClick={() => { setRuntimeSettings('openfoam'); void fetchFoamVersions(true); }}>
              wsl -d {status?.name || 'Ubuntu-22.04'}
            </code>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

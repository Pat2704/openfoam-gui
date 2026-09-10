'use client';

/**
 * New Case wizard.
 *
 * The generation itself lives in `src/lib/case-templates.ts` — including the
 * split between the modular (OpenFOAM 11+) and legacy (≤10) case layouts, which
 * is not cosmetic: a legacy case does not run at all on 11+, and that is what
 * this wizard used to produce unconditionally.
 *
 * The guiding idea here is that the mesh is the source of truth. Patch names
 * come from the blockMeshDict the wizard builds — plus, with snappyHexMesh, one
 * patch group per imported surface — and every boundary condition is generated
 * against that list, so the 0/ files and the mesh cannot disagree, which is
 * otherwise the most common reason a hand-assembled case dies on the first
 * time step.
 *
 * Two things build on that:
 *
 *   - "Update case" (src/lib/wizard-state.ts): a created case keeps the
 *     settings and the hash of every file written, in system/studioWizard.json,
 *     so the wizard can reopen it, rewrite only the files that changed and ask
 *     about any file somebody edited since.
 *   - Guided snappyHexMesh on OpenFOAM 13 and 14 (src/lib/snappy-templates.ts
 *     and ./wizard-snappy.tsx), only when chosen in the Mesh step.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  Plus, Trash2, FileCode, ChevronRight, ChevronLeft,
  CheckCircle2, Settings, Zap, Grid3x3, Droplets,
  Wind, Eye, Check, AlertTriangle, RefreshCw, Info, Wand2, X, FolderOpen, Loader2,
} from 'lucide-react';
import { confirmDialog } from '@/components/ui/confirm-host';
import { caseNameProblem } from '@/lib/case-name';
import {
  DEFAULT_MESH, TURBULENCE_MODELS,
  buildField, defaultBC, estimateTurbulence, findSolver, flavourForVersion,
  generateBlockMeshDict, generateControlDict, generateFvSchemes, generateFvSolution,
  generateGravity, generateTransportProperties, generateTurbulenceProperties,
  generateFieldFile, meshPatches, meshProblems, runCommand, solverChoices, syncFieldPatches,
  transportFileName, turbulenceFieldNames, turbulenceFileName,
  type FieldConfig, type Flavour, type MeshPatch, type MeshSpec, type TurbulenceModel,
} from '@/lib/case-templates';
import {
  DEFAULT_SNAPPY, generateMeshQualityDict, generateSnappyHexMeshDict, generateSurfaceFeaturesDict,
  geometryPath, meshSteps, snappyPatches, snappyProblems,
  type SnappySettings,
} from '@/lib/snappy-templates';
import {
  WIZARD_MARKER_PATH, buildMarker, isMeshInput, parseMarker, planUpdate, resolvePlan,
  serializeMarker, settingsEqual, sha256Hex,
  type Decision, type PlanEntry, type WizardMarker, type WizardSettings,
} from '@/lib/wizard-state';
import { pointInBox, pointInsideSurface } from '@/lib/geometry';
import SnappySection, { readGeometry, type InsideCheck, type LoadedGeometry } from '@/components/openfoam/wizard-snappy';
import MeshRunPanel from '@/components/openfoam/wizard-mesh-run';
import UpdateReview from '@/components/openfoam/wizard-update-review';

/**
 * Fallback list, used only until the installation answers.
 *
 * Hand-written lists of OpenFOAM names go stale silently: this one shipped with
 * `atmBoundaryLayerInletVelocity`, which exists on 13 and was renamed on 14 —
 * exactly the kind of error the index in src/lib/foam-index.ts exists to stop.
 * The real list comes from foamToC via /api/foam-index; these are the handful
 * that are stable across every version, for the seconds before it arrives.
 */
const BC_TYPES_FALLBACK = [
  'fixedValue', 'zeroGradient', 'noSlip', 'slip', 'symmetry', 'symmetryPlane', 'empty',
  'inletOutlet', 'outletInlet', 'fixedFluxPressure', 'totalPressure', 'pressureInletOutletVelocity',
  'flowRateInletVelocity', 'kqRWallFunction', 'epsilonWallFunction', 'omegaWallFunction',
  'nutkWallFunction', 'nutUWallFunction', 'calculated', 'freestream', 'codedFixedValue',
  'uniformFixedValue', 'cyclic', 'wedge',
];

const STEPS = [
  { id: 'basic', title: 'Case', icon: <Settings className="w-4 h-4" /> },
  { id: 'solver', title: 'Physics', icon: <Zap className="w-4 h-4" /> },
  { id: 'mesh', title: 'Mesh', icon: <Grid3x3 className="w-4 h-4" /> },
  { id: 'fields', title: 'Fields 0/', icon: <Wind className="w-4 h-4" /> },
  { id: 'system', title: 'system/', icon: <FileCode className="w-4 h-4" /> },
  { id: 'constant', title: 'constant/', icon: <Droplets className="w-4 h-4" /> },
  { id: 'create', title: 'Create!', icon: <CheckCircle2 className="w-4 h-4" /> },
];

/** A wizard-managed field is one the physics implies; the rest are the user's. */
const CORE_FIELDS = ['U', 'p'];

/** Whether the installation can take the guided snappyHexMesh option (/api/wsl?action=snappySupport). */
interface SnappySupport { version: string; major: number | null; available: boolean; reason: string | null }

/** What the last Create or Update did, shown above the steps with what to do next. */
interface WizardResult {
  caseName: string;
  kind: 'created' | 'updated' | 'unchanged';
  /** A file the mesh is built from changed. */
  meshStale: boolean;
  /** constant/polyMesh/boundary exists. */
  hasMesh: boolean;
  steps: string[];
  failed: string[];
}

/** Every patch the 0/ files need an entry for: the box's, and one group per surface. */
function allPatches(mesh: MeshSpec, snappy: SnappySettings | null): MeshPatch[] {
  return [...meshPatches(mesh), ...snappyPatches(snappy)];
}

async function uploadGeometry(caseName: string, file: string, bytes: Uint8Array): Promise<string> {
  const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}/geometry?file=${encodeURIComponent(file)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes as BodyInit,
  });
  const data = await res.json().catch(() => ({} as { error?: string; sha256?: string }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return String(data.sha256 || '');
}

async function writeCaseFile(caseName: string, path: string, content: string): Promise<boolean> {
  // fetch only rejects on a network failure — a 500 comes back as a perfectly
  // resolved promise, which is how Create used to report success after
  // writing nothing.
  const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'write', path, content }),
  }).catch(() => null);
  return !!res && res.ok;
}

export default function CaseWizard({ onCreated, openRequest, onOpenCase, onShowMesh }: {
  onCreated: () => void;
  /** "Update case" from the Dashboard: reopen this case's recorded settings. */
  openRequest?: { caseName: string; n: number } | null;
  onOpenCase?: (name: string) => void;
  onShowMesh?: (name: string) => void;
}) {
  const [step, setStep] = useState(0);

  // ── Which OpenFOAM are we writing for ───────────────────────────────────
  // 11 replaced the solver executables with `foamRun -solver <module>` and
  // renamed both constant/ dictionaries. Everything downstream depends on it,
  // so it is detected first and shown to the user, who can override it.
  const [flavour, setFlavour] = useState<Flavour>('modular');
  const [detectedVersion, setDetectedVersion] = useState<string | null>(null);
  /** Boundary condition names the installation actually offers (see below). */
  const [bcTypes, setBcTypes] = useState<string[]>(BC_TYPES_FALLBACK);
  const [bcFromInstall, setBcFromInstall] = useState(false);
  const [snappySupport, setSnappySupport] = useState<SnappySupport | null>(null);

  const [caseName, setCaseName] = useState('');
  const [existingCases, setExistingCases] = useState<string[]>([]);
  /** Cases carrying the wizard's record, which can be reopened here. */
  const [wizardCases, setWizardCases] = useState<string[]>([]);

  const [solver, setSolver] = useState('incompressibleFluid');
  const [transient, setTransient] = useState(false);
  const [turbulence, setTurbulence] = useState<TurbulenceModel>('laminar');

  // Physics inputs the initial conditions are computed from.
  const [nu, setNu] = useState('1e-05');
  const [inletVelocity, setInletVelocity] = useState('(1 0 0)');
  const [intensity, setIntensity] = useState('5');
  const [lengthScale, setLengthScale] = useState('');

  const [endTime, setEndTime] = useState('500');
  const [deltaT, setDeltaT] = useState('1');
  const [writeInterval, setWriteInterval] = useState('100');

  const [mesh, setMesh] = useState<MeshSpec>(DEFAULT_MESH);
  /** Set once the user hand-edits the dict; the form then stops overwriting it. */
  const [meshOverride, setMeshOverride] = useState<string | null>(null);
  /** null: blockMesh only (the default). Set: the guided snappyHexMesh option. */
  const [snappy, setSnappyState] = useState<SnappySettings | null>(null);
  /** Geometry read in the browser, by file name in constant/geometry. */
  const [geometry, setGeometry] = useState<Record<string, LoadedGeometry>>({});

  const [systemOverrides, setSystemOverrides] = useState<Record<string, string>>({});
  const [constantOverrides, setConstantOverrides] = useState<Record<string, string>>({});
  const [gravity, setGravity] = useState('(0 -9.81 0)');

  const [showPreview, setShowPreview] = useState(false);
  const [previewField, setPreviewField] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState('');
  const [creating, setCreating] = useState(false);

  const [showNewFieldDialog, setShowNewFieldDialog] = useState(false);
  const [newFieldName, setNewFieldName] = useState('');
  const [activeFieldIdx, setActiveFieldIdx] = useState(0);

  // ── Update case ─────────────────────────────────────────────────────────
  /** The case being updated and its record, or null for a new case. */
  const [updateTarget, setUpdateTarget] = useState<{ caseName: string; marker: WizardMarker } | null>(null);
  const [result, setResult] = useState<WizardResult | null>(null);
  const [loadingCase, setLoadingCase] = useState<string | null>(null);
  const [pickedCase, setPickedCase] = useState('');
  const [review, setReview] = useState<{
    plan: PlanEntry[]; next: Record<string, string>; untouched: string[];
    contents: Record<string, string>; hasMesh: boolean;
  } | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [applying, setApplying] = useState(false);

  /**
   * Names in the files about to be written that this OpenFOAM does not know.
   *
   * The wizard generates from templates, so this should normally be empty — it
   * is here to catch the case where the templates drift away from a version, or
   * the user hand-edits a dictionary in step 4/5 and mistypes a type.
   */
  const [nameProblems, setNameProblems] = useState<{ name: string; where: string; suggestions: string[] }[]>([]);
  /** Files the wizard is about to write that OpenFOAM's parser rejects. */
  const [syntaxProblems, setSyntaxProblems] = useState<{ path: string; message: string; line: number | null }[]>([]);
  /**
   * Where that installation check stands. The green "Everything checks out"
   * used to show while it was still running and when it never ran at all
   * (index not ready, WSL busy) — and neither of those is "checked".
   */
  const [installCheck, setInstallCheck] = useState<'checking' | 'done' | 'unavailable'>('checking');

  /**
   * Restoring recorded settings sets every value at once, and the effects
   * below would then "helpfully" follow up — a restored transient run would get
   * its endTime reset, restored boundary conditions re-synced. They skip the
   * render the restore happens in; the last effect in this component clears it.
   */
  const restoringRef = useRef(false);
  const [restoreTick, setRestoreTick] = useState(0);
  /** Once a case is loaded, a late version answer must not change its layout. */
  const flavourPinnedRef = useRef(false);

  const patches = useMemo(() => allPatches(mesh, snappy), [mesh, snappy]);

  // Turbulent inlet conditions from U, I and L — see estimateTurbulence.
  const turbEstimate = useMemo(() => {
    const speed = Math.hypot(...(inletVelocity.match(/-?[\d.eE+-]+/g) || ['0'])
      .map(Number)
      .filter(Number.isFinite));
    const L = Number(lengthScale) || 0.07 * Math.abs(mesh.y1 - mesh.y0) || 0.01;
    return estimateTurbulence(speed || 1, (Number(intensity) || 5) / 100, L);
  }, [inletVelocity, intensity, lengthScale, mesh.y0, mesh.y1]);

  const fieldCtx = useMemo(() => ({
    inletVelocity,
    k: turbEstimate.k,
    epsilon: turbEstimate.epsilon,
    omega: turbEstimate.omega,
    nu: Number(nu) || 1e-5,
    turbulence,
  }), [inletVelocity, turbEstimate, nu, turbulence]);

  const [fields, setFields] = useState<FieldConfig[]>(() => {
    const p = meshPatches(DEFAULT_MESH);
    const ctx = { inletVelocity: '(1 0 0)', k: 0.00375, epsilon: 0.0027, omega: 8, nu: 1e-5 };
    return [buildField('U', p, ctx, 'modular'), buildField('p', p, ctx, 'modular')];
  });

  // ── The installation: version, condition types, snappy support ──────────
  // Read on mount and again on every OpenFOAM switch: the tab stays mounted
  // once visited, and a layout, a condition list or a "not available here"
  // from the previous installation is wrong for the next one.
  const detectInstallation = useCallback(async () => {
    try {
      const res = await fetch('/api/wsl?action=version');
      const data = await res.json();
      if (data?.version) {
        const major = parseInt(String(data.version).match(/\d+/)?.[0] ?? '', 10);
        setDetectedVersion(String(data.version).trim());
        if (!flavourPinnedRef.current) setFlavour(flavourForVersion(Number.isFinite(major) ? major : null));
      }
    } catch { /* keep the modular default */ }

    // The real boundary-condition list, straight from foamToC. Falls back to the
    // short built-in list if the index is not built yet or the version predates
    // foamToC (9/10), so the wizard always works — just with fewer choices.
    try {
      const res = await fetch('/api/foam-index?action=bc');
      const data = await res.json();
      if (data?.ready && Array.isArray(data.types) && data.types.length) {
        setBcTypes(data.types);
        setBcFromInstall(true);
      }
    } catch { /* keep the fallback */ }

    try {
      const res = await fetch('/api/wsl?action=snappySupport');
      const data = await res.json();
      setSnappySupport(res.ok && typeof data?.available === 'boolean'
        ? data
        : { version: '', major: null, available: false, reason: 'Could not ask the installation whether snappyHexMesh is supported.' });
    } catch {
      setSnappySupport({ version: '', major: null, available: false, reason: 'Could not ask the installation whether snappyHexMesh is supported.' });
    }
  }, []);

  useEffect(() => {
    void detectInstallation();
    const onChange = () => { setSnappySupport(null); void detectInstallation(); };
    window.addEventListener('foam-version-changed', onChange);
    return () => window.removeEventListener('foam-version-changed', onChange);
  }, [detectInstallation]);

  // Refuse to silently write into a case that already exists (see handleCreate),
  // and know which cases the wizard made (see "Update a case" on the first step).
  const refreshCases = useCallback(async (): Promise<string[] | null> => {
    try {
      const res = await fetch('/api/cases?action=listBatch');
      const data = await res.json();
      if (Array.isArray(data?.cases)) {
        const rows = data.cases as { name: string; wizard?: boolean }[];
        const names = rows.map(c => c.name);
        setExistingCases(names);
        setWizardCases(rows.filter(c => c.wizard).map(c => c.name));
        return names;
      }
    } catch { /* not fatal: handleCreate asks again */ }
    return null;
  }, []);
  useEffect(() => {
    void refreshCases();
    const onList = () => void refreshCases();
    window.addEventListener('case-list-changed', onList);
    return () => window.removeEventListener('case-list-changed', onList);
  }, [refreshCases]);

  // The solver list is per-flavour, so a solver from the other list cannot stay
  // selected. Dimensions are version-independent (see dimensionsFor).
  useEffect(() => {
    if (restoringRef.current) return;
    setSolver(prev => (findSolver(flavour, prev) ? prev : solverChoices(flavour)[0].value));
  }, [flavour]);

  // Solver choice carries a default time treatment.
  const solverInfo = findSolver(flavour, solver);
  useEffect(() => {
    if (restoringRef.current) return;
    const s = findSolver(flavour, solver);
    if (!s) return;
    setTransient(s.transient);
  }, [solver, flavour]);

  // Steady and transient want completely different controlDict numbers.
  useEffect(() => {
    if (restoringRef.current) return;
    if (transient) { setEndTime('0.5'); setDeltaT('0.001'); setWriteInterval('50'); }
    else { setEndTime('500'); setDeltaT('1'); setWriteInterval('100'); }
  }, [transient]);

  // The mesh owns the patch list: whenever it changes, re-project it onto every
  // field, keeping any boundary condition the user has already edited by name.
  const patchSignature = patches.map(p => `${p.name}:${p.role}`).join('|');
  useEffect(() => {
    if (restoringRef.current) return;
    setFields(prev => prev.map(f => syncFieldPatches(f, patches, fieldCtx)));
    // fieldCtx is intentionally not a dependency: re-syncing on every keystroke
    // in the physics step would overwrite boundary conditions the user is
    // editing. The "Apply physics" button in step 3 is the explicit path.
  }, [patchSignature]);

  // Picking a RAS model implies extra 0/ files; a case that names kEpsilon in
  // momentumTransport but has no k/epsilon/nut fails on startup.
  useEffect(() => {
    if (restoringRef.current) return;
    const needed = turbulenceFieldNames(turbulence);
    setFields(prev => {
      const have = new Set(prev.map(f => f.fieldName));
      const missing = needed.filter(n => !have.has(n));
      // nut is needed by every RAS model, so it survives a model change — but
      // its wall function depends on the model (Spalart-Allmaras has no k).
      // Only a wall function the wizard chose itself is swapped; an edit stays.
      const NUT_DEFAULTS = ['nutkWallFunction', 'nutUSpaldingWallFunction'];
      let changed = false;
      const updated = prev.map(f => {
        if (f.fieldName !== 'nut') return f;
        const boundaryConditions = f.boundaryConditions.map(bc => {
          const patch = patches.find(p => p.name === bc.name);
          if (!patch || patch.role !== 'wall' || !NUT_DEFAULTS.includes(bc.type)) return bc;
          const type = defaultBC('nut', patch, fieldCtx).type;
          if (type === bc.type) return bc;
          changed = true;
          return { ...bc, type };
        });
        return changed ? { ...f, boundaryConditions } : f;
      });
      if (missing.length === 0 && !changed) return prev;
      return [...updated, ...missing.map(n => buildField(n, patches, fieldCtx, flavour))];
    });
    // Same reasoning as above — only the model change should trigger this.
  }, [turbulence]);

  const staleTurbulenceFields = useMemo(() => {
    const needed = new Set(turbulenceFieldNames(turbulence));
    const allTurb = ['k', 'epsilon', 'omega', 'nut', 'nuTilda'];
    return fields.filter(f => allTurb.includes(f.fieldName) && !needed.has(f.fieldName)).map(f => f.fieldName);
  }, [fields, turbulence]);

  // ── Generated file contents ─────────────────────────────────────────────
  const sysOpts = useMemo(() => ({
    flavour, solver, transient, endTime, deltaT, writeInterval, turbulence,
  }), [flavour, solver, transient, endTime, deltaT, writeInterval, turbulence]);

  const blockMeshDict = meshOverride ?? generateBlockMeshDict(mesh);
  const controlDict = systemOverrides.controlDict ?? generateControlDict(sysOpts);
  const fvSchemes = systemOverrides.fvSchemes ?? generateFvSchemes(sysOpts);
  const fvSolution = systemOverrides.fvSolution ?? generateFvSolution(sysOpts);
  const snappyDict = snappy ? (snappy.snappyOverride ?? generateSnappyHexMeshDict(snappy)) : '';
  const featuresDict = snappy ? (snappy.featuresOverride ?? generateSurfaceFeaturesDict(snappy)) : '';

  // icoFoam on 10 reads physicalProperties, so the major version takes part.
  const detectedMajor = parseInt((detectedVersion || '').match(/\d+/)?.[0] ?? '', 10);
  const transportName = transportFileName(flavour, solver, Number.isFinite(detectedMajor) ? detectedMajor : null);
  const turbulenceName = turbulenceFileName(flavour);
  const transportProps = constantOverrides[transportName] ?? generateTransportProperties(nu, flavour, transportName);
  const turbProps = constantOverrides[turbulenceName] ?? generateTurbulenceProperties(turbulence, flavour);
  const needsGravity = Boolean(solverInfo?.buoyant);

  // ── Settings: what "Update case" records and restores ───────────────────
  const currentSettings = (): WizardSettings => ({
    flavour, solver, transient, turbulence, nu, inletVelocity, intensity, lengthScale,
    endTime, deltaT, writeInterval, gravity, mesh, meshOverride, systemOverrides, constantOverrides,
    fields, snappy,
  });

  /** A fresh wizard for the detected installation. */
  const defaultSettings = (): WizardSettings => {
    const fl = flavourForVersion(Number.isFinite(detectedMajor) ? detectedMajor : null);
    const p = meshPatches(DEFAULT_MESH);
    const ctx = { inletVelocity: '(1 0 0)', k: 0.00375, epsilon: 0.0027, omega: 8, nu: 1e-5 };
    const first = solverChoices(fl)[0];
    return {
      flavour: fl, solver: first.value, transient: first.transient, turbulence: 'laminar',
      nu: '1e-05', inletVelocity: '(1 0 0)', intensity: '5', lengthScale: '',
      endTime: first.transient ? '0.5' : '500', deltaT: first.transient ? '0.001' : '1', writeInterval: first.transient ? '50' : '100',
      gravity: '(0 -9.81 0)', mesh: DEFAULT_MESH, meshOverride: null, systemOverrides: {}, constantOverrides: {},
      fields: [buildField('U', p, ctx, fl), buildField('p', p, ctx, fl)], snappy: null,
    };
  };

  const applySettings = (s: WizardSettings) => {
    restoringRef.current = true;
    setFlavour(s.flavour); setSolver(s.solver); setTransient(s.transient); setTurbulence(s.turbulence);
    setNu(s.nu); setInletVelocity(s.inletVelocity); setIntensity(s.intensity); setLengthScale(s.lengthScale);
    setEndTime(s.endTime); setDeltaT(s.deltaT); setWriteInterval(s.writeInterval); setGravity(s.gravity);
    setMesh(s.mesh); setMeshOverride(s.meshOverride);
    setSystemOverrides(s.systemOverrides); setConstantOverrides(s.constantOverrides);
    setFields(s.fields); setSnappyState(s.snappy); setActiveFieldIdx(0);
    setRestoreTick(t => t + 1);
  };

  /** Unsaved work in the wizard that loading another case would throw away. */
  const hasPendingUploads = Object.values(geometry).some(g => g.upload);
  const dirty = updateTarget
    ? hasPendingUploads || !settingsEqual(currentSettings(), updateTarget.marker.settings)
    : (caseName.trim() !== '' || step > 0) && !result;

  const fetchGeometry = async (name: string, file: string) => {
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(name)}/geometry?file=${encodeURIComponent(file)}`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      const parsed = await readGeometry(file, new Uint8Array(await res.arrayBuffer()));
      setGeometry(g => (g[file] && !g[file].upload ? { ...g, [file]: { upload: null, parsed } } : g));
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setGeometry(g => (g[file] && !g[file].upload
        ? { ...g, [file]: { upload: null, parsed: null, error: `Could not read it back (${why}); insidePoint is not checked against it.` } }
        : g));
    }
  };

  /** Reopen a wizard-made case: its recorded settings replace the wizard's. */
  const loadCaseForUpdate = async (name: string): Promise<boolean> => {
    setLoadingCase(name);
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(name)}?action=wizardState`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.text === null || data.text === undefined) {
        toast.error(`"${name}" was not created by the wizard, so it has no settings to reopen.`);
        return false;
      }
      const parsed = parseMarker(String(data.text), defaultSettings());
      if (!parsed.marker) { toast.error(parsed.error); return false; }
      flavourPinnedRef.current = true;
      applySettings(parsed.marker.settings);
      setCaseName(name);
      setUpdateTarget({ caseName: name, marker: parsed.marker });
      setResult(null); setReview(null); setStep(0);
      setNameProblems([]); setSyntaxProblems([]);
      // The geometry is in the case; read it back so insidePoint can be checked again.
      const surfaces = parsed.marker.settings.snappy?.surfaces ?? [];
      setGeometry(Object.fromEntries(surfaces.map(s => [s.file, { upload: null, parsed: null }])));
      for (const s of surfaces) void fetchGeometry(name, s.file);
      toast.success(`Loaded the wizard settings of "${name}"`);
      return true;
    } catch (e) {
      toast.error(`Could not read the wizard settings of "${name}": ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      setLoadingCase(null);
    }
  };

  const confirmDiscard = async (target: string) => !dirty || confirmDialog(
    `The wizard has settings that were not written to a case. Loading "${target}" discards them.`,
    { title: 'Discard the wizard settings?', confirmLabel: 'Discard and load', destructive: true },
  );

  // The Dashboard's "Update case" button.
  const handledRequest = useRef(0);
  useEffect(() => {
    if (!openRequest || openRequest.n === handledRequest.current) return;
    handledRequest.current = openRequest.n;
    if (updateTarget?.caseName === openRequest.caseName) return;
    void (async () => {
      if (await confirmDiscard(openRequest.caseName)) await loadCaseForUpdate(openRequest.caseName);
    })();
  }, [openRequest]);

  const startNewCase = async () => {
    if (dirty && updateTarget && !(await confirmDialog(
      `Changes made since "${updateTarget.caseName}" was loaded have not been written. Start a new case anyway?`,
      { title: 'Discard the changes?', confirmLabel: 'Discard', destructive: true },
    ))) return;
    flavourPinnedRef.current = false;
    applySettings(defaultSettings());
    setCaseName(''); setUpdateTarget(null); setResult(null); setReview(null);
    setGeometry({}); setStep(0); setDecisions({});
  };

  // ── Mesh mode ───────────────────────────────────────────────────────────
  const setSnappy = (update: (s: SnappySettings) => SnappySettings) => setSnappyState(s => (s ? update(s) : s));

  const enableSnappy = () => {
    if (!snappySupport?.available) return;
    setSnappyState(s => s ?? { ...DEFAULT_SNAPPY });
    // snappyHexMesh is 3D and reads the geometry in its own units.
    setMesh(m => ({ ...m, twoD: false, scale: 1 }));
  };

  const disableSnappy = async () => {
    if (!snappy) return;
    if (snappy.surfaces.length && !(await confirmDialog(
      'Back to blockMesh only: the imported geometry and the snappyHexMesh settings are dropped.',
      { title: 'Box only', confirmLabel: 'Drop them', destructive: true },
    ))) return;
    setSnappyState(null);
    setGeometry({});
  };

  // ── Field editing ───────────────────────────────────────────────────────
  const updateField = (i: number, u: Partial<FieldConfig>) =>
    setFields(prev => prev.map((f, idx) => (idx === i ? { ...f, ...u } : f)));

  const removeField = (i: number) => {
    setFields(prev => prev.filter((_, idx) => idx !== i));
    setActiveFieldIdx(prev => Math.max(0, prev > i ? prev - 1 : Math.min(prev, fields.length - 2)));
  };

  const addBC = (fi: number) =>
    updateField(fi, { boundaryConditions: [...fields[fi].boundaryConditions, { name: '', type: 'fixedValue', value: '' }] });

  const updateBC = (fi: number, bi: number, u: Partial<{ name: string; type: string; value: string }>) =>
    updateField(fi, {
      boundaryConditions: fields[fi].boundaryConditions.map((bc, idx) => (idx === bi ? { ...bc, ...u } : bc)),
    });

  const removeBC = (fi: number, bi: number) =>
    updateField(fi, { boundaryConditions: fields[fi].boundaryConditions.filter((_, idx) => idx !== bi) });

  /** Rebuild the generated fields from the current physics inputs. */
  const applyPhysicsToFields = () => {
    const managed = new Set([...CORE_FIELDS, ...turbulenceFieldNames(turbulence)]);
    setFields(prev => prev.map(f =>
      managed.has(f.fieldName) ? buildField(f.fieldName, patches, fieldCtx, flavour) : f
    ));
    toast.success('Boundary conditions regenerated from the physics inputs');
  };

  const handleCreateNewField = () => {
    const name = newFieldName.trim();
    if (!name) { toast.error('Enter a name'); return; }
    if (/\s/.test(name)) { toast.error('No spaces in the name'); return; }
    if (fields.some(f => f.fieldName === name)) { toast.error(`Field "${name}" already exists`); return; }
    setFields(prev => [...prev, buildField(name, patches, fieldCtx, flavour)]);
    setActiveFieldIdx(fields.length);
    setNewFieldName('');
    setShowNewFieldDialog(false);
    toast.success(`Field "${name}" added`);
  };

  const previewFile = (content: string, name: string) => {
    setPreviewContent(content); setPreviewField(name); setShowPreview(true);
  };

  // ── insidePoint: in the box, and clear of the body ──────────────────────
  const insideCheck: InsideCheck = useMemo(() => {
    if (!snappy) return { tone: 'unknown', message: '' };
    const p = snappy.insidePoint;
    if (!p.every(Number.isFinite)) return { tone: 'bad', message: 'insidePoint must be three numbers.' };
    if (!pointInBox(p, { min: [mesh.x0, mesh.y0, mesh.z0], max: [mesh.x1, mesh.y1, mesh.z1] })) {
      return { tone: 'bad', message: 'Outside the background box: snappyHexMesh would find no fluid to keep.' };
    }
    if (!snappy.surfaces.length) return { tone: 'unknown', message: 'Inside the background box. Import a geometry to check it is clear of the body.' };
    const inside = snappy.surfaces.filter(s => { const g = geometry[s.file]?.parsed; return g ? pointInsideSurface(g, p) : false; });
    if (inside.length) {
      return {
        tone: 'bad',
        message: `insidePoint is inside ${inside.map(s => s.name).join(', ')}: snappyHexMesh would mesh the inside of the body and drop the flow around it. (Only right for an internal flow, where the fluid is inside the surface.)`,
      };
    }
    const unchecked = snappy.surfaces.filter(s => !geometry[s.file]?.parsed);
    if (unchecked.length) {
      return { tone: 'unknown', message: `Inside the background box; not yet checked against ${unchecked.map(s => s.name).join(', ')}, whose geometry is not loaded.` };
    }
    return { tone: 'ok', message: 'Inside the background box and outside the geometry.' };
  }, [snappy, geometry, mesh]);

  // ── Preflight checks, shown on the last step ────────────────────────────
  const problems = useMemo(() => {
    const out: string[] = [];
    const name = caseName.trim();
    // The same rule the server applies, from the same module — the two used to
    // be written separately and disagreed, so the wizard approved names like
    // ".hidden" that creation then refused, and refused names like "café" that
    // it would have accepted.
    const nameProblem = caseNameProblem(name);
    if (nameProblem) out.push(nameProblem);
    else if (!updateTarget && existingCases.includes(name)) out.push(`A case called "${name}" already exists — creating will overwrite its files.`);

    if (!blockMeshDict.trim()) out.push('system/blockMeshDict is empty, so blockMesh has nothing to build.');
    // A degenerate, inverted or enormous box is only discovered by blockMesh
    // otherwise, and it reports it in terms of face normals and cell indices.
    out.push(...meshProblems(mesh));
    if (snappy) {
      out.push(...snappyProblems(snappy, mesh, insideCheck.tone === 'bad' && insideCheck.message.startsWith('insidePoint is inside') ? insideCheck.message : null));
      if (flavour !== 'modular') out.push('snappyHexMesh is guided on OpenFOAM 13 and 14, which use the 11+ layout: switch the layout on the first step.');
      if (snappySupport && !snappySupport.available) out.push(`snappyHexMesh: ${snappySupport.reason}`);
      for (const s of snappy.surfaces) {
        if (!updateTarget && !geometry[s.file]?.upload) out.push(`${s.name}: its geometry file is not loaded; import it again.`);
      }
    }
    if (fields.length === 0) out.push('No fields in 0/.');

    const patchNames = new Set(patches.map(p => p.name));
    for (const f of fields) {
      if (!f.fieldName.trim()) { out.push('A field has no name.'); continue; }
      const covered = new Set(f.boundaryConditions.map(bc => bc.name.trim()).filter(Boolean));
      const missing = [...patchNames].filter(p => !covered.has(p));
      if (missing.length) out.push(`0/${f.fieldName} has no condition for: ${missing.join(', ')}.`);
      const extra = [...covered].filter(p => !patchNames.has(p));
      if (extra.length) out.push(`0/${f.fieldName} defines patches the mesh does not have: ${extra.join(', ')}.`);
    }

    for (const n of turbulenceFieldNames(turbulence)) {
      if (!fields.some(f => f.fieldName === n)) out.push(`${turbulence} needs a 0/${n} field.`);
    }
    if (turbulence === 'laminar' && staleTurbulenceFields.length) {
      out.push(`Laminar run, but 0/ still carries ${staleTurbulenceFields.join(', ')}.`);
    }

    for (const p of nameProblems) {
      out.push(
        `${p.where}: "${p.name}" does not exist in this OpenFOAM` +
        (p.suggestions.length ? ` — did you mean ${p.suggestions.join(', ')}?` : '.'),
      );
    }
    for (const p of syntaxProblems) {
      out.push(`${p.path}: OpenFOAM cannot parse this file — ${p.message}${p.line ? ` (line ${p.line})` : ''}.`);
    }
    return out;
  }, [caseName, existingCases, updateTarget, blockMeshDict, mesh, snappy, insideCheck, flavour, snappySupport, geometry,
      fields, patches, turbulence, staleTurbulenceFields, nameProblems, syntaxProblems]);

  const filesToWrite = useMemo(() => {
    const list: { path: string; content: string }[] = [];
    for (const f of fields) if (f.fieldName.trim()) list.push({ path: `0/${f.fieldName}`, content: generateFieldFile(f, flavour) });
    list.push({ path: 'system/controlDict', content: controlDict });
    list.push({ path: 'system/fvSchemes', content: fvSchemes });
    list.push({ path: 'system/fvSolution', content: fvSolution });
    list.push({ path: 'system/blockMeshDict', content: blockMeshDict });
    if (snappy) {
      list.push({ path: 'system/snappyHexMeshDict', content: snappyDict });
      list.push({ path: 'system/surfaceFeaturesDict', content: featuresDict });
      list.push({ path: 'system/meshQualityDict', content: generateMeshQualityDict() });
    }
    list.push({ path: `constant/${transportName}`, content: transportProps });
    list.push({ path: `constant/${turbulenceName}`, content: turbProps });
    if (needsGravity) list.push({ path: 'constant/g', content: generateGravity(gravity, flavour) });
    return list;
  }, [fields, flavour, controlDict, fvSchemes, fvSolution, blockMeshDict, snappy, snappyDict, featuresDict,
      transportName, turbulenceName, transportProps, turbProps, needsGravity, gravity]);

  /** Geometry files with new bytes (imported in this session), and the ones already in the case. */
  const geometryUploads = (snappy?.surfaces ?? [])
    .filter(s => geometry[s.file]?.upload)
    .map(s => ({ path: geometryPath(s.file), file: s.file, bytes: geometry[s.file].upload! }));
  const geometryKept = (snappy?.surfaces ?? [])
    .filter(s => !geometry[s.file]?.upload)
    .map(s => geometryPath(s.file));

  useEffect(() => {
    if (step !== 6) return;
    let cancelled = false;
    setInstallCheck('checking');
    // Findings from an earlier run describe files that are no longer the ones
    // about to be written, so a check that cannot run clears them.
    const unavailable = () => { setNameProblems([]); setSyntaxProblems([]); setInstallCheck('unavailable'); };
    (async () => {
      try {
        const res = await fetch('/api/foam-index', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'validate', files: filesToWrite }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!data?.ready) { unavailable(); return; }
        if (Array.isArray(data.problems)) setNameProblems(data.problems);
        if (Array.isArray(data.syntax)) setSyntaxProblems(data.syntax);
        setInstallCheck('done');
      } catch {
        if (!cancelled) unavailable();
      }
    })();
    return () => { cancelled = true; };
  }, [step, filesToWrite]);

  /** The hashes the record keeps: of every text file, and of each geometry file's bytes. */
  const hashesOf = async (texts: { path: string; content: string }[], geo: { path: string; bytes: Uint8Array }[]) => {
    const out: Record<string, string> = {};
    for (const f of texts) out[f.path] = await sha256Hex(f.content);
    for (const g of geo) out[g.path] = await sha256Hex(g.bytes);
    return out;
  };

  const saveMarker = async (name: string, marker: WizardMarker): Promise<boolean> =>
    writeCaseFile(name, WIZARD_MARKER_PATH, serializeMarker(marker));

  const handleCreate = async () => {
    const c = caseName.trim();
    if (!c) { toast.error('Enter a case name'); setStep(0); return; }

    // The API creates directories with `mkdir -p`, so writing into a name that
    // already exists silently replaces that case's files. Ask the server now:
    // the list read when the wizard first opened misses every case made since,
    // because the tab stays mounted once visited.
    const known = (await refreshCases()) ?? existingCases;
    if (known.includes(c)) {
      const ok = await confirmDialog(
        `A case called "${c}" already exists. Creating it again overwrites ${filesToWrite.length + geometryUploads.length} of its files. Continue?`,
        { title: 'Case exists', confirmLabel: 'Overwrite', destructive: true }
      );
      if (!ok) return;
    }

    setCreating(true);
    const failed: string[] = [];
    try {
      const created = await fetch('/api/cases', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // The server refuses an existing name unless told the user agreed.
        body: JSON.stringify({ action: 'create', caseName: c, overwrite: known.includes(c) }),
      });
      if (!created.ok) {
        const msg = await created.json().catch(() => ({}));
        throw new Error(msg.error || `could not create the case directory (HTTP ${created.status})`);
      }

      for (const file of filesToWrite) {
        if (!(await writeCaseFile(c, file.path, file.content))) failed.push(file.path);
      }
      for (const g of geometryUploads) {
        try { await uploadGeometry(c, g.file, g.bytes); } catch (e) {
          failed.push(`${g.path} (${e instanceof Error ? e.message : String(e)})`);
        }
      }

      const total = filesToWrite.length + geometryUploads.length;
      if (failed.length) {
        toast.error(`${failed.length} of ${total} files failed: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}`);
      } else {
        // The record that makes "Update case" possible. Without it the case is
        // fine, it simply cannot be reopened here, and the user is told so.
        const marker = buildMarker(currentSettings(), await hashesOf(filesToWrite, geometryUploads), detectedVersion, null);
        const recorded = await saveMarker(c, marker);
        setGeometry(g => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, { ...v, upload: null }])));
        if (recorded) setUpdateTarget({ caseName: c, marker });
        setResult({ caseName: c, kind: 'created', meshStale: true, hasMesh: false, steps: meshSteps(snappy), failed: [] });
        if (recorded) toast.success(`Case "${c}" created: ${total} files.`);
        else toast.warning(`Case "${c}" created, but ${WIZARD_MARKER_PATH} could not be written, so it cannot be updated from the wizard.`);
      }
      await refreshCases();
      onCreated();
    } catch (e) {
      toast.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCreating(false);
    }
  };

  /** Compare the wizard's files with the case and show what an update would do. */
  const handleReviewUpdate = async () => {
    if (!updateTarget) return;
    const c = updateTarget.caseName;
    setCreating(true);
    try {
      const next = await hashesOf(filesToWrite, geometryUploads);
      const untouched = geometryKept;
      const recorded = updateTarget.marker.files;
      const paths = [...new Set([...Object.keys(next), ...Object.keys(recorded), ...untouched, 'constant/polyMesh/boundary'])];
      const res = await fetch(`/api/cases/${encodeURIComponent(c)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'hashFiles', paths }),
      });
      const data = await res.json();
      if (!res.ok || !data?.hashes) throw new Error(data?.error || `HTTP ${res.status}`);
      const onDisk = data.hashes as Record<string, string | null>;

      const lostGeometry = untouched.filter(p => onDisk[p] === null);
      if (lostGeometry.length) {
        toast.error(`${lostGeometry.join(', ')} is no longer in the case. Remove that surface and import the file again.`);
        return;
      }

      const plan = planUpdate({ recorded, onDisk, next, untouched });
      const hasMesh = onDisk['constant/polyMesh/boundary'] !== null;
      if (plan.every(e => e.action === 'same')) {
        // The files already match; record the settings anyway if they changed
        // (a value no file depends on, for instance).
        if (!settingsEqual(currentSettings(), updateTarget.marker.settings)) {
          const marker = buildMarker(currentSettings(), resolvePlan(plan, {}, next, recorded, untouched).recorded, detectedVersion, updateTarget.marker);
          if (await saveMarker(c, marker)) setUpdateTarget({ caseName: c, marker });
        }
        setResult({ caseName: c, kind: 'unchanged', meshStale: false, hasMesh, steps: meshSteps(snappy), failed: [] });
        toast.success('Nothing to update: the case files already match these settings.');
        return;
      }
      // The safe answer is preselected for every conflict: leave the file alone.
      setDecisions(Object.fromEntries(plan.filter(e => e.action === 'conflict').map(e => [e.path, 'keep' as Decision])));
      setReview({ plan, next, untouched, contents: Object.fromEntries(filesToWrite.map(f => [f.path, f.content])), hasMesh });
    } catch (e) {
      toast.error(`Could not compare with the case: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCreating(false);
    }
  };

  const applyUpdate = async () => {
    if (!review || !updateTarget) return;
    const c = updateTarget.caseName;
    const resolved = resolvePlan(review.plan, decisions, review.next, updateTarget.marker.files, review.untouched);
    if (resolved.undecided.length) return;
    setApplying(true);
    const failed: string[] = [];
    // A write or deletion that failed leaves the disk as it was, so the record
    // keeps what it said before for that path.
    const keepOld = (p: string) => {
      if (updateTarget.marker.files[p]) resolved.recorded[p] = updateTarget.marker.files[p];
      else delete resolved.recorded[p];
    };
    try {
      for (const p of resolved.write) {
        const upload = geometryUploads.find(g => g.path === p);
        if (upload) {
          try { await uploadGeometry(c, upload.file, upload.bytes); } catch { failed.push(p); keepOld(p); }
        } else if (!(await writeCaseFile(c, p, review.contents[p] ?? ''))) {
          failed.push(p); keepOld(p);
        }
      }
      for (const p of resolved.remove) {
        const res = await fetch(`/api/cases/${encodeURIComponent(c)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'deletePath', path: p }),
        }).catch(() => null);
        if (!res || !res.ok) { failed.push(p); keepOld(p); }
      }

      const marker = buildMarker(currentSettings(), resolved.recorded, detectedVersion, updateTarget.marker);
      if (!(await saveMarker(c, marker))) failed.push(WIZARD_MARKER_PATH);
      else setUpdateTarget({ caseName: c, marker });
      setGeometry(g => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, { ...v, upload: null }])));

      const meshStale = [...resolved.write, ...resolved.remove].some(isMeshInput);
      setResult({ caseName: c, kind: 'updated', meshStale, hasMesh: review.hasMesh, steps: meshSteps(snappy), failed });
      setReview(null);
      if (failed.length) toast.error(`${failed.length} change${failed.length > 1 ? 's' : ''} could not be applied: ${failed.slice(0, 3).join(', ')}`);
      else toast.success(`"${c}" updated: ${resolved.write.length} written, ${resolved.remove.length} removed.`);
      onCreated();
    } finally {
      setApplying(false);
    }
  };

  // Last effect on purpose: see restoringRef.
  useEffect(() => { restoringRef.current = false; }, [restoreTick]);

  const activeField = fields[Math.min(activeFieldIdx, Math.max(0, fields.length - 1))];
  const meshField = (label: string, key: keyof MeshSpec, step = 'any') => (
    <div>
      <Label className="text-xs">{label}</Label>
      <Input
        type="number" step={step} value={String(mesh[key])}
        onChange={(e) => setMesh(m => ({ ...m, [key]: Number(e.target.value) }))}
        className="font-mono text-xs h-8 mt-0.5"
      />
    </div>
  );
  const cellCount = Math.max(1, Math.round(mesh.nx)) * Math.max(1, Math.round(mesh.ny)) * (mesh.twoD ? 1 : Math.max(1, Math.round(mesh.nz)));
  const canJump = (i: number) => !!updateTarget || i <= step;
  const versionMismatch = updateTarget?.marker.foamVersion && detectedVersion && updateTarget.marker.foamVersion !== detectedVersion;

  return (
    <div className="space-y-4">
      {/* What the last Create / Update did, and what to do next */}
      {result && (
        <Card className="border-emerald-300 dark:border-emerald-800">
          <CardContent className="p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap text-sm">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>
                {result.kind === 'created' && <>Case <span className="font-mono font-medium">{result.caseName}</span> created.</>}
                {result.kind === 'updated' && <>Case <span className="font-mono font-medium">{result.caseName}</span> updated{result.failed.length ? `, except ${result.failed.length} file${result.failed.length > 1 ? 's' : ''}` : ''}.</>}
                {result.kind === 'unchanged' && <>The files of <span className="font-mono font-medium">{result.caseName}</span> already match these settings.</>}
              </span>
              <div className="ml-auto flex gap-1">
                {onOpenCase && (
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onOpenCase(result.caseName)}>
                    <FolderOpen className="w-3 h-3 mr-1" /> Open case
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void startNewCase()}>
                  <Plus className="w-3 h-3 mr-1" /> New case
                </Button>
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setResult(null)} aria-label="Dismiss" title="Dismiss">
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>

            {result.kind === 'created' && (
              <p className="text-xs text-muted-foreground">
                Next, build the mesh (below), then run <span className="font-mono">{runCommand(flavour, solver)}</span> from
                the Commands panel. The wizard keeps this case open: go back to any step and review the update to change it.
              </p>
            )}
            {result.kind !== 'created' && result.meshStale && result.hasMesh && (
              <p className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1">
                <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
                The mesh in constant/polyMesh was built from the previous mesh settings and no longer matches them.
                Rebuild it when you are ready; nothing was re-meshed.
              </p>
            )}
            {result.kind !== 'created' && !result.hasMesh && (
              <p className="text-xs text-muted-foreground">The case has no mesh yet.</p>
            )}
            {result.kind !== 'created' && result.hasMesh && !result.meshStale && (
              <p className="text-xs text-muted-foreground">The mesh is not affected by these changes.</p>
            )}
            {(result.kind === 'created' || result.meshStale || !result.hasMesh) && onShowMesh && (
              <MeshRunPanel key={`${result.caseName}|${result.kind}|${restoreTick}`} caseName={result.caseName} steps={result.steps} onShowMesh={onShowMesh} />
            )}
          </CardContent>
        </Card>
      )}

      {/* Update mode */}
      {updateTarget && (
        <div className="flex items-center gap-2 rounded-md border border-violet-300 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/20 px-3 py-2 text-xs flex-wrap">
          <Wand2 className="w-4 h-4 text-violet-600 flex-shrink-0" />
          <span>
            Updating <span className="font-mono font-medium">{updateTarget.caseName}</span>
            {updateTarget.marker.createdAt && <>, created by the wizard on {new Date(updateTarget.marker.createdAt).toLocaleDateString()}</>}.
            Nothing is written until you review the update on the last step.
          </span>
          {versionMismatch && (
            <span className="text-amber-700 dark:text-amber-400">
              Recorded with OpenFOAM {updateTarget.marker.foamVersion}; the selected installation is {detectedVersion}.
            </span>
          )}
          <Button size="sm" variant="ghost" className="ml-auto h-6 text-xs" onClick={() => void startNewCase()}>New case instead</Button>
        </div>
      )}

      {/* Progress bar */}
      <div className="flex items-center gap-0">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium rounded-t-lg transition-colors ${
              i === step ? 'bg-primary text-primary-foreground' : i < step ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
            }`}
            onClick={() => canJump(i) && setStep(i)}
          >
            {i < step ? <CheckCircle2 className="w-3.5 h-3.5" /> : s.icon}
            <span className="hidden md:inline">{i === STEPS.length - 1 && updateTarget ? 'Update!' : s.title}</span>
          </button>
        ))}
      </div>

      {/* STEP 0: name + target version */}
      {step === 0 && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Settings className="w-5 h-5" /> Case Name</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label>Case name *</Label>
              <Input
                value={caseName}
                onChange={(e) => setCaseName(e.target.value.replace(/\s/g, ''))}
                placeholder="e.g. pipeFlow, airfoilTest, myCavity"
                className="font-mono"
                disabled={!!updateTarget}
              />
              <p className="text-xs text-muted-foreground mt-1">
                {updateTarget
                  ? 'The case being updated. Rename it from the Dashboard; the wizard settings go with it.'
                  : <>Letters, numbers, <code>. - _</code>. This becomes the folder name in $FOAM_RUN.</>}
              </p>
              {/* The same rule the summary applies, shown where the name is typed:
                  an invalid name used to surface only at the last step. */}
              {caseName.trim() && caseNameProblem(caseName.trim()) && (
                <p className="text-xs text-danger mt-1 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> {caseNameProblem(caseName.trim())}
                </p>
              )}
              {!updateTarget && caseName.trim() && existingCases.includes(caseName.trim()) && (
                <p className="text-xs text-amber-600 mt-1 flex items-center gap-1 flex-wrap">
                  <AlertTriangle className="w-3 h-3" /> A case with this name already exists.
                  {wizardCases.includes(caseName.trim()) && (
                    <Button size="sm" variant="link" className="h-auto p-0 text-xs"
                      onClick={() => void loadCaseForUpdate(caseName.trim())}>
                      It was made by the wizard: load it to update it instead.
                    </Button>
                  )}
                </p>
              )}
            </div>

            {!updateTarget && wizardCases.length > 0 && (
              <div className="rounded-md border px-3 py-2 space-y-1.5">
                <Label className="text-sm flex items-center gap-1.5"><Wand2 className="w-3.5 h-3.5" /> Or update a case the wizard made</Label>
                <div className="flex gap-2 items-center flex-wrap">
                  <Select value={pickedCase} onValueChange={setPickedCase}>
                    <SelectTrigger className="w-64 font-mono text-sm"><SelectValue placeholder="Choose a case" /></SelectTrigger>
                    <SelectContent>
                      {wizardCases.map(n => <SelectItem key={n} value={n} className="font-mono text-xs">{n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" disabled={!pickedCase || !!loadingCase}
                    onClick={async () => { if (await confirmDiscard(pickedCase)) await loadCaseForUpdate(pickedCase); }}>
                    {loadingCase ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null} Load its settings
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Cases made by the wizard carry {WIZARD_MARKER_PATH}; others cannot be reopened here.
                </p>
              </div>
            )}

            <Separator />

            <div>
              <Label className="flex items-center gap-2">
                Case layout
                {detectedVersion && <Badge variant="secondary" className="font-mono text-[10px]">detected: v{detectedVersion}</Badge>}
              </Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mt-1">
                {([
                  { v: 'modular' as Flavour, l: 'OpenFOAM 11 → 14', d: 'foamRun -solver …, physicalProperties + momentumTransport' },
                  { v: 'legacy' as Flavour, l: 'OpenFOAM 9 / 10', d: 'application simpleFoam, transportProperties + turbulenceProperties' },
                ]).map(o => (
                  <button
                    key={o.v}
                    onClick={() => { flavourPinnedRef.current = true; setFlavour(o.v); }}
                    className={`text-left px-3 py-2 rounded-lg border text-sm transition-colors ${flavour === o.v ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}
                  >
                    <div className="font-medium">{o.l}</div>
                    <div className="text-[10px] text-muted-foreground font-mono">{o.d}</div>
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                OpenFOAM 11 replaced the solver executables with solver modules and renamed the
                constant/ dictionaries. A case written the old way will not run on 11+.
              </p>
            </div>

            <div className="bg-muted/50 p-3 rounded text-sm">
              <div className="font-medium mb-1 flex items-center gap-1.5"><Info className="w-3.5 h-3.5" /> Tip</div>
              <p className="text-muted-foreground">
                For a ready-made case, copy an <strong>OpenFOAM tutorial</strong> from the Dashboard
                (&quot;Tutorial&quot; tab). This wizard builds a <strong>custom case from scratch</strong>,
                with a parametric box mesh, optionally around an imported geometry.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* STEP 1: solver + physics */}
      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Zap className="w-5 h-5" /> Solver &amp; Physics</CardTitle>
            <CardDescription>
              {flavour === 'modular'
                ? 'Solver modules are run with foamRun and named in system/controlDict.'
                : 'The solver executable is named in system/controlDict.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>{flavour === 'modular' ? 'Solver module' : 'Solver application'}</Label>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 mt-1">
                {solverChoices(flavour).map(s => (
                  <button
                    key={s.value}
                    className={`text-left px-3 py-2 rounded-lg border text-sm transition-colors ${solver === s.value ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}
                    onClick={() => setSolver(s.value)}
                  >
                    <div className="font-mono font-medium">{s.label}</div>
                    <div className="text-xs text-muted-foreground">{s.desc}</div>
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1.5">
                Only solvers whose files this wizard can write are listed. For compressible, multiphase,
                reacting or solid cases, start from a tutorial: Dashboard → Tutorial.
              </p>
            </div>

            <Separator />

            <div className="flex flex-wrap items-center gap-4">
              <div>
                <Label className="mb-1 block">Time treatment</Label>
                <div className="flex gap-1.5">
                  {[{ v: false, l: 'Steady-state' }, { v: true, l: 'Transient' }].map(t => (
                    <button
                      key={String(t.v)}
                      onClick={() => setTransient(t.v)}
                      className={`px-3 py-1.5 rounded-lg border text-sm transition-colors ${transient === t.v ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}
                    >{t.l}</button>
                  ))}
                </div>
              </div>
              <div>
                <Label className="text-xs">endTime</Label>
                <Input value={endTime} onChange={e => setEndTime(e.target.value)} className="font-mono text-xs h-8 w-28 mt-0.5" />
              </div>
              <div>
                <Label className="text-xs">deltaT</Label>
                <Input value={deltaT} onChange={e => setDeltaT(e.target.value)} className="font-mono text-xs h-8 w-28 mt-0.5" />
              </div>
              <div>
                <Label className="text-xs">writeInterval</Label>
                <Input value={writeInterval} onChange={e => setWriteInterval(e.target.value)} className="font-mono text-xs h-8 w-28 mt-0.5" />
              </div>
            </div>

            <Separator />

            <div>
              <Label>Turbulence model</Label>
              <div className="flex flex-wrap gap-2 mt-1">
                {TURBULENCE_MODELS.map(t => (
                  <button
                    key={t.value}
                    className={`text-left px-3 py-2 rounded-lg border text-sm transition-colors ${turbulence === t.value ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}
                    onClick={() => setTurbulence(t.value)}
                  >
                    <div className="font-medium">{t.label}</div>
                    <div className="text-[10px] text-muted-foreground">{t.desc}</div>
                  </button>
                ))}
              </div>
              {turbulence !== 'laminar' && (
                <p className="text-xs text-muted-foreground mt-1.5">
                  Adds <code className="font-mono">{turbulenceFieldNames(turbulence).join(', ')}</code> to 0/ automatically.
                </p>
              )}
            </div>

            <Separator />

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <Label className="text-xs">Kinematic viscosity ν [m²/s]</Label>
                <Input value={nu} onChange={e => setNu(e.target.value)} className="font-mono text-xs h-8 mt-0.5" />
                <p className="text-[10px] text-muted-foreground mt-0.5">air 1.5e-05 · water 1e-06</p>
              </div>
              <div>
                <Label className="text-xs">Inlet velocity</Label>
                <Input value={inletVelocity} onChange={e => setInletVelocity(e.target.value)} className="font-mono text-xs h-8 mt-0.5" placeholder="(1 0 0)" />
              </div>
              <div>
                <Label className="text-xs">Turbulence intensity [%]</Label>
                <Input value={intensity} onChange={e => setIntensity(e.target.value)} className="font-mono text-xs h-8 mt-0.5" />
              </div>
              <div>
                <Label className="text-xs">Length scale L [m]</Label>
                <Input
                  value={lengthScale} onChange={e => setLengthScale(e.target.value)}
                  className="font-mono text-xs h-8 mt-0.5"
                  placeholder={String((0.07 * Math.abs(mesh.y1 - mesh.y0)).toFixed(4))}
                />
                <p className="text-[10px] text-muted-foreground mt-0.5">empty = 7% of the box height</p>
              </div>
            </div>

            {turbulence !== 'laminar' && (
              <div className="bg-muted/40 rounded p-2.5 text-xs font-mono flex flex-wrap gap-x-5 gap-y-1">
                <span>k = {turbEstimate.k}</span>
                <span>ε = {turbEstimate.epsilon}</span>
                <span>ω = {turbEstimate.omega}</span>
                <span className="text-muted-foreground font-sans">
                  k = 1.5(U·I)² · ε = Cμ¾k^1.5/L · ω = √k/(Cμ¼L)
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* STEP 2: mesh */}
      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Grid3x3 className="w-5 h-5" /> Mesh</CardTitle>
            <CardDescription>
              {snappy
                ? <>The box is the background mesh snappyHexMesh refines around the geometry. The patches — {patches.map(p => p.name).join(', ')} — are what the boundary conditions in 0/ are generated against; each surface&apos;s patches are one group.</>
                : <>A single-block box. The patches defined here — {patches.map(p => p.name).join(', ')} — are what the boundary conditions in 0/ are generated against.</>}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* The option: the default stays blockMesh only. */}
            <div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                <button
                  onClick={() => void disableSnappy()}
                  className={`text-left px-3 py-2 rounded-lg border text-sm transition-colors ${!snappy ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}
                >
                  <div className="font-medium">Box only (blockMesh)</div>
                  <div className="text-[10px] text-muted-foreground">A single-block box with inlet, outlet and walls patches</div>
                </button>
                <button
                  onClick={enableSnappy}
                  disabled={!snappySupport?.available && !snappy}
                  aria-disabled={!snappySupport?.available}
                  className={`text-left px-3 py-2 rounded-lg border text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${snappy ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}
                >
                  <div className="font-medium">Box + geometry (snappyHexMesh)</div>
                  <div className="text-[10px] text-muted-foreground">Import an STL/OBJ; surfaceFeatures and snappyHexMesh mesh around it</div>
                </button>
              </div>
              {snappySupport === null ? (
                <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Checking the installation for snappyHexMesh support…</p>
              ) : !snappySupport.available && (
                <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1"><Info className="w-3 h-3 flex-shrink-0" /> {snappySupport.reason}</p>
              )}
            </div>

            <Separator />

            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              {meshField('x min', 'x0')}
              {meshField('x max', 'x1')}
              {meshField('y min', 'y0')}
              {meshField('y max', 'y1')}
              {meshField('z min', 'z0')}
              {meshField('z max', 'z1')}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-end">
              {meshField('cells x', 'nx', '1')}
              {meshField('cells y', 'ny', '1')}
              <div className={mesh.twoD ? 'opacity-50 pointer-events-none' : ''}>
                {meshField('cells z', 'nz', '1')}
              </div>
              {meshField('scale', 'scale')}
              <label className={`flex items-center gap-2 h-8 ${snappy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`} title={snappy ? 'snappyHexMesh builds a 3D mesh' : undefined}>
                <Checkbox checked={mesh.twoD} disabled={!!snappy} onCheckedChange={v => setMesh(m => ({ ...m, twoD: v as boolean }))} />
                <span className="text-sm">2D case</span>
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              {mesh.twoD
                ? 'A 2D case has one cell across z and the two z faces become an empty patch — that is what makes OpenFOAM solve it in 2D.'
                : 'Full 3D: the z faces join the walls patch.'}
              {' '}{snappy ? 'Background cells' : 'Cells'}: <span className="font-mono">{cellCount}</span>.
            </p>

            {snappy && (
              <>
                <Separator />
                <SnappySection
                  snappy={snappy}
                  setSnappy={setSnappy}
                  mesh={mesh}
                  setMesh={(u) => setMesh(m => u(m))}
                  geometry={geometry}
                  setGeometry={(u) => setGeometry(g => u(g))}
                  insideCheck={insideCheck}
                  snappyDict={snappyDict}
                  featuresDict={featuresDict}
                  onPreview={previewFile}
                />
              </>
            )}

            <Separator />

            <div>
              <div className="flex items-center justify-between mb-1">
                <Label>system/blockMeshDict{snappy ? ' (background mesh)' : ''} {meshOverride !== null && <Badge variant="secondary" className="ml-1 text-[10px]">edited by hand</Badge>}</Label>
                <div className="flex gap-1">
                  {meshOverride !== null && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setMeshOverride(null)}>
                      <RefreshCw className="w-3 h-3 mr-1" /> Regenerate from the form
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => previewFile(blockMeshDict, 'system/blockMeshDict')}>
                    <Eye className="w-3 h-3 mr-1" /> Preview
                  </Button>
                </div>
              </div>
              <Textarea
                value={blockMeshDict}
                onChange={(e) => setMeshOverride(e.target.value)}
                className="font-mono text-xs min-h-[320px]"
                spellCheck={false}
              />
              {meshOverride !== null && (
                <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  Hand-edited: the fields above no longer change this file. If you renamed a patch, update the boundary conditions in 0/ to match.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* STEP 3: fields */}
      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Wind className="w-5 h-5" /> Initial Fields (0/)</CardTitle>
            <CardDescription>One condition per mesh patch, per field.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Label className="font-semibold text-sm">Active field:</Label>
              <Select value={String(activeFieldIdx)} onValueChange={(v) => setActiveFieldIdx(Number(v))}>
                <SelectTrigger className="w-48 font-mono text-sm"><SelectValue placeholder="Select field" /></SelectTrigger>
                <SelectContent>
                  {fields.map((f, i) => (
                    <SelectItem key={i} value={String(i)} className="font-mono text-xs">
                      {f.fieldName || '(unnamed)'}
                      <span className="text-muted-foreground ml-2">({f.boundaryConditions.length} BC)</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Badge variant="secondary" className="text-xs">{fields.length} fields</Badge>
              <div className="ml-auto flex gap-1">
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={applyPhysicsToFields}
                  title="Rebuild U, p and the turbulence fields from the values in the Physics step">
                  <RefreshCw className="w-3 h-3 mr-1" /> Apply physics
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setNewFieldName(''); setShowNewFieldDialog(true); }}>
                  <Plus className="w-3 h-3 mr-1" /> Add field
                </Button>
                {fields.length > 0 && (
                  <Button size="sm" variant="outline" className="h-7 text-xs text-red-500 hover:text-red-700" onClick={() => removeField(activeFieldIdx)}>
                    <Trash2 className="w-3 h-3 mr-1" /> Delete
                  </Button>
                )}
              </div>
            </div>

            {turbulence === 'laminar' && staleTurbulenceFields.length > 0 && (
              <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs">
                <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                <span>The run is laminar but 0/ still has {staleTurbulenceFields.join(', ')}.</span>
                <Button size="sm" variant="ghost" className="h-6 text-xs ml-auto"
                  onClick={() => setFields(prev => prev.filter(f => !staleTurbulenceFields.includes(f.fieldName)))}>
                  Remove them
                </Button>
              </div>
            )}

            {fields.length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                <Wind className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No fields configured.</p>
              </div>
            )}

            {activeField && (
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_1.5fr_1.5fr] gap-2">
                  <div>
                    <Label className="text-xs">Field name</Label>
                    <Input
                      value={activeField.fieldName}
                      onChange={(e) => updateField(activeFieldIdx, { fieldName: e.target.value })}
                      className="font-mono text-sm h-8 mt-0.5"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Dimensions</Label>
                    <Input
                      value={activeField.dimensions}
                      onChange={(e) => updateField(activeFieldIdx, { dimensions: e.target.value })}
                      className="font-mono text-xs h-8 mt-0.5"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Internal value</Label>
                      <Button size="sm" variant="ghost" className="h-5 text-[10px] px-1"
                        onClick={() => previewFile(generateFieldFile(activeField, flavour), `0/${activeField.fieldName}`)}>
                        <Eye className="w-3 h-3 mr-0.5" /> File preview
                      </Button>
                    </div>
                    <Input
                      value={activeField.internalField}
                      onChange={(e) => updateField(activeFieldIdx, { internalField: e.target.value })}
                      className="font-mono text-xs h-8 mt-0.5"
                    />
                  </div>
                </div>

                <Separator />

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <Label className="text-sm font-medium">Boundary conditions ({activeField.boundaryConditions.length})</Label>
                    <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => addBC(activeFieldIdx)}>
                      <Plus className="w-3 h-3 mr-1" /> Add BC
                    </Button>
                  </div>
                  <ScrollArea className="max-h-[300px]">
                    <div className="space-y-2">
                      {activeField.boundaryConditions.map((bc, bi) => {
                        const known = patches.some(p => p.name === bc.name.trim());
                        return (
                          <div key={bi} className="grid grid-cols-[1fr_1.3fr_1fr_auto] gap-1.5 items-center bg-muted/30 p-2 rounded-lg">
                            <Input
                              value={bc.name}
                              onChange={(e) => updateBC(activeFieldIdx, bi, { name: e.target.value })}
                              placeholder="patch"
                              className={`h-7 text-xs font-mono ${known ? '' : 'border-amber-400'}`}
                              title={known ? '' : 'This patch is not in the mesh'}
                            />
                            <Select value={bc.type} onValueChange={(v) => updateBC(activeFieldIdx, bi, { type: v })}>
                              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                              <SelectContent className="max-h-72">
                                {bcTypes.map(t => <SelectItem key={t} value={t} className="text-xs font-mono">{t}</SelectItem>)}
                              </SelectContent>
                            </Select>
                            <Input
                              value={bc.value}
                              onChange={(e) => updateBC(activeFieldIdx, bi, { value: e.target.value })}
                              placeholder="value"
                              className="h-7 text-xs font-mono"
                            />
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-400 flex-shrink-0" aria-label={`Remove the condition on ${bc.name || 'this patch'}`} title="Remove this condition" onClick={() => removeBC(activeFieldIdx, bi)}>
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </ScrollArea>
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    Mesh patches: {patches.map(p => `${p.name} (${p.role})`).join(' · ')}
                  </p>
                  {snappy && snappy.surfaces.length > 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      A <span className="font-mono">…Group</span> entry sets every patch snappyHexMesh cuts from that surface
                      (one per region, named <span className="font-mono">surface_region</span>).
                    </p>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    {bcFromInstall
                      ? `Condition types: ${bcTypes.length}, read from the installed OpenFOAM${detectedVersion ? ' ' + detectedVersion : ''}.`
                      : 'Condition types: built-in short list (the installation has not answered yet).'}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* STEP 4: system/ */}
      {step === 4 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><FileCode className="w-5 h-5" /> system/</CardTitle>
            <CardDescription>Generated from the previous steps. Edit freely — an edited file stays as you left it.</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="controlDict">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="controlDict" className="text-xs">controlDict</TabsTrigger>
                <TabsTrigger value="fvSchemes" className="text-xs">fvSchemes</TabsTrigger>
                <TabsTrigger value="fvSolution" className="text-xs">fvSolution</TabsTrigger>
                <TabsTrigger value="blockMesh" className="text-xs">blockMeshDict</TabsTrigger>
              </TabsList>
              {([
                ['controlDict', controlDict, (v: string) => setSystemOverrides(p => ({ ...p, controlDict: v }))],
                ['fvSchemes', fvSchemes, (v: string) => setSystemOverrides(p => ({ ...p, fvSchemes: v }))],
                ['fvSolution', fvSolution, (v: string) => setSystemOverrides(p => ({ ...p, fvSolution: v }))],
              ] as const).map(([key, value, onChange]) => (
                <TabsContent key={key} value={key}>
                  <Card className="mt-2"><CardContent className="p-2">
                    <Textarea value={value} onChange={(e) => onChange(e.target.value)} className="font-mono text-xs min-h-[350px]" spellCheck={false} />
                    {systemOverrides[key] !== undefined && (
                      <Button size="sm" variant="ghost" className="h-6 text-xs mt-1"
                        onClick={() => setSystemOverrides(p => { const n = { ...p }; delete n[key]; return n; })}>
                        <RefreshCw className="w-3 h-3 mr-1" /> Regenerate
                      </Button>
                    )}
                  </CardContent></Card>
                </TabsContent>
              ))}
              <TabsContent value="blockMesh">
                <Card className="mt-2"><CardContent className="p-2">
                  <Textarea value={blockMeshDict} onChange={(e) => setMeshOverride(e.target.value)} className="font-mono text-xs min-h-[350px]" spellCheck={false} />
                </CardContent></Card>
              </TabsContent>
            </Tabs>
            {snappy && (
              <p className="text-xs text-muted-foreground mt-2">
                snappyHexMeshDict and surfaceFeaturesDict are edited in the Mesh step; meshQualityDict only includes the installation&apos;s defaults.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* STEP 5: constant/ */}
      {step === 5 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Droplets className="w-5 h-5" /> constant/</CardTitle>
            <CardDescription className="font-mono text-xs">
              {transportName} · {turbulenceName}{needsGravity ? ' · g' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="transport">
              <TabsList className={`grid w-full ${needsGravity ? 'grid-cols-3' : 'grid-cols-2'}`}>
                <TabsTrigger value="transport" className="text-xs font-mono">{transportName}</TabsTrigger>
                <TabsTrigger value="turbulence" className="text-xs font-mono">{turbulenceName}</TabsTrigger>
                {needsGravity && <TabsTrigger value="gravity" className="text-xs font-mono">g</TabsTrigger>}
              </TabsList>
              <TabsContent value="transport">
                <Card className="mt-2"><CardContent className="p-2">
                  <Textarea value={transportProps}
                    onChange={(e) => setConstantOverrides(p => ({ ...p, [transportName]: e.target.value }))}
                    className="font-mono text-xs min-h-[250px]" spellCheck={false} />
                </CardContent></Card>
              </TabsContent>
              <TabsContent value="turbulence">
                <Card className="mt-2"><CardContent className="p-2">
                  <Textarea value={turbProps}
                    onChange={(e) => setConstantOverrides(p => ({ ...p, [turbulenceName]: e.target.value }))}
                    className="font-mono text-xs min-h-[250px]" spellCheck={false} />
                </CardContent></Card>
              </TabsContent>
              {needsGravity && (
                <TabsContent value="gravity">
                  <Card className="mt-2"><CardContent className="p-2">
                    <Label className="text-xs">value</Label>
                    <Input value={gravity} onChange={(e) => setGravity(e.target.value)} className="font-mono text-xs h-8 mt-0.5" />
                    <p className="text-xs text-muted-foreground mt-1">
                      {solver} is a buoyant solver, so constant/g is required.
                    </p>
                  </CardContent></Card>
                </TabsContent>
              )}
            </Tabs>
          </CardContent>
        </Card>
      )}

      {/* STEP 6: summary */}
      {step === 6 && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><CheckCircle2 className="w-5 h-5" /> Summary</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                ['Case name', caseName || '—'],
                [flavour === 'modular' ? 'Solver module' : 'Application', solver],
                ['Layout', flavour === 'modular' ? 'OpenFOAM 11+' : 'OpenFOAM ≤10'],
                ['Time', transient ? 'Transient' : 'Steady-state'],
                ['Turbulence', turbulence],
                ['Mesh', snappy
                  ? `snappyHexMesh, ${snappy.surfaces.length} surface${snappy.surfaces.length === 1 ? '' : 's'} on ${cellCount} background cells`
                  : `${cellCount} cells${mesh.twoD ? ', 2D' : ''}`],
                ['Patches', patches.map(p => p.name).join(', ')],
                ['ν', nu],
              ].map(([k, v]) => (
                <div key={k} className="bg-muted/30 p-3 rounded">
                  <div className="text-xs text-muted-foreground">{k}</div>
                  <div className="font-bold font-mono text-sm mt-0.5 break-words">{v}</div>
                </div>
              ))}
            </div>

            {problems.length > 0 ? (
              <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs space-y-1">
                <div className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="w-4 h-4" /> {problems.length} thing{problems.length > 1 ? 's' : ''} to check
                </div>
                <ul className="list-disc pl-5 space-y-0.5">
                  {problems.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              </div>
            ) : installCheck === 'checking' ? (
              <div className="rounded-md border px-3 py-2 text-xs flex items-center gap-1.5 text-muted-foreground">
                <RefreshCw className="w-4 h-4 animate-spin" /> Checking the files with the installation…
              </div>
            ) : installCheck === 'unavailable' ? (
              <div className="rounded-md border px-3 py-2 text-xs flex items-center gap-1.5 text-muted-foreground">
                <Info className="w-4 h-4" /> The installation check could not run; only the wizard&apos;s own checks passed.
              </div>
            ) : (
              <div className="rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20 px-3 py-2 text-xs flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" /> Everything checks out: patches, fields and solver agree.
              </div>
            )}

            <div>
              <Label className="text-sm font-medium">Files ({filesToWrite.length + (snappy?.surfaces.length ?? 0) + 1})</Label>
              <div className="font-mono text-xs mt-1 space-y-0.5 text-muted-foreground columns-2">
                {filesToWrite.map(f => (
                  <div key={f.path} className="flex items-center gap-1">
                    <button className="hover:text-foreground hover:underline text-left" onClick={() => previewFile(f.content, f.path)}>
                      {f.path}
                    </button>
                  </div>
                ))}
                {(snappy?.surfaces ?? []).map(s => (
                  <div key={s.file} title={geometry[s.file]?.upload ? 'Copied into the case' : 'Already in the case'}>
                    {geometryPath(s.file)} <span className="font-sans">({(s.bytes / 1048576).toFixed(1)} MB{geometry[s.file]?.upload ? '' : ', in the case'})</span>
                  </div>
                ))}
                <div title="The wizard's record, which makes Update case possible">{WIZARD_MARKER_PATH}</div>
              </div>
            </div>

            <div className="bg-muted/40 rounded p-3 text-xs">
              <div className="font-medium mb-1">Then</div>
              <pre className="font-mono">{`${meshSteps(snappy).join('\n')}\n${runCommand(flavour, solver)}`}</pre>
              <p className="text-muted-foreground mt-1">The mesh steps can be run from here once the case is {updateTarget ? 'updated' : 'created'}; the solver from the Commands panel.</p>
            </div>

            {updateTarget ? (
              <Button className="w-full py-6 text-base" onClick={handleReviewUpdate} disabled={creating}>
                {creating
                  ? <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> Comparing with the case…</>
                  : <><Wand2 className="w-5 h-5 mr-2" /> Review the update of &quot;{updateTarget.caseName}&quot;</>}
              </Button>
            ) : (
              <Button className="w-full py-6 text-base" onClick={handleCreate} disabled={creating || !caseName.trim()}>
                {creating
                  ? <><span className="animate-spin mr-2">⟳</span> Creating…</>
                  : <><CheckCircle2 className="w-5 h-5 mr-2" /> Create case &quot;{caseName || '…'}&quot;</>}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step dots */}
      <div className="flex items-center justify-center gap-1.5 pb-3">
        {STEPS.map((s, i) => (
          <React.Fragment key={s.id}>
            <button onClick={() => (updateTarget ? i !== step : i < step) && setStep(i)} className="flex items-center gap-1.5 transition-opacity" style={{ opacity: i <= step || updateTarget ? 1 : 0.3 }}>
              <div className={`w-7 h-7 rounded-full flex items-center justify-center border-2 transition-colors ${
                i < step ? 'border-primary bg-primary text-primary-foreground'
                  : i === step ? 'border-primary text-primary bg-transparent'
                    : 'border-muted-foreground/30 text-muted-foreground/40'
              }`}>
                {i < step ? <Check className="w-3.5 h-3.5" /> : <span className="text-[10px] font-bold font-mono">{i + 1}</span>}
              </div>
            </button>
            {i < STEPS.length - 1 && <div className={`w-8 h-0.5 rounded-full ${i < step ? 'bg-primary' : 'bg-muted-foreground/20'}`} />}
          </React.Fragment>
        ))}
      </div>

      {/* Navigation.
          pr-16 keeps "Next" clear of the floating FOAMy launcher, which is
          fixed at the bottom-right with z-100 and otherwise sits exactly on top
          of it — measured: the launcher occupies 1194-1250 px and the button
          1172-1254 px on a 1280-wide window, so the click opens the chat. */}
      <div className="flex justify-between sticky bottom-0 bg-background py-2 pr-16 border-t mt-2">
        <Button variant="outline" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>
          <ChevronLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        {step < STEPS.length - 1 && (
          <Button onClick={() => {
            if (step === 0 && !caseName.trim()) { toast.error('Enter a name'); return; }
            const nameProblem = step === 0 ? caseNameProblem(caseName.trim()) : null;
            if (nameProblem) { toast.error(nameProblem); return; }
            setStep(step + 1);
          }}>
            Next <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        )}
      </div>

      {/* New field dialog */}
      <Dialog open={showNewFieldDialog} onOpenChange={setShowNewFieldDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>New field</DialogTitle></DialogHeader>
          <div className="space-y-3 pt-2">
            <div>
              <Label>Field name</Label>
              <Input
                value={newFieldName}
                onChange={(e) => setNewFieldName(e.target.value.replace(/\s/g, ''))}
                placeholder="e.g. T, alphat, p_rgh"
                className="font-mono"
                onKeyDown={(e) => e.key === 'Enter' && handleCreateNewField()}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Boundary conditions are pre-filled for every mesh patch. Known names (T, p_rgh, nut…) get sensible defaults.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowNewFieldDialog(false)}>Cancel</Button>
              <Button onClick={handleCreateNewField} disabled={!newFieldName.trim()}>
                <Plus className="w-4 h-4 mr-1" /> Add
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Preview dialog */}
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-3xl max-h-[80vh]">
          <DialogHeader><DialogTitle className="font-mono text-sm">{previewField}</DialogTitle></DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            <pre className="text-xs font-mono whitespace-pre-wrap bg-muted/30 p-3 rounded">{previewContent}</pre>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Update review */}
      <UpdateReview
        open={!!review}
        onOpenChange={(o) => { if (!o) setReview(null); }}
        caseName={updateTarget?.caseName ?? ''}
        plan={review?.plan ?? []}
        decisions={decisions}
        onDecide={(p, d) => setDecisions(x => ({ ...x, [p]: d }))}
        onApply={() => void applyUpdate()}
        applying={applying}
        wizardContent={(p) => review?.contents[p] ?? null}
        meshWillChange={!!review && review.plan.some(e => e.action !== 'same' && isMeshInput(e.path))}
      />
    </div>
  );
}

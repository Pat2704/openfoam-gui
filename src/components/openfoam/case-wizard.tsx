'use client';

/**
 * New Case wizard.
 *
 * Which guide it gives is decided by the OpenFOAM installation the app is
 * using, never by the user (src/lib/wizard/modules.ts: guideForVersion):
 *
 *   13, 14   the complete guide — every solver module of the installation,
 *            each with the physics it needs (./wizard/step-physics.tsx), or a
 *            start from one of the installation's own tutorials of the module;
 *            the files come from src/lib/wizard/generate.ts and boundary.ts.
 *   9 – 12   a shorter guide: the incompressible solvers of src/lib/case-templates.ts,
 *            with the case layout of the version (legacy ≤10, modular 11+).
 *   unknown  no guide: a case written for the wrong version does not run.
 *
 * The mesh is the source of truth. Patch names come from the box the wizard
 * builds — and, with snappyHexMesh, one patch group per surface or region —
 * and every boundary condition is generated against that list, so the 0/
 * files and the mesh cannot disagree. The Mesh step follows a real workflow's
 * order (./wizard/step-mesh.tsx).
 *
 * "Update case" (src/lib/wizard-state.ts): a created case keeps the settings
 * and the hash of every file written in system/studioWizard.json, so the wizard
 * can reopen it, rewrite only the files that changed and ask about any file
 * somebody edited since.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  Plus, FileCode, ChevronRight, ChevronLeft, CheckCircle2, Settings, Zap, Grid3x3, Droplets,
  Wind, Check, AlertTriangle, RefreshCw, Info, Wand2, X, FolderOpen, Loader2,
} from 'lucide-react';
import { confirmDialog } from '@/components/ui/confirm-host';
import { caseNameProblem } from '@/lib/case-name';
import {
  DEFAULT_MESH, TURBULENCE_MODELS,
  buildField, defaultBC, defaultBoxPatches, estimateTurbulence, findSolver,
  generateBlockMeshDict, generateControlDict, generateFvSchemes, generateFvSolution,
  generateGravity, generateTransportProperties, generateTurbulenceProperties,
  generateFieldFile, meshPatches, meshProblems, runCommand, solverChoices, syncFieldPatches,
  transportFileName, turbulenceFieldNames, turbulenceFileName,
  type BoxPatch, type FieldConfig, type Flavour, type MeshPatch, type MeshSpec, type PatchRole, type TurbulenceModel,
} from '@/lib/case-templates';
import {
  DEFAULT_SNAPPY, UNIT_SCALE, generateMeshQualityDict, generateSnappyHexMeshDict, generateSurfaceFeaturesDict,
  geometryPath, meshStepCommand, meshSteps, snappyPatches, snappyProblems,
  type MeshStep, type SnappySettings,
} from '@/lib/snappy-templates';
import {
  WIZARD_MARKER_PATH, buildMarker, isMeshInput, parseMarker, planUpdate, resolvePlan,
  serializeMarker, settingsEqual, sha256Hex,
  type Decision, type PlanEntry, type WizardMarker, type WizardSettings,
} from '@/lib/wizard-state';
import { pointInBox, pointInsideSurface, type Vec3 } from '@/lib/geometry';
import {
  findModule, guideDescription, guideForVersion, modulesOffered, type GuideTier, type ModuleInfo,
} from '@/lib/wizard/modules';
import {
  fieldNames, physicsForModule, turbulenceValues, vectorMagnitude, type FullPhysics, type PatchValues,
} from '@/lib/wizard/physics';
import { bcFor, buildFullField, internalValue, type BcContext } from '@/lib/wizard/boundary';
import {
  fullConstantFiles, fullControlDict, fullDecomposeParDict, fullFunctions, fullFvConstraints, fullFvSchemes,
  fullFvSolution, fullProblems, fullSetFieldsDict, prepSteps, regionFields, seededFiles, solvedFields,
  type CaseFile, type FullCase,
} from '@/lib/wizard/generate';
import { seedFields, seedPhysicsFiles, tutorialPatches } from '@/lib/wizard/seed';
import { rolesFor, type RoleFamily } from '@/lib/wizard/roles';
import { parseThermoTable } from '@/lib/wizard/thermo';
import MeshStepPanel from '@/components/openfoam/wizard/step-mesh';
import PhysicsStepFull, { type WizardCatalog } from '@/components/openfoam/wizard/step-physics';
import FieldsStep from '@/components/openfoam/wizard/step-fields';
import FilesStep, { FunctionsPanel, type EditableFile, type FunctionChoice } from '@/components/openfoam/wizard/step-files';
import { readGeometry, type InsideCheck, type LoadedGeometry } from '@/components/openfoam/wizard/geometry-io';
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
  /** A file the mesh (or the initial fields) is built from changed. */
  meshStale: boolean;
  /** constant/polyMesh/boundary exists. */
  hasMesh: boolean;
  steps: MeshStep[];
  failed: string[];
}

const MESH_FILES = /^system\/(blockMeshDict|snappyHexMeshDict|surfaceFeaturesDict|meshQualityDict)$/;

function boxOf(m: MeshSpec): { min: Vec3; max: Vec3 } {
  return { min: [m.x0, m.y0, m.z0], max: [m.x1, m.y1, m.z1] };
}

/** Default time controls: steady iterations, or a short transient suited to the module. */
function timeDefaults(m: ModuleInfo | null, transient: boolean): { endTime: string; deltaT: string; writeInterval: string } {
  if (!transient) return { endTime: '500', deltaT: '1', writeInterval: '100' };
  switch (m?.physics) {
    case 'vof': case 'compressibleVof': case 'driftFlux': return { endTime: '1', deltaT: '0.001', writeInterval: '0.05' };
    case 'shock': return { endTime: '0.001', deltaT: '1e-7', writeInterval: '1e-4' };
    case 'solidMechanics': case 'solidThermal': return { endTime: '100', deltaT: '1', writeInterval: '10' };
    default: return { endTime: '0.5', deltaT: '0.001', writeInterval: '50' };
  }
}

const FALLBACK_ROLE: Record<RoleFamily, PatchRole> = { flow: 'wall', solidThermal: 'adiabatic', solidMechanics: 'tractionFree' };

/** A box whose patch roles suit the module's family (a solid has no inlet). */
function fitBoxToFamily(m: MeshSpec, family: RoleFamily): MeshSpec {
  const allowed = [...rolesFor(family), 'empty'];
  const patches = m.patches ?? defaultBoxPatches(m.twoD);
  if (patches.every(p => allowed.includes(p.role))) return m;
  const side: BoxPatch['faces'] = m.twoD ? ['yMin', 'yMax'] : ['yMin', 'yMax', 'zMin', 'zMax'];
  const next: BoxPatch[] = family === 'solidThermal'
    ? [{ name: 'hot', type: 'wall', role: 'fixedTemperature', faces: ['xMin'] }, { name: 'cold', type: 'wall', role: 'fixedTemperature', faces: ['xMax'] }, { name: 'insulated', type: 'wall', role: 'adiabatic', faces: side }]
    : family === 'solidMechanics'
      ? [{ name: 'fixed', type: 'wall', role: 'fixedSupport', faces: ['xMin'] }, { name: 'load', type: 'patch', role: 'traction', faces: ['xMax'] }, { name: 'free', type: 'patch', role: 'tractionFree', faces: side }]
      : defaultBoxPatches(m.twoD);
  return { ...m, patches: next };
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

/** The #includeFunc lines worth offering for this case. */
function functionChoices(c: FullCase | null, patches: MeshPatch[]): FunctionChoice[] {
  if (!c) return [];
  const kind = c.module.physics;
  const flow = c.module.family === 'flow';
  const out: FunctionChoice[] = [{ line: `residuals(${solvedFields(c).join(', ')})`, label: 'Residuals', hint: 'Initial residual of every solved field, each time step' }];
  if (flow) {
    if (c.transient) out.push({ line: 'CourantNo', label: 'Courant number', hint: 'Writes the Courant number field' });
    out.push({ line: 'vorticity', label: 'Vorticity', hint: 'Writes the vorticity field' });
    out.push({ line: 'Q', label: 'Q criterion', hint: 'Vortex identification field' });
    if (c.phys.simulationType !== 'laminar') out.push({ line: 'yPlus', label: 'y+', hint: 'Wall y+ of every wall patch' });
    out.push({ line: 'wallShearStress', label: 'Wall shear stress', hint: 'On every wall patch' });
    if (['thermal', 'multicomponent', 'shock', 'isothermal', 'compressibleVof'].includes(kind)) out.push({ line: 'MachNo', label: 'Mach number', hint: 'Compressible flows' });
    if (c.transient) out.push({ line: 'fieldAverage(U, p)', label: 'Time averages', hint: 'Mean of U and p over the run' });
    for (const p of patches.filter(x => x.role === 'outlet')) out.push({ line: `patchFlowRate(patch=${p.name})`, label: `Flow rate at ${p.name}`, hint: 'Mass or volume flow rate through the patch' });
    for (const p of patches.filter(x => x.role === 'inlet')) out.push({ line: `patchAverage(patch=${p.name}, fields=(p U))`, label: `Averages at ${p.name}`, hint: 'Area-averaged p and U on the patch' });
  }
  out.push({ line: 'time', label: 'Timing', hint: 'Clock and CPU time per step' });
  return out;
}

export default function CaseWizard({ onCreated, openRequest, onOpenCase, onShowMesh }: {
  onCreated: () => void;
  /** "Update case" from the Dashboard: reopen this case's recorded settings. */
  openRequest?: { caseName: string; n: number } | null;
  onOpenCase?: (name: string) => void;
  onShowMesh?: (name: string) => void;
}) {
  const [step, setStep] = useState(0);

  // ── The installation: version (hence the guide), catalogue, snappy ───────
  const [detectedVersion, setDetectedVersion] = useState<string | null>(null);
  const [versionState, setVersionState] = useState<'checking' | 'done'>('checking');
  /** Boundary condition names the installation actually offers. */
  const [bcTypes, setBcTypes] = useState<string[]>(BC_TYPES_FALLBACK);
  const [bcFromInstall, setBcFromInstall] = useState(false);
  const [snappySupport, setSnappySupport] = useState<SnappySupport | null>(null);
  const [catalog, setCatalog] = useState<WizardCatalog | null>(null);

  const [caseName, setCaseName] = useState('');
  const [existingCases, setExistingCases] = useState<string[]>([]);
  /** Cases carrying the wizard's record, which can be reopened here. */
  const [wizardCases, setWizardCases] = useState<string[]>([]);

  const [solver, setSolver] = useState('incompressibleFluid');
  const [transient, setTransient] = useState(false);
  const [turbulence, setTurbulence] = useState<TurbulenceModel>('laminar');

  // Physics inputs of the shorter guides.
  const [nu, setNu] = useState('1e-05');
  const [inletVelocity, setInletVelocity] = useState('(1 0 0)');
  const [intensity, setIntensity] = useState('5');
  const [lengthScale, setLengthScale] = useState('');
  const [gravity, setGravity] = useState('(0 -9.81 0)');

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

  /** Hand edits of generated files, by case-relative path. */
  const [systemOverrides, setSystemOverrides] = useState<Record<string, string>>({});
  const [constantOverrides, setConstantOverrides] = useState<Record<string, string>>({});

  /** The complete guide's physics (13/14). */
  const [full, setFull] = useState<FullPhysics>(() => physicsForModule(findModule('incompressibleFluid')!, boxOf(DEFAULT_MESH)));

  const [showPreview, setShowPreview] = useState(false);
  const [previewField, setPreviewField] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState('');
  const [creating, setCreating] = useState(false);

  const [showNewFieldDialog, setShowNewFieldDialog] = useState(false);
  const [newFieldName, setNewFieldName] = useState('');
  const [activeFieldIdx, setActiveFieldIdx] = useState(0);
  /** Fields the user added by hand: kept when the physics' own list changes. */
  const userFields = useRef(new Set<string>());

  // ── Update case ─────────────────────────────────────────────────────────
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

  /** Names in the files about to be written that this OpenFOAM does not know. */
  const [nameProblems, setNameProblems] = useState<{ name: string; where: string; suggestions: string[] }[]>([]);
  /** Files the wizard is about to write that OpenFOAM's parser rejects. */
  const [syntaxProblems, setSyntaxProblems] = useState<{ path: string; message: string; line: number | null }[]>([]);
  /** Where that installation check stands: a green box only once it answered. */
  const [installCheck, setInstallCheck] = useState<'checking' | 'done' | 'unavailable'>('checking');

  /**
   * Restoring recorded settings sets every value at once, and the effects
   * below would then "helpfully" follow up — a restored transient run would get
   * its endTime reset, restored boundary conditions re-synced. They skip the
   * render the restore happens in; the last effect in this component clears it.
   */
  const restoringRef = useRef(false);
  const [restoreTick, setRestoreTick] = useState(0);

  // ── Derived: the guide, the module, the patches ─────────────────────────
  const detectedMajor = parseInt((detectedVersion || '').match(/\d+/)?.[0] ?? '', 10);
  const major = Number.isFinite(detectedMajor) ? detectedMajor : null;
  const tier: GuideTier | null = versionState === 'checking' ? null : guideForVersion(major);
  const isFull = tier === 'full';
  const flavour: Flavour = tier === 'basic-legacy' ? 'legacy' : 'modular';
  const offered = useMemo(() => modulesOffered(catalog?.solvers ?? null), [catalog]);
  const mod: ModuleInfo | null = isFull ? (offered.find(m => m.id === solver) ?? findModule(solver) ?? null) : null;
  const family: RoleFamily = mod?.family ?? 'flow';
  const roles = useMemo(() => rolesFor(family), [family]);

  const patches = useMemo(() => [...meshPatches(mesh), ...snappyPatches(snappy)], [mesh, snappy]);
  const patchSignature = patches.map(p => `${p.name}:${p.role}:${p.type ?? ''}`).join('|');

  // Turbulent inlet conditions from U, I and L — see estimateTurbulence.
  const turbEstimate = useMemo(() => {
    const speed = vectorMagnitude(inletVelocity);
    const L = Number(lengthScale) || 0.07 * Math.abs(mesh.y1 - mesh.y0) || 0.01;
    return estimateTurbulence(speed || 1, (Number(intensity) || 5) / 100, L);
  }, [inletVelocity, intensity, lengthScale, mesh.y0, mesh.y1]);

  const fieldCtx = useMemo(() => ({
    inletVelocity, k: turbEstimate.k, epsilon: turbEstimate.epsilon, omega: turbEstimate.omega,
    nu: Number(nu) || 1e-5, turbulence,
  }), [inletVelocity, turbEstimate, nu, turbulence]);

  const fullCtx: BcContext | null = useMemo(() => (mod ? {
    kind: mod.physics,
    phys: full,
    turb: turbulenceValues(full, vectorMagnitude(full.inletVelocity), 0.07 * Math.abs(mesh.y1 - mesh.y0), Number(full.nu) || 1e-5),
  } : null), [mod, full, mesh.y0, mesh.y1]);

  const fullNames = useMemo(() => (mod && !full.seed && mod.physics !== 'tutorial' ? fieldNames(mod.physics, full) : []), [mod, full]);

  const [fields, setFields] = useState<FieldConfig[]>(() => {
    const p = meshPatches(DEFAULT_MESH);
    const ctx = { inletVelocity: '(1 0 0)', k: 0.00375, epsilon: 0.0027, omega: 8, nu: 1e-5 };
    return [buildField('U', p, ctx, 'modular'), buildField('p', p, ctx, 'modular')];
  });

  // ── Detect the installation, and follow a switch ─────────────────────────
  const detectInstallation = useCallback(async () => {
    setVersionState('checking');
    try {
      const res = await fetch('/api/wsl?action=version');
      const data = await res.json();
      setDetectedVersion(data?.version ? String(data.version).trim() : null);
    } catch {
      setDetectedVersion(null);
    }
    setVersionState('done');

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
      const res = await fetch('/api/foam-index?action=wizardCatalog');
      const data = await res.json();
      if (data?.ready) {
        const thermo: WizardCatalog['thermo'] = {};
        for (const [t, list] of Object.entries(data.thermo ?? {})) thermo[t] = parseThermoTable(list as string[]);
        setCatalog({ solvers: data.solvers ?? [], ras: data.ras ?? [], les: data.les ?? [], thermo, functionObjects: data.functionObjects ?? [] });
      }
    } catch { /* lists stay unnarrowed until it answers */ }

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
    const onChange = () => { setSnappySupport(null); setCatalog(null); void detectInstallation(); };
    window.addEventListener('foam-version-changed', onChange);
    return () => window.removeEventListener('foam-version-changed', onChange);
  }, [detectInstallation]);

  // The catalogue answers after the index is built (~10 s on a cold start): ask again.
  useEffect(() => {
    if (catalog || versionState !== 'done' || !isFull) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/foam-index?action=wizardCatalog');
        const data = await res.json();
        if (!data?.ready) return;
        const thermo: WizardCatalog['thermo'] = {};
        for (const [t, list] of Object.entries(data.thermo ?? {})) thermo[t] = parseThermoTable(list as string[]);
        setCatalog({ solvers: data.solvers ?? [], ras: data.ras ?? [], les: data.les ?? [], thermo, functionObjects: data.functionObjects ?? [] });
      } catch { /* try again */ }
    }, 5000);
    return () => clearInterval(timer);
  }, [catalog, versionState, isFull]);

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

  // ── Settings: what "Update case" records and restores ───────────────────
  const currentSettings = (): WizardSettings => ({
    flavour, solver, transient, turbulence, nu, inletVelocity, intensity, lengthScale,
    endTime, deltaT, writeInterval, gravity, mesh, meshOverride, systemOverrides, constantOverrides,
    fields, snappy, full: isFull ? full : null,
  });

  /** A fresh wizard for a guide. */
  const defaultSettings = (t: GuideTier | null): WizardSettings => {
    const p = meshPatches(DEFAULT_MESH);
    const base = {
      transient: false, turbulence: 'laminar' as TurbulenceModel, nu: '1e-05', inletVelocity: '(1 0 0)', intensity: '5', lengthScale: '',
      endTime: '500', deltaT: '1', writeInterval: '100', gravity: '(0 -9.81 0)', mesh: DEFAULT_MESH, meshOverride: null,
      systemOverrides: {}, constantOverrides: {}, snappy: null,
    };
    if (t === 'full') {
      const m = findModule('incompressibleFluid')!;
      const phys = physicsForModule(m, boxOf(DEFAULT_MESH));
      const ctx: BcContext = { kind: m.physics, phys, turb: turbulenceValues(phys, 1, 0.014, 1e-5) };
      return { ...base, flavour: 'modular', solver: m.id, fields: fieldNames(m.physics, phys).map(n => buildFullField(n, p, ctx)), full: phys };
    }
    const fl: Flavour = t === 'basic-legacy' ? 'legacy' : 'modular';
    const first = solverChoices(fl)[0];
    const ctx = { inletVelocity: '(1 0 0)', k: 0.00375, epsilon: 0.0027, omega: 8, nu: 1e-5 };
    return {
      ...base, flavour: fl, solver: first.value, transient: first.transient,
      ...(first.transient ? { endTime: '0.5', deltaT: '0.001', writeInterval: '50' } : {}),
      fields: [buildField('U', p, ctx, fl), buildField('p', p, ctx, fl)], full: null,
    };
  };

  const applySettings = (s: WizardSettings) => {
    restoringRef.current = true;
    setSolver(s.solver); setTransient(s.transient); setTurbulence(s.turbulence);
    setNu(s.nu); setInletVelocity(s.inletVelocity); setIntensity(s.intensity); setLengthScale(s.lengthScale);
    setEndTime(s.endTime); setDeltaT(s.deltaT); setWriteInterval(s.writeInterval); setGravity(s.gravity);
    setMesh(s.mesh); setMeshOverride(s.meshOverride);
    setSystemOverrides(s.systemOverrides); setConstantOverrides(s.constantOverrides);
    setFields(s.fields); setSnappyState(s.snappy); setActiveFieldIdx(0);
    if (s.full) setFull(s.full);
    userFields.current = new Set();
    setRestoreTick(t => t + 1);
  };

  /** Which guide recorded settings belong to. */
  const tierOf = (s: WizardSettings): GuideTier => (s.full ? 'full' : s.flavour === 'legacy' ? 'basic-legacy' : 'basic-modular');

  // A guide becomes known (or changes with an installation switch): start from
  // its defaults — unless a case is being updated, whose settings stay.
  const appliedTier = useRef<GuideTier | null>(null);
  useEffect(() => {
    if (!tier || tier === 'none' || updateTarget) return;
    if (appliedTier.current === tier) return;
    const first = appliedTier.current === null;
    appliedTier.current = tier;
    applySettings(defaultSettings(tier));
    if (!first) toast.info(`The installation changed: the wizard now follows the ${tier === 'full' ? 'complete' : 'shorter'} guide for OpenFOAM ${detectedVersion}.`);
  }, [tier]);

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
      const parsed = parseMarker(String(data.text), defaultSettings(tier));
      if (!parsed.marker) { toast.error(parsed.error); return false; }
      const recordedTier = tierOf(parsed.marker.settings);
      if (tier && recordedTier !== tier) {
        toast.error(`"${name}" was written for OpenFOAM ${parsed.marker.foamVersion ?? '?'} and the wizard's ${recordedTier === 'full' ? 'complete' : 'shorter'} guide; the selected installation (OpenFOAM ${detectedVersion}) takes another. Select that installation in the Dashboard to update it.`);
        return false;
      }
      applySettings(parsed.marker.settings);
      appliedTier.current = recordedTier;
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
    applySettings(defaultSettings(tier));
    appliedTier.current = tier;
    setCaseName(''); setUpdateTarget(null); setResult(null); setReview(null);
    setGeometry({}); setStep(0); setDecisions({});
  };

  // ── The shorter guides' follow-up effects ────────────────────────────────
  // The solver list is per layout, so a solver from the other list cannot stay
  // selected.
  useEffect(() => {
    if (restoringRef.current || isFull || !tier) return;
    setSolver(prev => (findSolver(flavour, prev) ? prev : solverChoices(flavour)[0].value));
  }, [flavour]);

  // Solver choice carries a default time treatment.
  const solverInfo = findSolver(flavour, solver);
  useEffect(() => {
    if (restoringRef.current || isFull) return;
    const s = findSolver(flavour, solver);
    if (s) setTransient(s.transient);
  }, [solver, flavour]);

  // Steady and transient want completely different controlDict numbers.
  useEffect(() => {
    if (restoringRef.current || isFull) return;
    if (transient) { setEndTime('0.5'); setDeltaT('0.001'); setWriteInterval('50'); }
    else { setEndTime('500'); setDeltaT('1'); setWriteInterval('100'); }
  }, [transient]);

  // The mesh owns the patch list: whenever it changes, re-project it onto every
  // field, keeping any boundary condition the user has already edited by name.
  useEffect(() => {
    if (restoringRef.current || isFull) return;
    setFields(prev => prev.map(f => syncFieldPatches(f, patches, fieldCtx)));
  }, [patchSignature]);

  // Picking a RAS model implies extra 0/ files.
  useEffect(() => {
    if (restoringRef.current || isFull) return;
    const needed = turbulenceFieldNames(turbulence);
    setFields(prev => {
      const have = new Set(prev.map(f => f.fieldName));
      const missing = needed.filter(n => !have.has(n));
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
  }, [turbulence]);

  // ── The complete guide: the fields follow the physics and the patches ───
  const regions = useMemo(() => regionFields(full), [full]);
  const seedHasSetFields = !!full.seed?.files.some(f => f.path === 'system/setFieldsDict');
  const fullSignature = isFull
    ? [mod?.id, full.seed?.tutorial ?? '', fullNames.join(','), [...regions].join(','), patchSignature].join('|')
    : '';
  useEffect(() => {
    if (restoringRef.current || !isFull || !mod || !fullCtx) return;
    if (full.seed) {
      const seeded = seedFields(full.seed.files, patches);
      setFields(prev => {
        const byName = new Map(prev.map(f => [f.fieldName, f]));
        return seeded.map(f => {
          const had = byName.get(f.fieldName);
          if (!had) return f;
          const bcs = new Map(had.boundaryConditions.map(b => [b.name, b]));
          return { ...f, boundaryConditions: f.boundaryConditions.map(b => bcs.get(b.name) ?? b) };
        });
      });
      return;
    }
    setFields(prev => {
      const byName = new Map(prev.map(f => [f.fieldName, f]));
      const out = fullNames.map(n => {
        const had = byName.get(n);
        const fresh = buildFullField(n, patches, fullCtx);
        const orig = regions.has(n) ? { orig: true } : {};
        if (!had || had.dimensions !== fresh.dimensions) return { ...fresh, ...orig };
        const bcs = new Map(had.boundaryConditions.map(b => [b.name, b]));
        const { orig: _drop, ...rest } = had;
        return { ...rest, cls: fresh.cls, ...orig, boundaryConditions: patches.map(p => bcs.get(p.name) ?? bcFor(n, p, fullCtx)) };
      });
      const extras = prev.filter(f => !fullNames.includes(f.fieldName) && userFields.current.has(f.fieldName));
      return [...out, ...extras];
    });
  }, [fullSignature]);

  /** Rebuild every generated field from the physics and the patch values. */
  const applyFull = () => {
    if (!mod || !fullCtx) return;
    if (full.seed) {
      setFields(seedFields(full.seed.files, patches));
      toast.success('Conditions re-targeted from the tutorial');
      return;
    }
    setFields(prev => [
      ...fullNames.map(n => ({ ...buildFullField(n, patches, fullCtx), ...(regions.has(n) ? { orig: true } : {}) })),
      ...prev.filter(f => !fullNames.includes(f.fieldName) && userFields.current.has(f.fieldName)),
    ]);
    toast.success('Boundary conditions rebuilt from the physics and the patch values');
  };

  /** A patch's values changed: rebuild that patch's conditions on every generated field. */
  const setPatchValues = (name: string, v: PatchValues) => {
    if (!mod || !fullCtx) return;
    const phys = { ...full, patchValues: { ...full.patchValues, [name]: v } };
    setFull(phys);
    const patch = patches.find(p => p.name === name);
    if (!patch) return;
    const ctx = { ...fullCtx, phys };
    setFields(prev => prev.map(f => (fullNames.includes(f.fieldName)
      ? { ...f, boundaryConditions: f.boundaryConditions.map(b => (b.name === name ? bcFor(f.fieldName, patch, ctx) : b)) }
      : f)));
  };

  const onModule = (id: string) => {
    const m = offered.find(x => x.id === id);
    if (!m || m.id === solver) return;
    setSolver(id);
    const phys = physicsForModule(m, boxOf(mesh));
    setFull(phys);
    const tr = m.transientOnly || !m.steady ? true : transient;
    setTransient(tr);
    const t = timeDefaults(m, tr);
    setEndTime(t.endTime); setDeltaT(t.deltaT); setWriteInterval(t.writeInterval);
    setMesh(msh => fitBoxToFamily(msh, m.family));
    const allowed = rolesFor(m.family);
    const fallback = FALLBACK_ROLE[m.family];
    setSnappyState(s => (s ? {
      ...s,
      surfaces: s.surfaces.map(x => ({
        ...x,
        role: allowed.includes(x.role) ? x.role : fallback,
        regions: x.regions.map(r => (allowed.includes(r.role) ? r : { ...r, role: fallback })),
      })),
    } : s));
    // The files differ between modules: edits of the previous one's do not carry over.
    setSystemOverrides({}); setConstantOverrides({});
  };

  const onTransient = (v: boolean) => {
    setTransient(v);
    const t = timeDefaults(mod, v);
    setEndTime(t.endTime); setDeltaT(t.deltaT); setWriteInterval(t.writeInterval);
  };

  const staleTurbulenceFields = useMemo(() => {
    if (isFull) return [];
    const needed = new Set(turbulenceFieldNames(turbulence));
    const allTurb = ['k', 'epsilon', 'omega', 'nut', 'nuTilda'];
    return fields.filter(f => allTurb.includes(f.fieldName) && !needed.has(f.fieldName)).map(f => f.fieldName);
  }, [fields, turbulence, isFull]);

  // ── Mesh mode ───────────────────────────────────────────────────────────
  const setSnappy = (update: (s: SnappySettings) => SnappySettings) => setSnappyState(s => (s ? update(s) : s));

  const enableSnappy = () => {
    if (!snappySupport?.available) return;
    setSnappyState(s => s ?? structuredClone(DEFAULT_SNAPPY));
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

  /** The ray test against every loaded surface, in metres (after unit scaling). */
  const isInsideBody = useMemo(() => {
    const loaded = (snappy?.surfaces ?? []).filter(s => geometry[s.file]?.parsed);
    if (!loaded.length) return undefined;
    return (p: Vec3) => loaded.some(s => pointInsideSurface(geometry[s.file].parsed!, p.map(v => v / (UNIT_SCALE[s.units] ?? 1)) as Vec3));
  }, [snappy, geometry]);

  // ── insidePoint: in the box, and on the fluid's side of the geometry ────
  const insideCheck: InsideCheck = useMemo(() => {
    if (!snappy) return { tone: 'unknown', message: '' };
    const p = snappy.insidePoint;
    if (!p.every(Number.isFinite)) return { tone: 'bad', message: 'insidePoint must be three numbers.' };
    if (!pointInBox(p, { min: [mesh.x0, mesh.y0, mesh.z0], max: [mesh.x1, mesh.y1, mesh.z1] })) {
      return { tone: 'bad', message: 'Outside the background box: snappyHexMesh would find no fluid to keep.' };
    }
    if (!snappy.surfaces.length) return { tone: 'unknown', message: 'Inside the background box. Import a geometry to check which side of it the point is on.' };
    const unchecked = snappy.surfaces.filter(s => !geometry[s.file]?.parsed);
    if (unchecked.length) return { tone: 'unknown', message: `Inside the background box; not yet checked against ${unchecked.map(s => s.name).join(', ')}, whose geometry is not loaded.` };
    const inside = isInsideBody?.(p) ?? false;
    if (snappy.flow === 'external' && inside) {
      return { tone: 'bad', message: 'insidePoint is inside the geometry: snappyHexMesh would mesh the inside of the body and drop the flow around it. For a flow inside the surface, choose "Inside the geometry".' };
    }
    if (snappy.flow === 'internal' && !inside) {
      return { tone: 'bad', message: 'insidePoint is outside the geometry, but the fluid is inside it: snappyHexMesh would keep the wrong side.' };
    }
    return { tone: 'ok', message: snappy.flow === 'internal' ? 'Inside the geometry, where the fluid is.' : 'Inside the background box and outside the geometry.' };
  }, [snappy, geometry, mesh, isInsideBody]);

  // ── Generated files ─────────────────────────────────────────────────────
  const fullCase: FullCase | null = isFull && mod && major !== null ? {
    major, module: mod, phys: full, transient, endTime, deltaT, writeInterval, patches,
  } : null;

  const blockMeshDict = meshOverride ?? generateBlockMeshDict(mesh);
  const snappyDict = snappy ? (snappy.snappyOverride ?? generateSnappyHexMeshDict(snappy)) : '';
  const featuresDict = snappy ? (snappy.featuresOverride ?? generateSurfaceFeaturesDict(snappy)) : '';
  const qualityDict = generateMeshQualityDict(snappy);

  // The shorter guides' dictionaries (icoFoam on 10 reads physicalProperties).
  const transportName = transportFileName(flavour, solver, major);
  const turbulenceName = turbulenceFileName(flavour);
  const needsGravity = Boolean(solverInfo?.buoyant);

  /** Generated system/ and constant/ files (before hand edits), and the seeded ones' patch mentions. */
  const generated = useMemo((): { system: CaseFile[]; constant: CaseFile[]; extra0: CaseFile[]; mentions: Record<string, string[]> } => {
    if (fullCase?.phys.seed) {
      const { files, mentions } = seededFiles({ ...fullCase, phys: { ...fullCase.phys, seed: { ...fullCase.phys.seed, overrides: {} } } });
      return {
        system: files.filter(f => f.path.startsWith('system/')),
        constant: files.filter(f => f.path.startsWith('constant/')),
        extra0: files.filter(f => f.path.startsWith('0/')),
        mentions,
      };
    }
    if (fullCase) {
      const sys: CaseFile[] = [
        { path: 'system/controlDict', content: fullControlDict(fullCase) },
        { path: 'system/fvSchemes', content: fullFvSchemes(fullCase) },
        { path: 'system/fvSolution', content: fullFvSolution(fullCase) },
      ];
      const fn = fullFunctions(fullCase); if (fn) sys.push({ path: 'system/functions', content: fn });
      const dp = fullDecomposeParDict(fullCase); if (dp) sys.push({ path: 'system/decomposeParDict', content: dp });
      const defaults = fullCtx ? Object.fromEntries([...regions].map(n => [n, internalValue(n, fullCtx)])) : {};
      const sf = fullSetFieldsDict(fullCase, defaults); if (sf) sys.push({ path: 'system/setFieldsDict', content: sf });
      const fc = fullFvConstraints(fullCase); if (fc) sys.push({ path: 'system/fvConstraints', content: fc });
      return { system: sys, constant: fullConstantFiles(fullCase), extra0: [], mentions: {} };
    }
    const sysOpts = { flavour, solver, transient, endTime, deltaT, writeInterval, turbulence };
    const constant: CaseFile[] = [
      { path: `constant/${transportName}`, content: generateTransportProperties(nu, flavour, transportName) },
      { path: `constant/${turbulenceName}`, content: generateTurbulenceProperties(turbulence, flavour) },
    ];
    if (needsGravity) constant.push({ path: 'constant/g', content: generateGravity(gravity, flavour) });
    return {
      system: [
        { path: 'system/controlDict', content: generateControlDict(sysOpts) },
        { path: 'system/fvSchemes', content: generateFvSchemes(sysOpts) },
        { path: 'system/fvSolution', content: generateFvSolution(sysOpts) },
      ],
      constant, extra0: [], mentions: {},
    };
  }, [fullCase?.module.id, full, transient, endTime, deltaT, writeInterval, patchSignature, flavour, solver, turbulence, nu, gravity,
      transportName, turbulenceName, needsGravity, major, regions, fullCtx]);

  const withEdits = (list: CaseFile[], edits: Record<string, string>) => list.map(f => ({ ...f, content: edits[f.path] ?? f.content }));
  // Memoised: filesToWrite depends on them, and the installation check runs
  // whenever filesToWrite changes identity.
  const systemFiles = useMemo(() => withEdits(generated.system, systemOverrides), [generated, systemOverrides]);
  const constantFiles = useMemo(() => withEdits(generated.constant, constantOverrides), [generated, constantOverrides]);

  /** Physics files that still name a patch of the tutorial's mesh, after the user's edits. */
  const mentions = useMemo((): Record<string, string[]> => {
    if (!isFull || !full.seed) return {};
    const own = new Set(patches.map(p => p.name));
    const names = tutorialPatches(full.seed.files).map(p => p.name).filter(n => !own.has(n));
    const edited = [...withEdits(generated.system, systemOverrides), ...withEdits(generated.constant, constantOverrides)];
    return seedPhysicsFiles(edited, names).mentionsPatches;
  }, [isFull, full.seed, patchSignature, generated, systemOverrides, constantOverrides]);

  /** Commands after the mesh: setFields when initial regions exist. */
  const prep: MeshStep[] = fullCase
    ? (full.seed ? (seedHasSetFields ? [{ app: 'setFields', args: '', log: 'setFields' }] : []) : prepSteps(fullCase))
    : [];
  const runSteps = [...meshSteps(snappy), ...prep];

  const previewFile = (content: string, name: string) => {
    setPreviewContent(content); setPreviewField(name); setShowPreview(true);
  };

  // ── Field editing (shorter guides; the complete guide uses its own sync) ─
  const applyPhysicsToFields = () => {
    const managed = new Set([...CORE_FIELDS, ...turbulenceFieldNames(turbulence)]);
    setFields(prev => prev.map(f => (managed.has(f.fieldName) ? buildField(f.fieldName, patches, fieldCtx, flavour) : f)));
    toast.success('Boundary conditions regenerated from the physics inputs');
  };

  const handleCreateNewField = () => {
    const name = newFieldName.trim();
    if (!name) { toast.error('Enter a name'); return; }
    if (/\s/.test(name)) { toast.error('No spaces in the name'); return; }
    if (fields.some(f => f.fieldName === name)) { toast.error(`Field "${name}" already exists`); return; }
    const f = isFull && fullCtx ? buildFullField(name, patches, fullCtx) : buildField(name, patches, fieldCtx, flavour);
    userFields.current.add(name);
    setFields(prev => [...prev, f]);
    setActiveFieldIdx(fields.length);
    setNewFieldName('');
    setShowNewFieldDialog(false);
    toast.success(`Field "${name}" added`);
  };

  // ── Preflight checks, shown on the last step ────────────────────────────
  const problems = useMemo(() => {
    const out: string[] = [];
    if (tier === 'none') out.push(guideDescription('none', detectedVersion));
    const name = caseName.trim();
    const nameProblem = caseNameProblem(name);
    if (nameProblem) out.push(nameProblem);
    else if (!updateTarget && existingCases.includes(name)) out.push(`A case called "${name}" already exists — creating will overwrite its files.`);

    if (!blockMeshDict.trim()) out.push('system/blockMeshDict is empty, so blockMesh has nothing to build.');
    out.push(...meshProblems(mesh));
    if (snappy) {
      const body = insideCheck.tone === 'bad' && /geometry/.test(insideCheck.message) ? insideCheck.message : null;
      out.push(...snappyProblems(snappy, mesh, body, meshPatches(mesh).map(p => p.name)));
      if (snappySupport && !snappySupport.available) out.push(`snappyHexMesh: ${snappySupport.reason}`);
      for (const s of snappy.surfaces) {
        if (!updateTarget && !geometry[s.file]?.upload) out.push(`${s.name}: its geometry file is not loaded; import it again.`);
      }
    }
    if (fullCase) {
      if (fullCase.module.physics === 'tutorial' && !full.seed) out.push(`Choose which ${fullCase.module.id} tutorial to start from (Physics step).`);
      if (!full.seed) out.push(...fullProblems(fullCase, catalog?.thermo ?? null));
      for (const [path, names] of Object.entries(mentions)) {
        out.push(`${path} names the tutorial's patch${names.length > 1 ? 'es' : ''} ${names.join(', ')}, which this mesh does not have: edit it (constant/ or system/ step) to use this case's patches.`);
      }
    }
    if (fields.length === 0) out.push('No fields in 0/.');

    const patchNames = new Set(patches.map(p => p.name));
    for (const f of fields) {
      if (!f.fieldName.trim()) { out.push('A field has no name.'); continue; }
      const covered = new Set(f.boundaryConditions.map(bc => bc.name.trim()).filter(Boolean));
      const missing = [...patchNames].filter(p => !covered.has(p));
      if (missing.length && !f.boundaryTail) out.push(`0/${f.fieldName} has no condition for: ${missing.join(', ')}.`);
      const extra = [...covered].filter(p => !patchNames.has(p));
      if (extra.length) out.push(`0/${f.fieldName} defines patches the mesh does not have: ${extra.join(', ')}.`);
    }

    if (!isFull) {
      for (const n of turbulenceFieldNames(turbulence)) {
        if (!fields.some(f => f.fieldName === n)) out.push(`${turbulence} needs a 0/${n} field.`);
      }
      if (turbulence === 'laminar' && staleTurbulenceFields.length) {
        out.push(`Laminar run, but 0/ still carries ${staleTurbulenceFields.join(', ')}.`);
      }
    }

    for (const p of nameProblems) {
      out.push(`${p.where}: "${p.name}" does not exist in this OpenFOAM` + (p.suggestions.length ? ` — did you mean ${p.suggestions.join(', ')}?` : '.'));
    }
    for (const p of syntaxProblems) {
      out.push(`${p.path}: OpenFOAM cannot parse this file — ${p.message}${p.line ? ` (line ${p.line})` : ''}.`);
    }
    return out;
  }, [tier, detectedVersion, caseName, existingCases, updateTarget, blockMeshDict, mesh, snappy, insideCheck, snappySupport, geometry,
      fullCase, full, catalog, mentions, fields, patches, isFull, turbulence, staleTurbulenceFields, nameProblems, syntaxProblems]);

  const filesToWrite = useMemo(() => {
    const list: { path: string; content: string }[] = [];
    for (const f of fields) if (f.fieldName.trim()) list.push({ path: `0/${f.fieldName}${f.orig ? '.orig' : ''}`, content: generateFieldFile(f, flavour) });
    list.push(...generated.extra0);
    list.push(...systemFiles);
    list.push({ path: 'system/blockMeshDict', content: blockMeshDict });
    if (snappy) {
      list.push({ path: 'system/snappyHexMeshDict', content: snappyDict });
      list.push({ path: 'system/surfaceFeaturesDict', content: featuresDict });
      list.push({ path: 'system/meshQualityDict', content: qualityDict });
    }
    list.push(...constantFiles);
    // A seeded case's own mesh dictionaries were dropped; one path each.
    const seen = new Set<string>();
    return list.filter(f => (seen.has(f.path) ? false : (seen.add(f.path), true)));
  }, [fields, flavour, generated, systemFiles, constantFiles, blockMeshDict, snappy, snappyDict, featuresDict, qualityDict]);

  /**
   * What the installation check reads. A tutorial file copied unchanged is the
   * installation's own, and some of its names (phase systems, for one) are in
   * no foamToC table, so checking it could only raise false alarms.
   */
  const filesToCheck = useMemo(() => {
    if (!full.seed) return filesToWrite;
    const copied = new Set([...generated.system, ...generated.constant, ...generated.extra0]
      .map(f => f.path).filter(p => !(p in systemOverrides) && !(p in constantOverrides)));
    return filesToWrite.filter(f => !copied.has(f.path));
  }, [filesToWrite, full.seed, generated, systemOverrides, constantOverrides]);

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
    const unavailable = () => { setNameProblems([]); setSyntaxProblems([]); setInstallCheck('unavailable'); };
    (async () => {
      try {
        const res = await fetch('/api/foam-index', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'validate', files: filesToCheck }),
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
  }, [step, filesToCheck]);

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
    if (tier === 'none') { toast.error(guideDescription('none', detectedVersion)); return; }

    // The API creates directories with `mkdir -p`, so writing into a name that
    // already exists silently replaces that case's files. Ask the server now.
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
        // The record that makes "Update case" possible.
        const marker = buildMarker(currentSettings(), await hashesOf(filesToWrite, geometryUploads), detectedVersion, null);
        const recorded = await saveMarker(c, marker);
        setGeometry(g => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, { ...v, upload: null }])));
        if (recorded) setUpdateTarget({ caseName: c, marker });
        setResult({ caseName: c, kind: 'created', meshStale: true, hasMesh: false, steps: runSteps, failed: [] });
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
        if (!settingsEqual(currentSettings(), updateTarget.marker.settings)) {
          const marker = buildMarker(currentSettings(), resolvePlan(plan, {}, next, recorded, untouched).recorded, detectedVersion, updateTarget.marker);
          if (await saveMarker(c, marker)) setUpdateTarget({ caseName: c, marker });
        }
        setResult({ caseName: c, kind: 'unchanged', meshStale: false, hasMesh, steps: runSteps, failed: [] });
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

  /** A change that makes the mesh or the setFields output stale. */
  const staleInput = (p: string) => isMeshInput(p) || p === 'system/setFieldsDict' || /^0\/.+\.orig$/.test(p);

  const applyUpdate = async () => {
    if (!review || !updateTarget) return;
    const c = updateTarget.caseName;
    const resolved = resolvePlan(review.plan, decisions, review.next, updateTarget.marker.files, review.untouched);
    if (resolved.undecided.length) return;
    setApplying(true);
    const failed: string[] = [];
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

      const meshStale = [...resolved.write, ...resolved.remove].some(staleInput);
      setResult({ caseName: c, kind: 'updated', meshStale, hasMesh: review.hasMesh, steps: runSteps, failed });
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

  // ── Rendering helpers ───────────────────────────────────────────────────
  const canJump = (i: number) => !!updateTarget || i <= step;
  const versionMismatch = updateTarget?.marker.foamVersion && detectedVersion && updateTarget.marker.foamVersion !== detectedVersion;
  const cellCount = Math.max(1, Math.round(mesh.nx)) * Math.max(1, Math.round(mesh.ny)) * (mesh.twoD ? 1 : Math.max(1, Math.round(mesh.nz)));
  const runLabel = fullCase ? 'foamRun' : runCommand(flavour, solver);
  const editableFiles = (list: CaseFile[], edits: Record<string, string>, gen: CaseFile[]): EditableFile[] =>
    list.filter(f => !MESH_FILES.test(f.path)).map(f => ({
      path: f.path, content: f.content, overridden: f.path in edits,
      note: mentions[f.path] ? `Names the tutorial's patch${mentions[f.path].length > 1 ? 'es' : ''} ${mentions[f.path].join(', ')}: use this case's patch names.` : undefined,
    })).filter(f => gen.some(g => g.path === f.path));

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
                Next, build the mesh{prep.length ? ' and fill the initial regions' : ''} (below), then run <span className="font-mono">{runLabel}</span> from
                the Commands panel. The wizard keeps this case open: go back to any step and review the update to change it.
              </p>
            )}
            {result.kind !== 'created' && result.meshStale && result.hasMesh && (
              <p className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1">
                <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
                The mesh (or the initial fields setFields writes) was built from the previous settings and no longer matches them.
                Rebuild it when you are ready; nothing was re-run.
              </p>
            )}
            {result.kind !== 'created' && !result.hasMesh && <p className="text-xs text-muted-foreground">The case has no mesh yet.</p>}
            {result.kind !== 'created' && result.hasMesh && !result.meshStale && <p className="text-xs text-muted-foreground">The mesh is not affected by these changes.</p>}
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

      {/* STEP 0: name, and the guide the installation decides */}
      {step === 0 && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Settings className="w-5 h-5" /> Case</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className={`rounded-md border px-3 py-2 text-sm flex items-start gap-2 ${tier === 'none' ? 'border-red-300 bg-red-50 dark:bg-red-950/20' : tier === 'full' ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20' : 'bg-muted/40'}`}>
              {tier === null ? <Loader2 className="w-4 h-4 mt-0.5 animate-spin" /> : tier === 'none' ? <AlertTriangle className="w-4 h-4 mt-0.5 text-red-600" /> : <Info className="w-4 h-4 mt-0.5" />}
              <div className="space-y-0.5">
                <div className="font-medium flex items-center gap-2">
                  {tier === null ? 'Detecting the OpenFOAM installation…' : guideDescription(tier, detectedVersion)}
                  {detectedVersion && <Badge variant="secondary" className="font-mono text-[10px]">OpenFOAM {detectedVersion}</Badge>}
                </div>
                {tier !== null && tier !== 'none' && (
                  <div className="text-xs text-muted-foreground">
                    The case is written for the installation the app is using ({flavour === 'modular' ? 'solver modules run by foamRun' : 'solver applications'}). To write for another version, select it in the Dashboard.
                  </div>
                )}
                {tier === 'none' && (
                  <Button size="sm" variant="outline" className="h-7 text-xs mt-1" onClick={() => void detectInstallation()}>
                    <RefreshCw className="w-3 h-3 mr-1" /> Check again
                  </Button>
                )}
              </div>
            </div>

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
              {caseName.trim() && caseNameProblem(caseName.trim()) && (
                <p className="text-xs text-danger mt-1 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> {caseNameProblem(caseName.trim())}
                </p>
              )}
              {!updateTarget && caseName.trim() && existingCases.includes(caseName.trim()) && (
                <p className="text-xs text-amber-600 mt-1 flex items-center gap-1 flex-wrap">
                  <AlertTriangle className="w-3 h-3" /> A case with this name already exists.
                  {wizardCases.includes(caseName.trim()) && (
                    <Button size="sm" variant="link" className="h-auto p-0 text-xs" onClick={() => void loadCaseForUpdate(caseName.trim())}>
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
                <p className="text-[11px] text-muted-foreground">Cases made by the wizard carry {WIZARD_MARKER_PATH}; others cannot be reopened here.</p>
              </div>
            )}

            <div className="bg-muted/50 p-3 rounded text-sm">
              <div className="font-medium mb-1 flex items-center gap-1.5"><Info className="w-3.5 h-3.5" /> Tip</div>
              <p className="text-muted-foreground">
                To copy an <strong>OpenFOAM tutorial</strong> unchanged, use the Dashboard&apos;s Tutorial tab. This wizard builds a
                <strong> case of your own</strong>: {isFull ? 'any solver module, a box mesh or a mesh around imported geometry, and every dictionary it needs.' : 'an incompressible case on a parametric box mesh.'}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* STEP 1: physics */}
      {step === 1 && isFull && mod && (
        <PhysicsStepFull
          modules={offered} module={mod} onModule={onModule}
          phys={full} setPhys={u => setFull(p => u(p))}
          transient={transient} setTransient={onTransient}
          endTime={endTime} setEndTime={setEndTime} deltaT={deltaT} setDeltaT={setDeltaT}
          writeInterval={writeInterval} setWriteInterval={setWriteInterval}
          catalog={catalog} fields={fullNames} box={boxOf(mesh)}
        />
      )}
      {step === 1 && !isFull && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Zap className="w-5 h-5" /> Solver &amp; Physics</CardTitle>
            <CardDescription>
              {flavour === 'modular' ? 'Solver modules are run with foamRun and named in system/controlDict.' : 'The solver executable is named in system/controlDict.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>{flavour === 'modular' ? 'Solver module' : 'Solver application'}</Label>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 mt-1">
                {solverChoices(flavour).map(s => (
                  <button key={s.value} onClick={() => setSolver(s.value)}
                    className={`text-left px-3 py-2 rounded-lg border text-sm transition-colors ${solver === s.value ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}>
                    <div className="font-mono font-medium">{s.label}</div>
                    <div className="text-xs text-muted-foreground">{s.desc}</div>
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1.5">
                The shorter guide covers the incompressible solvers. For other physics start from a tutorial (Dashboard → Tutorial),
                or use OpenFOAM 13 or 14, where the complete guide covers every solver module.
              </p>
            </div>
            <Separator />
            <div className="flex flex-wrap items-center gap-4">
              <div>
                <Label className="mb-1 block">Time treatment</Label>
                <div className="flex gap-1.5">
                  {[{ v: false, l: 'Steady-state' }, { v: true, l: 'Transient' }].map(t => (
                    <button key={String(t.v)} onClick={() => setTransient(t.v)}
                      className={`px-3 py-1.5 rounded-lg border text-sm transition-colors ${transient === t.v ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}>{t.l}</button>
                  ))}
                </div>
              </div>
              {([['endTime', endTime, setEndTime], ['deltaT', deltaT, setDeltaT], ['writeInterval', writeInterval, setWriteInterval]] as const).map(([l, v, s]) => (
                <div key={l}>
                  <Label className="text-xs">{l}</Label>
                  <Input value={v} onChange={e => s(e.target.value)} className="font-mono text-xs h-8 w-28 mt-0.5" />
                </div>
              ))}
            </div>
            <Separator />
            <div>
              <Label>Turbulence model</Label>
              <div className="flex flex-wrap gap-2 mt-1">
                {TURBULENCE_MODELS.map(t => (
                  <button key={t.value} onClick={() => setTurbulence(t.value)}
                    className={`text-left px-3 py-2 rounded-lg border text-sm transition-colors ${turbulence === t.value ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}>
                    <div className="font-medium">{t.label}</div>
                    <div className="text-[10px] text-muted-foreground">{t.desc}</div>
                  </button>
                ))}
              </div>
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
                <Input value={lengthScale} onChange={e => setLengthScale(e.target.value)} className="font-mono text-xs h-8 mt-0.5"
                  placeholder={String((0.07 * Math.abs(mesh.y1 - mesh.y0)).toFixed(4))} />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* STEP 2: mesh */}
      {step === 2 && (
        <MeshStepPanel
          tier={isFull ? 'full' : 'basic'}
          mesh={mesh} setMesh={u => setMesh(m => u(m))}
          meshOverride={meshOverride} setMeshOverride={setMeshOverride} blockMeshDict={blockMeshDict}
          snappy={snappy} setSnappy={setSnappy} onEnableSnappy={enableSnappy} onDisableSnappy={() => void disableSnappy()}
          snappySupport={snappySupport} geometry={geometry} setGeometry={u => setGeometry(g => u(g))}
          insideCheck={insideCheck} isInsideBody={isInsideBody} roles={roles}
          snappyDict={snappyDict} featuresDict={featuresDict} qualityDict={qualityDict} onPreview={previewFile}
        />
      )}

      {/* STEP 3: fields */}
      {step === 3 && (
        <FieldsStep
          fields={fields} setFields={u => setFields(f => u(f))} patches={patches} bcTypes={bcTypes}
          bcNote={bcFromInstall
            ? `Condition types: ${bcTypes.length}, read from the installed OpenFOAM${detectedVersion ? ' ' + detectedVersion : ''}.`
            : 'Condition types: built-in short list (the installation has not answered yet).'}
          active={activeFieldIdx} setActive={setActiveFieldIdx}
          onApply={isFull ? applyFull : applyPhysicsToFields}
          onAddField={() => { setNewFieldName(''); setShowNewFieldDialog(true); }}
          onPreview={f => previewFile(generateFieldFile(f, flavour), `0/${f.fieldName}${f.orig ? '.orig' : ''}`)}
          full={isFull && mod ? { kind: mod.physics, phys: full, setPatchValues, seeded: !!full.seed } : undefined}
          staleNote={!isFull && turbulence === 'laminar' && staleTurbulenceFields.length > 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs">
              <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
              <span>The run is laminar but 0/ still has {staleTurbulenceFields.join(', ')}.</span>
              <Button size="sm" variant="ghost" className="h-6 text-xs ml-auto"
                onClick={() => setFields(prev => prev.filter(f => !staleTurbulenceFields.includes(f.fieldName)))}>Remove them</Button>
            </div>
          ) : undefined}
        />
      )}

      {/* STEP 4: system/ */}
      {step === 4 && (
        <FilesStep
          icon={<FileCode className="w-5 h-5" />} title="system/"
          description={full.seed ? 'The tutorial\'s control, schemes and solution dictionaries, and any other it had. Edit freely.' : 'Generated from the previous steps. Edit freely — an edited file stays as you left it.'}
          files={editableFiles(systemFiles, systemOverrides, generated.system)}
          onEdit={(path, content) => setSystemOverrides(p => { const n = { ...p }; if (content === null) delete n[path]; else n[path] = content; return n; })}
          extra={fullCase && !full.seed ? (
            <div className="space-y-2">
              <FunctionsPanel lines={full.functions} onChange={l => setFull(p => ({ ...p, functions: l }))} suggestions={functionChoices(fullCase, patches)} />
              <div className="flex items-center gap-3 rounded-md border p-2 text-xs flex-wrap">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox checked={full.decompose.enabled} onCheckedChange={v => setFull(p => ({ ...p, decompose: { ...p.decompose, enabled: v === true } }))} />
                  Parallel run: write system/decomposeParDict (scotch)
                </label>
                {full.decompose.enabled && (
                  <Input type="number" min={2} value={String(full.decompose.n)} aria-label="Subdomains"
                    onChange={e => setFull(p => ({ ...p, decompose: { ...p.decompose, n: Number(e.target.value) } }))} className="h-7 w-20 font-mono text-xs" />
                )}
                {['isothermal', 'thermal', 'multicomponent'].includes(fullCase.module.physics) && (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox checked={full.limitPressure} onCheckedChange={v => setFull(p => ({ ...p, limitPressure: v === true }))} />
                    Pressure limiter (fvConstraints limitPressure)
                  </label>
                )}
              </div>
            </div>
          ) : undefined}
        />
      )}

      {/* STEP 5: constant/ */}
      {step === 5 && (
        <FilesStep
          icon={<Droplets className="w-5 h-5" />} title="constant/"
          description={full.seed ? 'The tutorial\'s physical properties and models, as it wrote them.' : 'Physical properties and models, generated from the Physics step.'}
          files={editableFiles(constantFiles, constantOverrides, generated.constant)}
          onEdit={(path, content) => setConstantOverrides(p => { const n = { ...p }; if (content === null) delete n[path]; else n[path] = content; return n; })}
          extra={!isFull && needsGravity ? (
            <div><Label className="text-xs">g</Label><Input value={gravity} onChange={e => setGravity(e.target.value)} className="font-mono text-xs h-8 w-40 mt-0.5" /></div>
          ) : undefined}
        />
      )}

      {/* STEP 6: summary */}
      {step === 6 && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><CheckCircle2 className="w-5 h-5" /> Summary</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                ['Case name', caseName || '—'],
                [isFull ? 'Solver module' : flavour === 'modular' ? 'Solver module' : 'Application', solver],
                ['OpenFOAM', detectedVersion ? `${detectedVersion} (${isFull ? 'complete guide' : 'shorter guide'})` : '—'],
                ['Time', transient ? 'Transient' : 'Steady-state'],
                ['Turbulence', isFull ? (full.seed ? 'from the tutorial' : full.simulationType === 'laminar' ? 'laminar' : `${full.simulationType} ${full.model}`) : turbulence],
                ['Mesh', snappy
                  ? `snappyHexMesh, ${snappy.surfaces.length} surface${snappy.surfaces.length === 1 ? '' : 's'} on ${cellCount} background cells`
                  : `${cellCount} cells${mesh.twoD ? ', 2D' : ''}`],
                ['Patches', patches.map(p => p.name).join(', ')],
                [isFull ? 'Source' : 'ν', isFull ? (full.seed ? full.seed.tutorial.split('/').slice(-2).join('/') : 'guided forms') : nu],
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
                <ul className="list-disc pl-5 space-y-0.5">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
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
                  <div key={f.path}>
                    <button className="hover:text-foreground hover:underline text-left" onClick={() => previewFile(f.content, f.path)}>{f.path}</button>
                  </div>
                ))}
                {(snappy?.surfaces ?? []).map(s => (
                  <div key={s.file}>{geometryPath(s.file)} <span className="font-sans">({(s.bytes / 1048576).toFixed(1)} MB{geometry[s.file]?.upload ? '' : ', in the case'})</span></div>
                ))}
                <div title="The wizard's record, which makes Update case possible">{WIZARD_MARKER_PATH}</div>
              </div>
            </div>

            <div className="bg-muted/40 rounded p-3 text-xs">
              <div className="font-medium mb-1">Then, in this order</div>
              <pre className="font-mono">{[...runSteps.map(meshStepCommand), runLabel].join('\n')}</pre>
              <p className="text-muted-foreground mt-1">The mesh steps{prep.length ? ' and setFields' : ''} run from here once the case is {updateTarget ? 'updated' : 'created'}; the solver from the Commands panel.</p>
            </div>

            {updateTarget ? (
              <Button className="w-full py-6 text-base" onClick={handleReviewUpdate} disabled={creating}>
                {creating ? <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> Comparing with the case…</> : <><Wand2 className="w-5 h-5 mr-2" /> Review the update of &quot;{updateTarget.caseName}&quot;</>}
              </Button>
            ) : (
              <Button className="w-full py-6 text-base" onClick={handleCreate} disabled={creating || !caseName.trim() || tier === 'none' || tier === null}>
                {creating ? <><span className="animate-spin mr-2">⟳</span> Creating…</> : <><CheckCircle2 className="w-5 h-5 mr-2" /> Create case &quot;{caseName || '…'}&quot;</>}
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

      {/* Navigation. pr-16 keeps "Next" clear of the floating FOAMy launcher. */}
      <div className="flex justify-between sticky bottom-0 bg-background py-2 pr-16 border-t mt-2">
        <Button variant="outline" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>
          <ChevronLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        {step < STEPS.length - 1 && (
          <Button disabled={tier === null || tier === 'none'} onClick={() => {
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
              <Input value={newFieldName} onChange={(e) => setNewFieldName(e.target.value.replace(/\s/g, ''))}
                placeholder="e.g. T, alphat, p_rgh" className="font-mono" onKeyDown={(e) => e.key === 'Enter' && handleCreateNewField()} />
              <p className="text-xs text-muted-foreground mt-1">Boundary conditions are pre-filled for every mesh patch.</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowNewFieldDialog(false)}>Cancel</Button>
              <Button onClick={handleCreateNewField} disabled={!newFieldName.trim()}><Plus className="w-4 h-4 mr-1" /> Add</Button>
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
        meshWillChange={!!review && review.plan.some(e => e.action !== 'same' && staleInput(e.path))}
      />
    </div>
  );
}

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
 * come from the blockMeshDict the wizard builds, and every boundary condition
 * is generated against that list, so the 0/ files and the mesh cannot disagree
 * — which is otherwise the most common reason a hand-assembled case dies on the
 * first time step.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  Wind, Eye, Check, AlertTriangle, RefreshCw, Info,
} from 'lucide-react';
import { confirmDialog } from '@/components/ui/confirm-host';
import {
  DEFAULT_MESH, TURBULENCE_MODELS,
  buildField, estimateTurbulence, findSolver, flavourForVersion,
  generateBlockMeshDict, generateControlDict, generateFvSchemes, generateFvSolution,
  generateGravity, generateTransportProperties, generateTurbulenceProperties,
  generateFieldFile, meshPatches, runCommand, solverChoices, syncFieldPatches,
  transportFileName, turbulenceFieldNames, turbulenceFileName,
  type FieldConfig, type Flavour, type MeshSpec, type TurbulenceModel,
} from '@/lib/case-templates';

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

export default function CaseWizard({ onCreated }: { onCreated: () => void }) {
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

  const [caseName, setCaseName] = useState('');
  const [existingCases, setExistingCases] = useState<string[]>([]);

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

  const patches = useMemo(() => meshPatches(mesh), [mesh]);

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
  }), [inletVelocity, turbEstimate, nu]);

  const [fields, setFields] = useState<FieldConfig[]>(() => {
    const p = meshPatches(DEFAULT_MESH);
    const ctx = { inletVelocity: '(1 0 0)', k: 0.00375, epsilon: 0.0027, omega: 8, nu: 1e-5 };
    return [buildField('U', p, ctx, 'modular'), buildField('p', p, ctx, 'modular')];
  });

  // ── Detect the installed version once ───────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/wsl?action=version');
        const data = await res.json();
        if (cancelled || !data?.version) return;
        const major = parseInt(String(data.version).match(/\d+/)?.[0] ?? '', 10);
        setDetectedVersion(String(data.version).trim());
        setFlavour(flavourForVersion(Number.isFinite(major) ? major : null));
      } catch { /* keep the modular default */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // The real boundary-condition list, straight from foamToC. Falls back to the
  // short built-in list if the index is not built yet or the version predates
  // foamToC (9/10), so the wizard always works — just with fewer choices.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/foam-index?action=bc');
        const data = await res.json();
        if (cancelled || !data?.ready || !Array.isArray(data.types) || !data.types.length) return;
        setBcTypes(data.types);
        setBcFromInstall(true);
      } catch { /* keep the fallback */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Refuse to silently write into a case that already exists (see handleCreate).
  const refreshCases = useCallback(async () => {
    try {
      const res = await fetch('/api/cases?action=list');
      const data = await res.json();
      if (Array.isArray(data?.cases)) setExistingCases(data.cases);
    } catch { /* not fatal: handleCreate asks again */ }
  }, []);
  useEffect(() => { void refreshCases(); }, [refreshCases]);

  // The solver list is per-flavour, so a solver from the other list cannot stay
  // selected. Dimensions are version-independent (see dimensionsFor).
  useEffect(() => {
    setSolver(prev => (findSolver(flavour, prev) ? prev : solverChoices(flavour)[0].value));
  }, [flavour]);

  // Solver choice carries a default time treatment.
  const solverInfo = findSolver(flavour, solver);
  useEffect(() => {
    const s = findSolver(flavour, solver);
    if (!s) return;
    setTransient(s.transient);
  }, [solver, flavour]);

  // Steady and transient want completely different controlDict numbers.
  useEffect(() => {
    if (transient) { setEndTime('0.5'); setDeltaT('0.001'); setWriteInterval('50'); }
    else { setEndTime('500'); setDeltaT('1'); setWriteInterval('100'); }
  }, [transient]);

  // The mesh owns the patch list: whenever it changes, re-project it onto every
  // field, keeping any boundary condition the user has already edited by name.
  const patchSignature = patches.map(p => `${p.name}:${p.role}`).join('|');
  useEffect(() => {
    setFields(prev => prev.map(f => syncFieldPatches(f, meshPatches(mesh), fieldCtx)));
    // fieldCtx is intentionally not a dependency: re-syncing on every keystroke
    // in the physics step would overwrite boundary conditions the user is
    // editing. The "Apply physics" button in step 3 is the explicit path.
  }, [patchSignature]);

  // Picking a RAS model implies extra 0/ files; a case that names kEpsilon in
  // momentumTransport but has no k/epsilon/nut fails on startup.
  useEffect(() => {
    const needed = turbulenceFieldNames(turbulence);
    setFields(prev => {
      const have = new Set(prev.map(f => f.fieldName));
      const missing = needed.filter(n => !have.has(n));
      if (missing.length === 0) return prev;
      return [...prev, ...missing.map(n => buildField(n, meshPatches(mesh), fieldCtx, flavour))];
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

  const transportName = transportFileName(flavour);
  const turbulenceName = turbulenceFileName(flavour);
  const transportProps = constantOverrides[transportName] ?? generateTransportProperties(nu, flavour);
  const turbProps = constantOverrides[turbulenceName] ?? generateTurbulenceProperties(turbulence, flavour);
  const needsGravity = Boolean(solverInfo?.buoyant);

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

  // ── Preflight checks, shown on the last step ────────────────────────────
  const problems = useMemo(() => {
    const out: string[] = [];
    const name = caseName.trim();
    if (!name) out.push('The case has no name.');
    else if (!/^[A-Za-z0-9._-]+$/.test(name)) out.push('The name may only contain letters, numbers, dot, dash and underscore.');
    else if (existingCases.includes(name)) out.push(`A case called "${name}" already exists — creating will overwrite its files.`);

    if (!blockMeshDict.trim()) out.push('system/blockMeshDict is empty, so blockMesh has nothing to build.');
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
  }, [caseName, existingCases, blockMeshDict, fields, patches, turbulence, staleTurbulenceFields, nameProblems, syntaxProblems]);

  const filesToWrite = useMemo(() => {
    const list: { path: string; content: string }[] = [];
    for (const f of fields) if (f.fieldName.trim()) list.push({ path: `0/${f.fieldName}`, content: generateFieldFile(f, flavour) });
    list.push({ path: 'system/controlDict', content: controlDict });
    list.push({ path: 'system/fvSchemes', content: fvSchemes });
    list.push({ path: 'system/fvSolution', content: fvSolution });
    list.push({ path: 'system/blockMeshDict', content: blockMeshDict });
    list.push({ path: `constant/${transportName}`, content: transportProps });
    list.push({ path: `constant/${turbulenceName}`, content: turbProps });
    if (needsGravity) list.push({ path: 'constant/g', content: generateGravity(gravity, flavour) });
    return list;
  }, [fields, flavour, controlDict, fvSchemes, fvSolution, blockMeshDict, transportName,
      turbulenceName, transportProps, turbProps, needsGravity, gravity]);

  useEffect(() => {
    if (step !== 6) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/foam-index', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'validate', files: filesToWrite }),
        });
        const data = await res.json();
        if (cancelled || !data?.ready) return;
        if (Array.isArray(data.problems)) setNameProblems(data.problems);
        if (Array.isArray(data.syntax)) setSyntaxProblems(data.syntax);
      } catch { /* the preflight simply does not show this check */ }
    })();
    return () => { cancelled = true; };
  }, [step, filesToWrite]);

  const handleCreate = async () => {
    const c = caseName.trim();
    if (!c) { toast.error('Enter a case name'); setStep(0); return; }

    // The API creates directories with `mkdir -p`, so writing into a name that
    // already exists silently replaces that case's files.
    if (existingCases.includes(c)) {
      const ok = await confirmDialog(
        `A case called "${c}" already exists. Creating it again overwrites ${filesToWrite.length} of its files. Continue?`,
        { title: 'Case exists', confirmLabel: 'Overwrite', destructive: true }
      );
      if (!ok) return;
    }

    setCreating(true);
    const failed: string[] = [];
    try {
      const created = await fetch('/api/cases', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', caseName: c }),
      });
      if (!created.ok) {
        const msg = await created.json().catch(() => ({}));
        throw new Error(msg.error || `could not create the case directory (HTTP ${created.status})`);
      }

      for (const file of filesToWrite) {
        // fetch only rejects on a network failure — a 500 comes back as a
        // perfectly resolved promise, which is how this step used to report
        // success after writing nothing.
        const res = await fetch(`/api/cases/${encodeURIComponent(c)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'write', path: file.path, content: file.content }),
        }).catch(() => null);
        if (!res || !res.ok) failed.push(file.path);
      }

      if (failed.length) {
        toast.error(`${failed.length} of ${filesToWrite.length} files failed: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}`);
      } else {
        toast.success(`Case "${c}" created — ${filesToWrite.length} files. Run blockMesh, then ${runCommand(flavour, solver)}.`);
        setStep(0);
        setCaseName('');
      }
      await refreshCases();
      onCreated();
    } catch (e) {
      toast.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCreating(false);
    }
  };

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

  return (
    <div className="space-y-4">
      {/* Progress bar */}
      <div className="flex items-center gap-0">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium rounded-t-lg transition-colors ${
              i === step ? 'bg-primary text-primary-foreground' : i < step ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
            }`}
            onClick={() => i <= step && setStep(i)}
          >
            {i < step ? <CheckCircle2 className="w-3.5 h-3.5" /> : s.icon}
            <span className="hidden md:inline">{s.title}</span>
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
              />
              <p className="text-xs text-muted-foreground mt-1">
                Letters, numbers, <code>. - _</code>. This becomes the folder name in $FOAM_RUN.
              </p>
              {caseName.trim() && existingCases.includes(caseName.trim()) && (
                <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> A case with this name already exists.
                </p>
              )}
            </div>

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
                    onClick={() => setFlavour(o.v)}
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
                with a parametric box mesh.
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
              A single-block box. The patches defined here — {patches.map(p => p.name).join(', ')} — are what the
              boundary conditions in 0/ are generated against.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
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
              <label className="flex items-center gap-2 cursor-pointer h-8">
                <Checkbox checked={mesh.twoD} onCheckedChange={v => setMesh(m => ({ ...m, twoD: v as boolean }))} />
                <span className="text-sm">2D case</span>
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              {mesh.twoD
                ? 'A 2D case has one cell across z and the two z faces become an empty patch — that is what makes OpenFOAM solve it in 2D.'
                : 'Full 3D: the z faces join the walls patch.'}
              {' '}Cells: <span className="font-mono">{Math.max(1, Math.round(mesh.nx)) * Math.max(1, Math.round(mesh.ny)) * (mesh.twoD ? 1 : Math.max(1, Math.round(mesh.nz)))}</span>.
              {' '}For an STL geometry, create the case and use snappyHexMesh from the Commands panel.
            </p>

            <Separator />

            <div>
              <div className="flex items-center justify-between mb-1">
                <Label>system/blockMeshDict {meshOverride !== null && <Badge variant="secondary" className="ml-1 text-[10px]">edited by hand</Badge>}</Label>
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
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-400 flex-shrink-0" onClick={() => removeBC(activeFieldIdx, bi)}>
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
                ['Mesh', `${Math.max(1, Math.round(mesh.nx)) * Math.max(1, Math.round(mesh.ny)) * (mesh.twoD ? 1 : Math.max(1, Math.round(mesh.nz)))} cells${mesh.twoD ? ', 2D' : ''}`],
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
            ) : (
              <div className="rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20 px-3 py-2 text-xs flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" /> Everything checks out: patches, fields and solver agree.
              </div>
            )}

            <div>
              <Label className="text-sm font-medium">Files ({filesToWrite.length})</Label>
              <div className="font-mono text-xs mt-1 space-y-0.5 text-muted-foreground columns-2">
                {filesToWrite.map(f => (
                  <div key={f.path} className="flex items-center gap-1">
                    <button className="hover:text-foreground hover:underline text-left" onClick={() => previewFile(f.content, f.path)}>
                      {f.path}
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-muted/40 rounded p-3 text-xs">
              <div className="font-medium mb-1">Then, from the Commands panel</div>
              <pre className="font-mono">{`blockMesh\ncheckMesh\n${runCommand(flavour, solver)}`}</pre>
            </div>

            <Button className="w-full py-6 text-base" onClick={handleCreate} disabled={creating || !caseName.trim()}>
              {creating
                ? <><span className="animate-spin mr-2">⟳</span> Creating…</>
                : <><CheckCircle2 className="w-5 h-5 mr-2" /> Create case &quot;{caseName || '…'}&quot;</>}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step dots */}
      <div className="flex items-center justify-center gap-1.5 pb-3">
        {STEPS.map((s, i) => (
          <React.Fragment key={s.id}>
            <button onClick={() => i < step && setStep(i)} className="flex items-center gap-1.5 transition-opacity" style={{ opacity: i <= step ? 1 : 0.3 }}>
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
    </div>
  );
}

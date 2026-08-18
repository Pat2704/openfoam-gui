'use client';

import React, { useState, useMemo } from 'react';
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
  Wind, Eye, Check
} from 'lucide-react';

interface BoundaryCondition { name: string; type: string; value: string; }
interface FieldConfig {
  fieldName: string; dimensions: string; internalField: string;
  boundaryConditions: BoundaryCondition[];
}

const SOLVER_OPTIONS = [
  { value: 'simpleFoam', label: 'simpleFoam', desc: 'Incompressible steady-state (RANS)' },
  { value: 'pimpleFoam', label: 'pimpleFoam', desc: 'Incompressible transient (PIMPLE)' },
  { value: 'pisoFoam', label: 'pisoFoam', desc: 'Incompressible transient (PISO)' },
  { value: 'icoFoam', label: 'icoFoam', desc: 'Incompressible laminar transient' },
  { value: 'rhoSimpleFoam', label: 'rhoSimpleFoam', desc: 'Compressible steady-state' },
  { value: 'rhoPimpleFoam', label: 'rhoPimpleFoam', desc: 'Compressible transient' },
  { value: 'interFoam', label: 'interFoam', desc: 'Incompressible two-phase (VOF)' },
  { value: 'buoyantSimpleFoam', label: 'buoyantSimpleFoam', desc: 'Compressible natural convection' },
  { value: 'buoyantBoussinesqSimpleFoam', label: 'buoyantBoussinesqSimpleFoam', desc: 'Boussinesq steady-state' },
  { value: 'sonicFoam', label: 'sonicFoam', desc: 'High Mach compressible' },
  { value: 'dnsFoam', label: 'dnsFoam', desc: 'Direct Numerical Simulation' },
];

const BC_TYPES = [
  'fixedValue', 'zeroGradient', 'noSlip', 'slip', 'symmetryPlane', 'empty',
  'wall', 'fixedFluxPressure', 'inletOutlet', 'outletInlet',
  'kqRWallFunction', 'epsilonWallFunction', 'omegaWallFunction', 'nutkWallFunction',
  'nutUWallFunction', 'calculated', 'freestream', 'turbulentInlet',
  'atmosphericBoundaryLayer', 'codedFixedValue', 'uniformFixedValue', 'sine',
  'timeVaryingUniformFixedValue', 'mappedField', 'fanPressure',
];

const STEPS = [
  { id: 'basic', title: 'Case', icon: <Settings className="w-4 h-4" /> },
  { id: 'solver', title: 'Solver', icon: <Zap className="w-4 h-4" /> },
  { id: 'mesh', title: 'Mesh', icon: <Grid3x3 className="w-4 h-4" /> },
  { id: 'fields', title: 'Fields 0/', icon: <Wind className="w-4 h-4" /> },
  { id: 'system', title: 'system/', icon: <FileCode className="w-4 h-4" /> },
  { id: 'constant', title: 'constant/', icon: <Droplets className="w-4 h-4" /> },
  { id: 'create', title: 'Create!', icon: <CheckCircle2 className="w-4 h-4" /> },
];

export default function CaseWizard({ onCreated }: { onCreated: () => void }) {
  const [step, setStep] = useState(0);
  const [caseName, setCaseName] = useState('');
  const [solver, setSolver] = useState('simpleFoam');
  const [turbulenceModel, setTurbulenceModel] = useState('laminare');
  const [hasHeatTransfer, setHasHeatTransfer] = useState(false);
  const [isMultiphase, setIsMultiphase] = useState(false);
  const [isCompressible, setIsCompressible] = useState(false);
  const [meshType, setMeshType] = useState('blockMesh');
  const [blockMeshContent, setBlockMeshContent] = useState('');

  const [fields, setFields] = useState<FieldConfig[]>([
    { fieldName: 'U', dimensions: '[0 1 -1 0 0 0 0]', internalField: 'uniform (0 0 0)',
      boundaryConditions: [
        { name: 'inlet', type: 'fixedValue', value: 'uniform (1 0 0)' },
        { name: 'outlet', type: 'zeroGradient', value: '' },
        { name: 'walls', type: 'noSlip', value: '' },
      ]},
    { fieldName: 'p', dimensions: '[0 2 -2 0 0 0 0]', internalField: 'uniform 0',
      boundaryConditions: [
        { name: 'inlet', type: 'zeroGradient', value: '' },
        { name: 'outlet', type: 'fixedValue', value: 'uniform 0' },
        { name: 'walls', type: 'zeroGradient', value: '' },
      ]},
  ]);

  // Which field is currently displayed (index into fields array)
  const [activeFieldIdx, setActiveFieldIdx] = useState(0);

  // System files
  const [systemOverrides, setSystemOverrides] = useState<Record<string, string>>({});
  const [constantOverrides, setConstantOverrides] = useState<Record<string, string>>({});

  // Preview
  const [showPreview, setShowPreview] = useState(false);
  const [previewField, setPreviewField] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState('');
  const [creating, setCreating] = useState(false);

  // New field dialog
  const [showNewFieldDialog, setShowNewFieldDialog] = useState(false);
  const [newFieldName, setNewFieldName] = useState('');

  const isTransient = solver.includes('pimple') || solver.includes('piso') || solver.includes('ico') || solver.includes('inter') || solver.includes('dns');

  // Generate file contents with useMemo
  const controlDict = useMemo(() => systemOverrides.controlDict || `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      controlDict;
}
application     ${solver};
startFrom       latestTime;
startTime       0;
stopAt          endTime;
endTime         ${isTransient ? '0.5' : '1000'};
deltaT          ${isTransient ? '0.005' : '1'};
writeControl    timeStep;
writeInterval   ${isTransient ? '20' : '100'};
purgeWrite      0;
writeFormat     ascii;
writePrecision  6;
writeCompression uncompressed;
timeFormat      general;
timePrecision   6;
runTimeModifiable yes;`, [solver, isTransient, systemOverrides.controlDict]);

  const fvSchemes = useMemo(() => systemOverrides.fvSchemes || `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      fvSchemes;
}
ddtSchemes
{
    default         ${isTransient ? 'Euler' : 'steadyState'};
}
gradSchemes
{
    default         Gauss linear;
}
divSchemes
{
    default         none;
    div(phi,U)      Gauss upwind;
}
laplacianSchemes
{
    default         Gauss linear orthogonal;
}
interpolationSchemes
{
    default         linear;
}
snGradSchemes
{
    default         orthogonal;
}`, [isTransient, systemOverrides.fvSchemes]);

  const fvSolution = useMemo(() => systemOverrides.fvSolution || (solver.includes('simple') ? `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      fvSolution;
}
solvers
{
    p { solver PCG; preconditioner DIC; tolerance 1e-06; relTol 0.01; }
    U { solver smoothSolver; smoother symGaussSeidel; tolerance 1e-05; relTol 0.1; }
}
SIMPLE
{
    nNonOrthogonalCorrectors 0;
    residualControl { p 1e-4; U 1e-4; }
}
relaxationFactors
{
    fields { p 0.3; }
    equations { U 0.7; }
}` : `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      fvSolution;
}
solvers
{
    p { solver PCG; preconditioner DIC; tolerance 1e-06; relTol 0; }
    U { solver smoothSolver; smoother symGaussSeidel; tolerance 1e-05; relTol 0; }
}
PISO
{
    nCorrectors     2;
    nNonOrthogonalCorrectors 0;
}`), [solver, systemOverrides.fvSolution]);

  const transportProps = useMemo(() => constantOverrides.transportProperties || `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      transportProperties;
}
transportModel  Newtonian;
nu              [0 2 -1 0 0 0 0] 1e-6;
// Air: 1.5e-5 | Water: 1e-6 | Oil: 1e-4`, [constantOverrides.transportProperties]);

  const turbProps = useMemo(() => constantOverrides.turbulenceProperties || (turbulenceModel === 'laminare'
    ? `FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       dictionary;\n    object      turbulenceProperties;\n}\nsimulationType  laminar;`
    : `FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       dictionary;\n    object      turbulenceProperties;\n}\nsimulationType  RAS;\nRAS\n{\n    RASModel        ${turbulenceModel === 'k-epsilon' ? 'kEpsilon' : turbulenceModel === 'k-omega SST' ? 'kOmegaSST' : turbulenceModel === 'Spalart-Allmaras' ? 'SpalartAllmaras' : 'kEpsilon'};\n    turbulence      on;\n    printCoeffs     on;\n}`), [turbulenceModel, constantOverrides.turbulenceProperties]);

  const [gravity, setGravity] = useState('value           (0 0 -9.81);');

  const addField = (fieldName: string, dims: string, internal: string, bcs: BoundaryCondition[]) => {
    if (fields.find(f => f.fieldName === fieldName)) {
      toast.warning(`Field "${fieldName}" already present`);
      return;
    }
    const newField = { fieldName, dimensions: dims, internalField: internal, boundaryConditions: bcs };
    setFields(prev => [...prev, newField]);
    setActiveFieldIdx(fields.length); // select the newly added field
    toast.success(`Field "${fieldName}" added`);
  };

  const removeField = (i: number) => {
    setFields(prev => prev.filter((_, idx) => idx !== i));
    // adjust active index
    if (activeFieldIdx >= fields.length - 1) {
      setActiveFieldIdx(Math.max(0, fields.length - 2));
    } else if (activeFieldIdx > i) {
      setActiveFieldIdx(activeFieldIdx - 1);
    } else if (activeFieldIdx === i) {
      setActiveFieldIdx(Math.min(activeFieldIdx, fields.length - 2));
    }
  };
  const updateField = (i: number, u: Partial<FieldConfig>) => {
    setFields(prev => { const n = [...prev]; n[i] = { ...n[i], ...u }; return n; });
  };
  const addBC = (fi: number) => updateField(fi, { boundaryConditions: [...fields[fi].boundaryConditions, { name: '', type: 'fixedValue', value: '' }] });
  const updateBC = (fi: number, bi: number, u: Partial<BoundaryCondition>) => {
    const n = [...fields]; n[fi].boundaryConditions[bi] = { ...n[fi].boundaryConditions[bi], ...u };
    setFields(n);
  };
  const removeBC = (fi: number, bi: number) => {
    const n = [...fields]; n[fi].boundaryConditions = n[fi].boundaryConditions.filter((_, i) => i !== bi);
    setFields(n);
  };

  const generateFieldFile = (f: FieldConfig) => {
    const bcs = f.boundaryConditions.filter(bc => bc.name).map(bc =>
      `    ${bc.name}\n    {\n        type            ${bc.type};\n${bc.value ? `        value           ${bc.value};\n` : ''}    }`
    ).join('\n\n');
    return `FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       volScalarField;\n    object      ${f.fieldName};\n}\ndimensions      ${f.dimensions};\n\ninternalField   ${f.internalField};\n\nboundaryField\n{\n${bcs}\n}\n`;
  };

  const previewFile = (content: string, name: string) => { setPreviewContent(content); setPreviewField(name); setShowPreview(true); };

  const handleCreateNewField = () => {
    const name = newFieldName.trim();
    if (!name) { toast.error('Enter a name'); return; }
    if (name.includes(' ')) { toast.error('No spaces in the name'); return; }
    if (fields.find(f => f.fieldName === name)) { toast.error(`Field "${name}" already exists`); return; }
    addField(name, '[0 0 0 0 0 0 0]', 'uniform 0', [{ name: 'patch1', type: 'fixedValue', value: 'uniform 0' }]);
    setNewFieldName('');
    setShowNewFieldDialog(false);
  };

  const handleCreate = async () => {
    if (!caseName.trim()) { toast.error('Enter a case name'); setStep(0); return; }
    if (caseName.includes(' ')) { toast.error('The name cannot contain spaces'); setStep(0); return; }
    setCreating(true);
    try {
      const c = caseName.trim();
      const api = (path: string, content: string) => fetch(`/api/cases/${encodeURIComponent(c)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'write', path, content }),
      });

      // Create base directories
      await fetch('/api/cases', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', caseName: c }),
      });

      // Write fields
      for (const f of fields) {
        if (f.fieldName) await api(`0/${f.fieldName}`, generateFieldFile(f));
      }
      // Write system
      await api('system/controlDict', controlDict);
      await api('system/fvSchemes', fvSchemes);
      await api('system/fvSolution', fvSolution);
      await api('system/blockMeshDict', blockMeshContent);
      // Write constant
      await api('constant/transportProperties', transportProps);
      await api('constant/turbulenceProperties', turbProps);
      if (hasHeatTransfer || isCompressible) {
        await api('constant/g', `FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       uniformDimensionedVector;\n    object      g;\n}\ndimensions      [0 1 -2 0 0 0 0];\n${gravity}`);
      }

      toast.success(`Case "${c}" created successfully!`);
      setStep(0); setCaseName(''); onCreated();
    } catch (e: any) { toast.error(`Error: ${e.message}`); }
    setCreating(false);
  };

  // Count total files to create
  const totalFiles = fields.filter(f => f.fieldName).length + 4 + (hasHeatTransfer || isCompressible ? 1 : 0);

  // Active field helper
  const activeField = fields[activeFieldIdx];

  return (
    <div className="space-y-4">
      {/* Progress bar */}
      <div className="flex items-center gap-0">
        {STEPS.map((s, i) => (
          <React.Fragment key={s.id}>
            <button
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium rounded-t-lg transition-colors ${
                i === step ? 'bg-primary text-primary-foreground' : i < step ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
              }`}
              onClick={() => i <= step && setStep(i)}
            >
              {i < step ? <CheckCircle2 className="w-3.5 h-3.5" /> : s.icon}
              <span className="hidden md:inline">{s.title}</span>
            </button>
          </React.Fragment>
        ))}
      </div>

      {/* STEP 0: Case Name */}
      {step === 0 && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Settings className="w-5 h-5" /> Case Name</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label>Case name *</Label>
              <Input value={caseName} onChange={(e) => setCaseName(e.target.value.replace(/\s/g, ''))} placeholder="e.g. pipeFlow, airfoilTest, myCavity" className="font-mono" />
              <p className="text-xs text-muted-foreground mt-1">No spaces, only letters/numbers/underscore. This will be the folder name in $FOAM_RUN.</p>
            </div>
            <div className="bg-muted/50 p-3 rounded text-sm">
              <div className="font-medium mb-1">Tip</div>
              <p className="text-muted-foreground">If you want a ready-made case with all files, you can copy an <strong>OpenFOAM tutorial</strong> directly from the Dashboard (&quot;OpenFOAM Tutorial&quot; tab). This Wizard is for creating <strong>custom cases from scratch</strong>.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* STEP 1: Solver & Physics */}
      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Zap className="w-5 h-5" /> Solver & Physical Model</CardTitle>
            <CardDescription>Choose the appropriate solver for your problem</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>OpenFOAM Solver</Label>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 mt-1">
                {SOLVER_OPTIONS.map(s => (
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

            <div>
              <Label>Turbulence Model</Label>
              <div className="flex flex-wrap gap-2 mt-1">
                {[
                  { v: 'laminare', l: 'Laminar', d: 'No model' },
                  { v: 'k-epsilon', l: 'k-epsilon', d: 'Standard, good for general flows' },
                  { v: 'k-omega SST', l: 'k-omega SST', d: 'Better for advection, boundary layer' },
                  { v: 'Spalart-Allmaras', l: 'Spalart-Allmaras', d: 'External aerodynamics' },
                ].map(t => (
                  <button key={t.v} className={`text-left px-3 py-2 rounded-lg border text-sm transition-colors ${turbulenceModel === t.v ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`} onClick={() => setTurbulenceModel(t.v)}>
                    <div className="font-medium">{t.l}</div>
                    <div className="text-[10px] text-muted-foreground">{t.d}</div>
                  </button>
                ))}
              </div>
            </div>

            <Separator />

            <div>
              <Label className="mb-2 block">Additional options</Label>
              <div className="flex flex-wrap gap-3">
                <label className="flex items-center gap-2 cursor-pointer"><Checkbox checked={isCompressible} onCheckedChange={v => setIsCompressible(v as boolean)} /><span className="text-sm">Compressible</span></label>
                <label className="flex items-center gap-2 cursor-pointer"><Checkbox checked={hasHeatTransfer} onCheckedChange={v => setHasHeatTransfer(v as boolean)} /><span className="text-sm">Heat transfer</span></label>
                <label className="flex items-center gap-2 cursor-pointer"><Checkbox checked={isMultiphase} onCheckedChange={v => setIsMultiphase(v as boolean)} /><span className="text-sm">Multiphase</span></label>
              </div>
            </div>

            </CardContent>
        </Card>
      )}

      {/* STEP 2: Mesh */}
      {step === 2 && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Grid3x3 className="w-5 h-5" /> Mesh</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">Type:</span>
              <Badge>{meshType}</Badge>
              <span className="text-muted-foreground text-xs ml-2">For complex STL geometries use snappyHexMesh from the Commands panel after creating the case</span>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label>system/blockMeshDict</Label>
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => previewFile(blockMeshContent, 'system/blockMeshDict')}>
                  <Eye className="w-3 h-3 mr-1" /> Preview
                </Button>
              </div>
              <Textarea value={blockMeshContent} onChange={(e) => setBlockMeshContent(e.target.value)} className="font-mono text-xs min-h-[350px]" spellCheck={false} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* STEP 3: Fields 0/ — REDESIGNED: one field at a time with dropdown */}
      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Wind className="w-5 h-5" /> Initial Fields (directory 0/)</CardTitle>
            <CardDescription>Configure physical fields and boundary conditions for each patch</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Field selector + actions row */}
            <div className="flex items-center gap-2 flex-wrap">
              <Label className="font-semibold text-sm">Active field:</Label>
              <Select
                value={String(activeFieldIdx)}
                onValueChange={(v) => setActiveFieldIdx(Number(v))}
              >
                <SelectTrigger className="w-48 font-mono text-sm">
                  <SelectValue placeholder="Select field" />
                </SelectTrigger>
                <SelectContent>
                  {fields.map((f, i) => (
                    <SelectItem key={i} value={String(i)} className="font-mono text-xs">
                      {f.fieldName || '(unnamed)'}
                      <span className="text-muted-foreground ml-2">({f.boundaryConditions.length} BC)</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Badge variant="secondary" className="text-xs">{fields.length} total fields</Badge>
              <div className="ml-auto flex gap-1">
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setNewFieldName(''); setShowNewFieldDialog(true); }}>
                  <Plus className="w-3 h-3 mr-1" /> Create field
                </Button>
                {fields.length > 0 && (
                  <Button size="sm" variant="outline" className="h-7 text-xs text-red-500 hover:text-red-700" onClick={() => removeField(activeFieldIdx)}>
                    <Trash2 className="w-3 h-3 mr-1" /> Delete
                  </Button>
                )}
              </div>
            </div>

            {/* Empty state */}
            {fields.length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                <Wind className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No fields configured.</p>
                <p className="text-xs mt-1">Click &quot;Create field&quot; to add one.</p>
              </div>
            )}

            {/* Single field editor */}
            {activeField && fields.length > 0 && (
              <div className="space-y-3">
                {/* Field header: name + dims + internal */}
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_1.5fr_1.5fr] gap-2">
                  <div>
                    <Label className="text-xs">Field name</Label>
                    <Input
                      value={activeField.fieldName}
                      onChange={(e) => updateField(activeFieldIdx, { fieldName: e.target.value })}
                      placeholder="FieldName"
                      className="font-mono text-sm h-8 mt-0.5"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Dimensions</Label>
                    <Input
                      value={activeField.dimensions}
                      onChange={(e) => updateField(activeFieldIdx, { dimensions: e.target.value })}
                      className="font-mono text-xs h-8 mt-0.5"
                      placeholder="[0 1 -1 0 0 0 0]"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Internal value</Label>
                      <Button size="sm" variant="ghost" className="h-5 text-[10px] px-1" onClick={() => previewFile(generateFieldFile(activeField), `0/${activeField.fieldName}`)}>
                        <Eye className="w-3 h-3 mr-0.5" /> File preview
                      </Button>
                    </div>
                    <Input
                      value={activeField.internalField}
                      onChange={(e) => updateField(activeFieldIdx, { internalField: e.target.value })}
                      className="font-mono text-xs h-8 mt-0.5"
                      placeholder="uniform (0 0 0)"
                    />
                  </div>
                </div>

                <Separator />

                {/* Boundary Conditions */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <Label className="text-sm font-medium">
                      Boundary Conditions ({activeField.boundaryConditions.length})
                    </Label>
                    <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => addBC(activeFieldIdx)}>
                      <Plus className="w-3 h-3 mr-1" /> Add BC
                    </Button>
                  </div>
                  <ScrollArea className="max-h-[300px]">
                    <div className="space-y-2">
                      {activeField.boundaryConditions.map((bc, bi) => (
                        <div key={bi} className="grid grid-cols-[1fr_1.3fr_1fr_auto] gap-1.5 items-center bg-muted/30 p-2 rounded-lg">
                          <Input value={bc.name} onChange={(e) => updateBC(activeFieldIdx, bi, { name: e.target.value })} placeholder="patch" className="h-7 text-xs font-mono" />
                          <Select value={bc.type} onValueChange={(v) => updateBC(activeFieldIdx, bi, { type: v })}>
                            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {BC_TYPES.map(t => <SelectItem key={t} value={t} className="text-xs font-mono">{t}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          <Input value={bc.value} onChange={(e) => updateBC(activeFieldIdx, bi, { value: e.target.value })} placeholder="value" className="h-7 text-xs font-mono" />
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-400 flex-shrink-0" onClick={() => removeBC(activeFieldIdx, bi)}><Trash2 className="w-3 h-3" /></Button>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* STEP 4: system/ */}
      {step === 4 && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><FileCode className="w-5 h-5" /> Directory system/</CardTitle></CardHeader>
          <CardContent>
            <Tabs defaultValue="controlDict">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="controlDict" className="text-xs">controlDict</TabsTrigger>
                <TabsTrigger value="fvSchemes" className="text-xs">fvSchemes</TabsTrigger>
                <TabsTrigger value="fvSolution" className="text-xs">fvSolution</TabsTrigger>
                <TabsTrigger value="blockMesh" className="text-xs">blockMeshDict</TabsTrigger>
              </TabsList>
              <TabsContent value="controlDict"><Card className="mt-2"><CardContent className="p-2"><Textarea value={controlDict} onChange={(e) => setSystemOverrides(p => ({ ...p, controlDict: e.target.value }))} className="font-mono text-xs min-h-[350px]" spellCheck={false} /></CardContent></Card></TabsContent>
              <TabsContent value="fvSchemes"><Card className="mt-2"><CardContent className="p-2"><Textarea value={fvSchemes} onChange={(e) => setSystemOverrides(p => ({ ...p, fvSchemes: e.target.value }))} className="font-mono text-xs min-h-[350px]" spellCheck={false} /></CardContent></Card></TabsContent>
              <TabsContent value="fvSolution"><Card className="mt-2"><CardContent className="p-2"><Textarea value={fvSolution} onChange={(e) => setSystemOverrides(p => ({ ...p, fvSolution: e.target.value }))} className="font-mono text-xs min-h-[350px]" spellCheck={false} /></CardContent></Card></TabsContent>
              <TabsContent value="blockMesh"><Card className="mt-2"><CardContent className="p-2"><Textarea value={blockMeshContent} onChange={(e) => setBlockMeshContent(e.target.value)} className="font-mono text-xs min-h-[350px]" spellCheck={false} /></CardContent></Card></TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}

      {/* STEP 5: constant/ */}
      {step === 5 && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Droplets className="w-5 h-5" /> Directory constant/</CardTitle></CardHeader>
          <CardContent>
            <Tabs defaultValue="transport">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="transport" className="text-xs">transportProperties</TabsTrigger>
                <TabsTrigger value="turbulence" className="text-xs">turbulenceProperties</TabsTrigger>
                <TabsTrigger value="gravity" className="text-xs">g (gravity)</TabsTrigger>
              </TabsList>
              <TabsContent value="transport"><Card className="mt-2"><CardContent className="p-2"><Textarea value={transportProps} onChange={(e) => setConstantOverrides(p => ({ ...p, transportProperties: e.target.value }))} className="font-mono text-xs min-h-[250px]" spellCheck={false} /></CardContent></Card></TabsContent>
              <TabsContent value="turbulence"><Card className="mt-2"><CardContent className="p-2"><Textarea value={turbProps} onChange={(e) => setConstantOverrides(p => ({ ...p, turbulenceProperties: e.target.value }))} className="font-mono text-xs min-h-[250px]" spellCheck={false} /></CardContent></Card></TabsContent>
              <TabsContent value="gravity"><Card className="mt-2"><CardContent className="p-2"><Textarea value={gravity} onChange={(e) => setGravity(e.target.value)} className="font-mono text-xs min-h-[80px]" spellCheck={false} /></CardContent></Card></TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}

      {/* STEP 6: Create */}
      {step === 6 && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><CheckCircle2 className="w-5 h-5" /> Summary and Creation</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div className="bg-muted/30 p-3 rounded"><div className="text-xs text-muted-foreground">Case name</div><div className="font-bold font-mono text-sm mt-0.5">{caseName || '—'}</div></div>
              <div className="bg-muted/30 p-3 rounded"><div className="text-xs text-muted-foreground">Solver</div><div className="font-bold font-mono text-sm mt-0.5">{solver}</div></div>
              <div className="bg-muted/30 p-3 rounded"><div className="text-xs text-muted-foreground">Turbulence</div><div className="font-bold text-sm mt-0.5">{turbulenceModel}</div></div>
              <div className="bg-muted/30 p-3 rounded"><div className="text-xs text-muted-foreground">Type</div><div className="font-bold text-sm mt-0.5">{isTransient ? 'Transient' : 'Steady-state'}</div></div>
              <div className="bg-muted/30 p-3 rounded"><div className="text-xs text-muted-foreground">Compressible</div><div className="font-bold text-sm mt-0.5">{isCompressible ? 'Yes' : 'No'}</div></div>
              <div className="bg-muted/30 p-3 rounded"><div className="text-xs text-muted-foreground">Heat Transfer</div><div className="font-bold text-sm mt-0.5">{hasHeatTransfer ? 'Yes' : 'No'}</div></div>
            </div>
            <Separator />
            <div>
              <Label className="text-sm font-medium">Fields in 0/ ({fields.filter(f => f.fieldName).length})</Label>
              <div className="flex flex-wrap gap-1 mt-1">
                {fields.filter(f => f.fieldName).map(f => (
                  <Badge key={f.fieldName} variant="secondary" className="font-mono">{f.fieldName} <span className="text-muted-foreground ml-1">({f.boundaryConditions.length} BC)</span></Badge>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium">Files that will be created ({totalFiles})</Label>
              <div className="font-mono text-xs mt-1 space-y-0.5 text-muted-foreground columns-2">
                {fields.filter(f => f.fieldName).map(f => <div key={f.fieldName}>0/{f.fieldName}</div>)}
                <div>system/controlDict</div><div>system/fvSchemes</div><div>system/fvSolution</div><div>system/blockMeshDict</div>
                <div>constant/transportProperties</div><div>constant/turbulenceProperties</div>
                {(hasHeatTransfer || isCompressible) && <div>constant/g</div>}
              </div>
            </div>
            <Separator />
            <Button className="w-full py-6 text-base" onClick={handleCreate} disabled={creating || !caseName.trim()}>
              {creating ? <><span className="animate-spin mr-2">⟳</span> Creating...</> : <><CheckCircle2 className="w-5 h-5 mr-2" /> Create case &quot;{caseName || '...'}&quot;</>}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step Progress Indicator */}
      <div className="flex items-center justify-center gap-1.5 pb-3">
        {STEPS.map((s, i) => (
          <React.Fragment key={s.id}>
            <button
              onClick={() => i < step && !s.id.startsWith('create') && setStep(i)}
              className="flex items-center gap-1.5 transition-opacity"
              style={{ opacity: i <= step ? 1 : 0.3 }}
            >
              <div className={`w-7 h-7 rounded-full flex items-center justify-center border-2 transition-colors ${
                i < step
                  ? 'border-primary bg-primary text-primary-foreground'
                  : i === step
                    ? 'border-primary text-primary bg-transparent'
                    : 'border-muted-foreground/30 text-muted-foreground/40'
              }`}>
                {i < step ? <Check className="w-3.5 h-3.5" /> : <span className="text-[10px] font-bold font-mono">{i + 1}</span>}
              </div>
            </button>
            {i < STEPS.length - 1 && (
              <div className={`w-8 h-0.5 rounded-full ${i < step ? 'bg-primary' : 'bg-muted-foreground/20'}`} />
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Navigation — always visible, never overlaid */}
      <div className="flex justify-between sticky bottom-0 bg-background py-2 border-t mt-2">
        <Button variant="outline" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>
          <ChevronLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={() => {
            if (step === 0 && !caseName.trim()) { toast.error('Enter a name'); return; }
            setStep(step + 1);
          }}>
            Next <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        ) : null}
      </div>

      {/* New Field Dialog */}
      <Dialog open={showNewFieldDialog} onOpenChange={setShowNewFieldDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Field</DialogTitle></DialogHeader>
          <div className="space-y-3 pt-2">
            <div>
              <Label>Field name</Label>
              <Input
                value={newFieldName}
                onChange={(e) => setNewFieldName(e.target.value.replace(/\s/g, ''))}
                placeholder="e.g. k, epsilon, T, phi"
                className="font-mono"
                onKeyDown={(e) => e.key === 'Enter' && handleCreateNewField()}
              />
              <p className="text-xs text-muted-foreground mt-1">Only letters, numbers and dots. No spaces.</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowNewFieldDialog(false)}>Cancel</Button>
              <Button onClick={handleCreateNewField} disabled={!newFieldName.trim()}>
                <Plus className="w-4 h-4 mr-1" /> Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Preview Dialog */}
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
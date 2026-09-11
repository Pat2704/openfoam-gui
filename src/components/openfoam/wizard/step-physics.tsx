'use client';

/**
 * The Physics step of the complete guide (OpenFOAM 13 and 14): the solver
 * module, and everything that module's physics needs — time, turbulence,
 * the fluid's thermophysics, gravity, species, phases, solid properties and
 * initial regions. Or, for any module, a start from one of the installation's
 * own tutorials of that module (the only route for the modules whose physics
 * is many interlocking dictionaries).
 *
 * Every list offered comes from the installation (the foamToC catalogue of the
 * app's index), intersected with what the wizard knows how to write.
 */

import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Zap, Plus, Trash2, Loader2, BookOpen, AlertTriangle, Info } from 'lucide-react';
import { CATEGORY_LABEL, type ModuleCategory, type ModuleInfo } from '@/lib/wizard/modules';
import {
  COEFF_INFO, LES_DELTAS, THERMO_PRESETS, comboSupported, preset, thermoKeys, turbulenceChoices,
  type FullPhysics, type InitialRegion, type RegionShape, type ThermoProps,
} from '@/lib/wizard/physics';
import { THERMO_KEYS, resolveThermo, thermoOptions, type ThermoCombo, type ThermoKey } from '@/lib/wizard/thermo';
import type { Vec3 } from '@/lib/geometry';
import { Choice, Hint, NumField, Vec3Field } from './ui';

/** What /api/foam-index?action=wizardCatalog answers, with the thermo tables parsed. */
export interface WizardCatalog {
  solvers: string[];
  ras: string[];
  les: string[];
  thermo: Record<string, ThermoCombo[]>;
  functionObjects: string[];
}

/** liquidProperties names on 13 and 14 (survey A.0.4, table liquidProperties). */
const LIQUIDS = ['H2O', 'Ar', 'C10H22', 'C12H26', 'C13H28', 'C14H30', 'C16H34', 'C2H5OH', 'C2H6', 'C2H6O', 'C3H6O', 'C3H8', 'C4H10O', 'C6H14', 'C6H6', 'C7H16', 'C7H8', 'C8H10', 'C8H18', 'C9H20', 'CH3OH', 'CH4N2O', 'IC8H18', 'IDEA', 'MB', 'N2', 'NH3', 'aC11H10', 'bC11H10', 'iC3H8O', 'nC3H8O'];

function Section({ title, children, hint }: { title: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Separator />
      <Label className="text-sm">{title}</Label>
      {hint && <Hint>{hint}</Hint>}
      {children}
    </div>
  );
}

function TextField({ label, value, onChange, placeholder, className, title }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; className?: string; title?: string;
}) {
  return (
    <div className={className} title={title}>
      <Label className="text-[11px]">{label}</Label>
      <Input value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} className="font-mono text-xs h-8 mt-0.5" />
    </div>
  );
}

/**
 * A thermoType and its coefficients. Each component offers only values that
 * form a real combination with the others in the installation's table, and
 * only components whose coefficients the wizard knows.
 */
export function ThermoEditor({ value, onChange, combos, allowLiquid }: {
  value: ThermoProps; onChange: (v: ThermoProps) => void; combos: ThermoCombo[]; allowLiquid?: boolean;
}) {
  const usable = combos.filter(c => (c.properties ? allowLiquid && c.properties === 'liquid' : comboSupported(c)));
  const liquid = !!value.combo.properties;
  const chains = usable.filter(c => !c.properties);
  const opts = thermoOptions(chains, value.combo);
  const setKey = (k: ThermoKey, v: string) => {
    const next = resolveThermo(chains, { ...value.combo, [k]: v }, [k]) ?? { ...value.combo, [k]: v };
    onChange({ ...value, combo: next });
  };
  const keys = thermoKeys(value.combo);
  const coeffKeys = [...keys.specie, ...keys.equationOfState, ...keys.thermodynamics, ...keys.transport];
  const presets = THERMO_PRESETS.filter(p => (p.props.combo.properties ? allowLiquid : true));
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-muted-foreground">Preset:</span>
        {presets.map(p => (
          <Button key={p.id} size="sm" variant="outline" className="h-7 text-xs" onClick={() => onChange(preset(p.id))}>{p.label}</Button>
        ))}
      </div>
      {liquid ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
          <div>
            <Label className="text-[11px]">Liquid (liquidProperties)</Label>
            <Select value={value.liquid || 'H2O'} onValueChange={v => onChange({ ...value, liquid: v })}>
              <SelectTrigger className="h-8 text-xs font-mono mt-0.5"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">{LIQUIDS.map(l => <SelectItem key={l} value={l} className="text-xs font-mono">{l}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Hint className="col-span-3">Temperature- and pressure-dependent properties from the installation&apos;s liquidProperties library.</Hint>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
            {THERMO_KEYS.map(k => (
              <div key={k}>
                <Label className="text-[11px]">{k}</Label>
                <Select value={value.combo[k]} onValueChange={v => setKey(k, v)}>
                  <SelectTrigger className="h-8 text-xs font-mono mt-0.5"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[...new Set([value.combo[k], ...opts[k]])].filter(Boolean).map(o => (
                      <SelectItem key={o} value={o} className="text-xs font-mono">{o}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
            {coeffKeys.map(k => (
              <TextField key={k} label={`${COEFF_INFO[k]?.label ?? k}${COEFF_INFO[k]?.unit ? ` [${COEFF_INFO[k].unit}]` : ''}`}
                value={value.coeffs[k] ?? ''} onChange={v => onChange({ ...value, coeffs: { ...value.coeffs, [k]: v } })} />
            ))}
          </div>
        </>
      )}
      {combos.length === 0 && <Hint>The installation&apos;s list of thermophysical models has not arrived yet; the choice is checked once it does.</Hint>}
    </div>
  );
}

function RegionEditor({ regions, onChange, fields, box }: {
  regions: InitialRegion[]; onChange: (r: InitialRegion[]) => void; fields: string[]; box: { min: Vec3; max: Vec3 };
}) {
  const update = (i: number, u: Partial<InitialRegion>) => onChange(regions.map((r, j) => (j === i ? { ...r, ...u } : r)));
  const add = () => {
    let n = regions.length + 1;
    while (regions.some(r => r.name === `region${n}`)) n++;
    const mid = [0, 1, 2].map(a => (box.min[a] + box.max[a]) / 2) as Vec3;
    onChange([...regions, {
      name: `region${n}`, shape: 'box', min: [...box.min] as Vec3, max: mid,
      centre: mid, radius: Math.max(...[0, 1, 2].map(a => box.max[a] - box.min[a])) / 4,
      point1: [box.min[0], mid[1], mid[2]], point2: [box.max[0], mid[1], mid[2]], values: {},
    }]);
  };
  const settable = fields.filter(f => f !== 'nut' && f !== 'alphat');
  return (
    <div className="space-y-2">
      {regions.map((r, i) => (
        <div key={i} className="rounded-md bg-muted/30 p-2 space-y-1.5">
          <div className="grid grid-cols-[1fr_8rem_auto] gap-2 items-end">
            <TextField label="Region name" value={r.name} onChange={v => update(i, { name: v.replace(/\s/g, '') })} />
            <div>
              <Label className="text-[11px]">Shape</Label>
              <Select value={r.shape} onValueChange={v => update(i, { shape: v as RegionShape })}>
                <SelectTrigger className="h-8 text-xs mt-0.5"><SelectValue /></SelectTrigger>
                <SelectContent>{['box', 'sphere', 'cylinder'].map(s => <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-red-500" onClick={() => onChange(regions.filter((_, j) => j !== i))} aria-label={`Remove ${r.name}`}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
          {r.shape === 'box' && <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <Vec3Field label="min" value={r.min} onChange={v => update(i, { min: v })} />
            <Vec3Field label="max" value={r.max} onChange={v => update(i, { max: v })} /></div>}
          {r.shape === 'sphere' && <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-2">
            <Vec3Field label="centre" value={r.centre} onChange={v => update(i, { centre: v })} />
            <NumField label="radius" value={r.radius} onChange={v => update(i, { radius: v })} /></div>}
          {r.shape === 'cylinder' && <div className="grid grid-cols-1 md:grid-cols-[2fr_2fr_1fr] gap-2">
            <Vec3Field label="axis point 1" value={r.point1} onChange={v => update(i, { point1: v })} />
            <Vec3Field label="axis point 2" value={r.point2} onChange={v => update(i, { point2: v })} />
            <NumField label="radius" value={r.radius} onChange={v => update(i, { radius: v })} /></div>}
          <div className="flex flex-wrap gap-2 items-end">
            {Object.entries(r.values).map(([f, v]) => (
              <div key={f} className="flex items-end gap-1">
                <TextField className="w-32" label={f} value={v} onChange={nv => update(i, { values: { ...r.values, [f]: nv } })} />
                <Button size="sm" variant="ghost" className="h-8 w-6 p-0" aria-label={`Stop setting ${f}`}
                  onClick={() => { const n = { ...r.values }; delete n[f]; update(i, { values: n }); }}>×</Button>
              </div>
            ))}
            <Select value="" onValueChange={f => update(i, { values: { ...r.values, [f]: f === 'U' ? '(0 0 0)' : '1' } })}>
              <SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="Set a field…" /></SelectTrigger>
              <SelectContent>{settable.filter(f => !(f in r.values)).map(f => <SelectItem key={f} value={f} className="text-xs font-mono">{f}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
      ))}
      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={add}><Plus className="w-3 h-3 mr-1" /> Add region</Button>
    </div>
  );
}

interface TutorialCase { name: string; fullPath: string }

function SeedPicker({ module, phys, setPhys }: {
  module: ModuleInfo; phys: FullPhysics; setPhys: (u: (p: FullPhysics) => FullPhysics) => void;
}) {
  const [cases, setCases] = useState<TutorialCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCases(null); setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/tutorials?action=module&module=${encodeURIComponent(module.id)}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setCases(Array.isArray(data.cases) ? data.cases : []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [module.id]);

  const pick = async (c: TutorialCase) => {
    setLoading(c.fullPath);
    try {
      const res = await fetch(`/api/tutorials?action=seed&path=${encodeURIComponent(c.fullPath)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setPhys(p => ({ ...p, seed: { tutorial: c.fullPath, files: data.files, overrides: {} } }));
      toast.success(`Started from ${c.name}: ${data.files.length} files read`);
    } catch (e) {
      toast.error(`Could not read ${c.name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(null);
    }
  };

  const allrun = phys.seed?.files.find(f => f.path === 'Allrun')?.content;
  return (
    <div className="space-y-2">
      {error && <p className="text-xs text-danger">{error}</p>}
      {cases === null && !error && <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Listing the installation&apos;s {module.id} tutorials…</p>}
      {cases?.length === 0 && <p className="text-xs text-muted-foreground">The installation has no {module.id} tutorial to start from.</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
        {cases?.map(c => (
          <button key={c.fullPath} type="button" onClick={() => void pick(c)} disabled={!!loading}
            className={`text-left px-3 py-2 rounded-lg border text-xs transition-colors ${phys.seed?.tutorial === c.fullPath ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}>
            <div className="font-mono font-medium flex items-center gap-1">
              {loading === c.fullPath ? <Loader2 className="w-3 h-3 animate-spin" /> : <BookOpen className="w-3 h-3" />} {c.name}
            </div>
          </button>
        ))}
      </div>
      {phys.seed && (
        <div className="rounded-md border p-2 text-xs space-y-1">
          <div>
            Physics from <span className="font-mono">{phys.seed.tutorial.split('/').slice(-2).join('/')}</span>:
            {' '}{phys.seed.files.filter(f => /^(constant|system)\//.test(f.path)).length} dictionaries and {phys.seed.files.filter(f => /^0(\.orig)?\//.test(f.path)).length} field files.
            The mesh is the wizard&apos;s; each field&apos;s conditions are re-targeted to its patches by role (Fields step), and the
            dictionaries are editable in the system/ and constant/ steps.
          </div>
          {allrun && (
            <details>
              <summary className="cursor-pointer text-muted-foreground">How the tutorial prepares its case (Allrun, for reference)</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/30 p-2 text-[11px] font-mono whitespace-pre-wrap">{allrun}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export default function PhysicsStepFull(p: {
  modules: ModuleInfo[];
  module: ModuleInfo;
  onModule: (id: string) => void;
  phys: FullPhysics;
  setPhys: (u: (p: FullPhysics) => FullPhysics) => void;
  transient: boolean; setTransient: (v: boolean) => void;
  endTime: string; setEndTime: (v: string) => void;
  deltaT: string; setDeltaT: (v: string) => void;
  writeInterval: string; setWriteInterval: (v: string) => void;
  catalog: WizardCatalog | null;
  fields: string[];
  box: { min: Vec3; max: Vec3 };
}) {
  const { module: m, phys, setPhys } = p;
  const seeded = m.physics === 'tutorial' || !!phys.seed;
  const [source, setSource] = useState<'forms' | 'tutorial'>(seeded ? 'tutorial' : 'forms');
  useEffect(() => { setSource(m.physics === 'tutorial' || phys.seed ? 'tutorial' : 'forms'); }, [m.id]);
  const set = <K extends keyof FullPhysics>(k: K, v: FullPhysics[K]) => setPhys(x => ({ ...x, [k]: v }));
  const turb = turbulenceChoices(m.physics, p.catalog ? { ras: p.catalog.ras, les: p.catalog.les } : null);
  const table = (name: string) => p.catalog?.thermo[name] ?? [];

  const categories = [...new Set(p.modules.map(x => x.category))] as ModuleCategory[];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Zap className="w-5 h-5" /> Solver module &amp; physics</CardTitle>
        <CardDescription>Every solver module of this installation. foamRun runs the one named in system/controlDict.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          {categories.map(cat => (
            <div key={cat}>
              <div className="text-[11px] font-medium text-muted-foreground mb-1">{CATEGORY_LABEL[cat]}</div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-1.5">
                {p.modules.filter(x => x.category === cat).map(x => (
                  <button key={x.id} type="button" onClick={() => p.onModule(x.id)}
                    className={`text-left px-3 py-2 rounded-lg border text-sm transition-colors ${m.id === x.id ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}>
                    <div className="font-mono font-medium flex items-center gap-1.5">
                      {x.label}
                      <Badge variant="secondary" className="text-[9px] font-sans">{x.physics === 'tutorial' ? 'from a tutorial' : 'forms'}</Badge>
                    </div>
                    <div className="text-[11px] text-muted-foreground">{x.summary}</div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <Section title="How to build it">
          <Choice value={source} onChange={v => { setSource(v); if (v === 'forms') set('seed', null); }} options={[
            { v: 'forms', label: 'Guided forms', desc: 'The wizard writes every file from the choices below', disabled: m.physics === 'tutorial' },
            { v: 'tutorial', label: `Start from a ${m.id} tutorial`, desc: 'Its physics dictionaries, your mesh and patches' },
          ]} />
          {m.physics === 'tutorial' && (
            <Hint>
              {m.id}&apos;s physics is a set of interlocking dictionaries (phase systems, clouds, combustion models) that no short form
              can fill correctly, so the case starts from one of the installation&apos;s own {m.id} tutorials.
            </Hint>
          )}
        </Section>

        <Section title="Time">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label className="text-[11px] block mb-1">Run</Label>
              <div className="flex gap-1.5">
                {[{ v: false, l: 'Steady-state' }, { v: true, l: 'Transient' }].map(t => (
                  <button key={String(t.v)} type="button" onClick={() => p.setTransient(t.v)} disabled={(t.v ? false : !m.steady)}
                    className={`px-3 py-1.5 rounded-lg border text-sm disabled:opacity-40 ${p.transient === t.v ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}>{t.l}</button>
                ))}
              </div>
            </div>
            <TextField className="w-28" label="endTime" value={p.endTime} onChange={p.setEndTime} />
            <TextField className="w-28" label={p.transient ? 'deltaT [s]' : 'deltaT (iteration)'} value={p.deltaT} onChange={p.setDeltaT} />
            <TextField className="w-28" label="writeInterval" value={p.writeInterval} onChange={p.setWriteInterval} />
            {p.transient && (
              <>
                <div>
                  <Label className="text-[11px]">writeControl</Label>
                  <Select value={phys.time.writeControl} onValueChange={v => set('time', { ...phys.time, writeControl: v as FullPhysics['time']['writeControl'] })}>
                    <SelectTrigger className="h-8 w-40 text-xs font-mono mt-0.5"><SelectValue /></SelectTrigger>
                    <SelectContent>{['timeStep', 'runTime', 'adjustableRunTime'].map(w => <SelectItem key={w} value={w} className="text-xs font-mono">{w}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <label className="flex items-center gap-2 h-8 text-xs cursor-pointer">
                  <Checkbox checked={phys.time.adjustTimeStep} onCheckedChange={v => set('time', { ...phys.time, adjustTimeStep: v === true })} /> Adjust the time step to a Courant number
                </label>
                {phys.time.adjustTimeStep && (
                  <>
                    <TextField className="w-20" label="maxCo" value={phys.time.maxCo} onChange={v => set('time', { ...phys.time, maxCo: v })} />
                    {['vof', 'compressibleVof', 'driftFlux'].includes(m.physics) && (
                      <TextField className="w-20" label="maxAlphaCo" value={phys.time.maxAlphaCo} onChange={v => set('time', { ...phys.time, maxAlphaCo: v })} />
                    )}
                    <TextField className="w-24" label="maxDeltaT" value={phys.time.maxDeltaT} onChange={v => set('time', { ...phys.time, maxDeltaT: v })} />
                  </>
                )}
              </>
            )}
            <TextField className="w-24" label="purgeWrite" value={phys.time.purgeWrite} onChange={v => set('time', { ...phys.time, purgeWrite: v })} title="Keep only the last N written times (0 keeps all)" />
            <div>
              <Label className="text-[11px]">writeFormat</Label>
              <Select value={phys.time.writeFormat} onValueChange={v => set('time', { ...phys.time, writeFormat: v as 'ascii' | 'binary' })}>
                <SelectTrigger className="h-8 w-24 text-xs font-mono mt-0.5"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="ascii" className="text-xs">ascii</SelectItem><SelectItem value="binary" className="text-xs">binary</SelectItem></SelectContent>
              </Select>
            </div>
          </div>
          {!m.steady && <Hint>{m.id} has no steady form.</Hint>}
        </Section>

        {source === 'tutorial' ? (
          <Section title={`Start from a ${m.id} tutorial`}>
            <SeedPicker module={m} phys={phys} setPhys={setPhys} />
          </Section>
        ) : (
          <>
            {m.turbulence && (
              <Section title="Turbulence" hint="Models listed are those this installation provides whose fields the wizard knows.">
                <div className="flex flex-wrap gap-3 items-end">
                  <div className="flex gap-1.5">
                    {(['laminar', 'RAS', 'LES'] as const).map(s => (
                      <button key={s} type="button" onClick={() => setPhys(x => ({ ...x, simulationType: s, model: s === 'RAS' ? (turb.ras.includes(x.model) ? x.model : turb.ras.includes('kOmegaSST') ? 'kOmegaSST' : turb.ras[0]) : s === 'LES' ? (turb.les.includes(x.model) ? x.model : turb.les[0]) : x.model }))}
                        className={`px-3 py-1.5 rounded-lg border text-sm ${phys.simulationType === s ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}>{s}</button>
                    ))}
                  </div>
                  {phys.simulationType !== 'laminar' && (
                    <div>
                      <Label className="text-[11px]">Model</Label>
                      <Select value={phys.model} onValueChange={v => set('model', v)}>
                        <SelectTrigger className="h-8 w-48 text-xs font-mono mt-0.5"><SelectValue /></SelectTrigger>
                        <SelectContent>{(phys.simulationType === 'RAS' ? turb.ras : turb.les).map(x => <SelectItem key={x} value={x} className="text-xs font-mono">{x}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  )}
                  {phys.simulationType === 'LES' && (
                    <div>
                      <Label className="text-[11px]">delta</Label>
                      <Select value={phys.delta} onValueChange={v => set('delta', v)}>
                        <SelectTrigger className="h-8 w-40 text-xs font-mono mt-0.5"><SelectValue /></SelectTrigger>
                        <SelectContent>{LES_DELTAS.map(x => <SelectItem key={x} value={x} className="text-xs font-mono">{x}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  )}
                  {phys.simulationType !== 'laminar' && (
                    <>
                      <TextField className="w-28" label="Intensity [%]" value={phys.intensity} onChange={v => set('intensity', v)} />
                      <TextField className="w-28" label="Length scale [m]" value={phys.lengthScale} placeholder="7% of height" onChange={v => set('lengthScale', v)} />
                    </>
                  )}
                </div>
              </Section>
            )}

            {m.family === 'flow' && (
              <Section title="Inflow">
                <TextField className="w-48" label="Inlet velocity [m/s] (default for inlets)" value={phys.inletVelocity} onChange={v => set('inletVelocity', v)} />
              </Section>
            )}

            {m.physics === 'incompressible' && (
              <Section title="Fluid">
                <div className="flex items-end gap-2 flex-wrap">
                  <TextField className="w-40" label="Kinematic viscosity ν [m²/s]" value={phys.nu} onChange={v => set('nu', v)} />
                  {[['air', '1.5e-05'], ['water', '1e-06'], ['oil', '1e-04']].map(([l, v]) => (
                    <Button key={l} size="sm" variant="outline" className="h-8 text-xs" onClick={() => set('nu', v)}>{l}</Button>
                  ))}
                </div>
              </Section>
            )}

            {['isothermal', 'thermal', 'shock'].includes(m.physics) && (
              <Section title="Fluid thermophysics" hint={m.physics === 'shock' ? 'shockFluid tutorials all use hePsiThermo (table psiThermo).' : 'Combinations from the installation\'s fluidThermo table.'}>
                <ThermoEditor value={phys.fluid} onChange={v => set('fluid', v)} combos={table(m.physics === 'shock' ? 'psiThermo' : 'fluidThermo')} />
                <div className="flex gap-2 flex-wrap">
                  <TextField className="w-36" label="Pressure p [Pa]" value={phys.p} onChange={v => set('p', v)} />
                  <TextField className="w-36" label="Temperature T [K]" value={phys.T} onChange={v => set('T', v)} />
                </div>
              </Section>
            )}

            {m.physics === 'multicomponent' && (
              <Section title="Mixture and species" hint="A non-reacting mixture. For combustion start from a multicomponentFluid tutorial (counterFlowFlame2D and others).">
                <ThermoEditor value={{ combo: phys.mixture, coeffs: {}, liquid: '' }} onChange={v => set('mixture', v.combo)}
                  combos={table('fluidMulticomponentThermo').filter(c => c.mixture === 'multicomponentMixture')} />
                <div className="space-y-1.5">
                  {phys.species.map((s, i) => {
                    const keys = Object.values(thermoKeys(phys.mixture)).flat();
                    const upd = (u: Partial<typeof s>) => set('species', phys.species.map((x, j) => (j === i ? { ...x, ...u } : x)));
                    return (
                      <div key={i} className="flex flex-wrap items-end gap-2 rounded-md bg-muted/30 p-2">
                        <TextField className="w-28" label="Specie" value={s.name} onChange={v => upd({ name: v.replace(/\s/g, '') })} />
                        <TextField className="w-24" label="Initial Y" value={s.initial} onChange={v => upd({ initial: v })} />
                        {keys.map(k => <TextField key={k} className="w-24" label={k} value={s.coeffs[k] ?? ''} onChange={v => upd({ coeffs: { ...s.coeffs, [k]: v } })} />)}
                        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-red-500" onClick={() => set('species', phys.species.filter((_, j) => j !== i))} aria-label={`Remove ${s.name}`}><Trash2 className="w-3.5 h-3.5" /></Button>
                      </div>
                    );
                  })}
                  <div className="flex items-end gap-2">
                    <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => set('species', [...phys.species, { name: `specie${phys.species.length + 1}`, coeffs: { ...phys.species[0]?.coeffs }, initial: '0' }])}>
                      <Plus className="w-3 h-3 mr-1" /> Add specie
                    </Button>
                    <div>
                      <Label className="text-[11px]">Default (inert) specie</Label>
                      <Select value={phys.defaultSpecie} onValueChange={v => set('defaultSpecie', v)}>
                        <SelectTrigger className="h-8 w-36 text-xs font-mono mt-0.5"><SelectValue /></SelectTrigger>
                        <SelectContent>{phys.species.map(s => <SelectItem key={s.name} value={s.name} className="text-xs font-mono">{s.name}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <TextField className="w-36" label="Pressure p [Pa]" value={phys.p} onChange={v => set('p', v)} />
                  <TextField className="w-36" label="Temperature T [K]" value={phys.T} onChange={v => set('T', v)} />
                </div>
              </Section>
            )}

            {['vof', 'compressibleVof', 'driftFlux'].includes(m.physics) && (
              <Section title="Phases" hint={m.physics === 'driftFlux' ? 'The first phase is the dispersed one (its alpha is solved).' : 'The first phase\'s volume fraction is the field solved (alpha.<first phase>).'}>
                {phys.phases.map((ph, i) => {
                  const upd = (u: Partial<typeof ph>) => set('phases', phys.phases.map((x, j) => (j === i ? { ...x, ...u } : x)) as FullPhysics['phases']);
                  return (
                    <div key={i} className="rounded-md bg-muted/30 p-2 space-y-2">
                      <div className="flex flex-wrap items-end gap-2">
                        <TextField className="w-32" label={i === 0 ? 'First phase' : 'Second phase'} value={ph.name} onChange={v => upd({ name: v.replace(/\s/g, '') })} />
                        {m.physics !== 'compressibleVof' && (
                          <>
                            {!(m.physics === 'driftFlux' && i === 0) && <TextField className="w-32" label="ν [m²/s]" value={ph.nu} onChange={v => upd({ nu: v })} />}
                            <TextField className="w-28" label="ρ [kg/m³]" value={ph.rho} onChange={v => upd({ rho: v })} />
                          </>
                        )}
                      </div>
                      {m.physics === 'compressibleVof' && (
                        <ThermoEditor value={ph.thermo} onChange={v => upd({ thermo: v })} combos={table('fluidThermo')} allowLiquid />
                      )}
                    </div>
                  );
                })}
                {m.physics !== 'driftFlux' && <TextField className="w-40" label="Surface tension σ [N/m]" value={phys.sigma} onChange={v => set('sigma', v)}
                  title={m.physics === 'compressibleVof' ? 'Used when the first phase is not a liquidProperties liquid' : undefined} />}
                {m.physics === 'compressibleVof' && (
                  <div className="flex gap-2 flex-wrap">
                    <TextField className="w-36" label="Pressure p [Pa]" value={phys.p} onChange={v => set('p', v)} />
                    <TextField className="w-36" label="Temperature T [K]" value={phys.T} onChange={v => set('T', v)} />
                  </div>
                )}
                {m.physics === 'driftFlux' && (
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2 items-end">
                      <div>
                        <Label className="text-[11px]">relativeVelocityModel</Label>
                        <Select value={phys.drift.model} onValueChange={v => set('drift', { ...phys.drift, model: v as 'simple' | 'general' })}>
                          <SelectTrigger className="h-8 w-32 text-xs font-mono mt-0.5"><SelectValue /></SelectTrigger>
                          <SelectContent><SelectItem value="simple" className="text-xs">simple</SelectItem><SelectItem value="general" className="text-xs">general</SelectItem></SelectContent>
                        </Select>
                      </div>
                      {(['Vc', 'a', 'a1', 'residualAlpha'] as const).map(k => <TextField key={k} className="w-24" label={k} value={phys.drift[k]} onChange={v => set('drift', { ...phys.drift, [k]: v })} />)}
                    </div>
                    <div className="flex flex-wrap gap-2 items-end">
                      <div>
                        <Label className="text-[11px]">Dispersed viscosity</Label>
                        <Select value={phys.drift.viscosity} onValueChange={v => set('drift', { ...phys.drift, viscosity: v as 'plastic' | 'BinghamPlastic' })}>
                          <SelectTrigger className="h-8 w-36 text-xs font-mono mt-0.5"><SelectValue /></SelectTrigger>
                          <SelectContent><SelectItem value="plastic" className="text-xs">plastic</SelectItem><SelectItem value="BinghamPlastic" className="text-xs">BinghamPlastic</SelectItem></SelectContent>
                        </Select>
                      </div>
                      {(['coeff', 'exponent', 'muMax', ...(phys.drift.viscosity === 'BinghamPlastic' ? ['BinghamCoeff', 'BinghamExponent', 'BinghamOffset'] as const : [])] as const).map(k => (
                        <TextField key={k} className="w-28" label={k} value={phys.drift[k]} onChange={v => set('drift', { ...phys.drift, [k]: v })} />
                      ))}
                    </div>
                  </div>
                )}
              </Section>
            )}

            {m.gravity !== 'none' && (
              <Section title="Gravity">
                <div className="flex flex-wrap items-end gap-3">
                  <TextField className="w-40" label="g [m/s²]" value={phys.gravity} onChange={v => set('gravity', v)} />
                  {m.gravity === 'optional' && (
                    <label className="flex items-center gap-2 h-8 text-xs cursor-pointer">
                      <Checkbox checked={phys.buoyant} onCheckedChange={v => set('buoyant', v === true)} />
                      Buoyant flow: solve p_rgh with gravity (natural convection, stratification)
                    </label>
                  )}
                </div>
              </Section>
            )}

            {m.physics === 'solidThermal' && (
              <Section title="Solid (constSolidThermo)">
                <div className="flex flex-wrap gap-2">
                  <TextField className="w-28" label="ρ [kg/m³]" value={phys.solid.rho} onChange={v => set('solid', { ...phys.solid, rho: v })} />
                  <TextField className="w-28" label="Cv [J/(kg K)]" value={phys.solid.Cv} onChange={v => set('solid', { ...phys.solid, Cv: v })} />
                  <TextField className="w-28" label="κ [W/(m K)]" value={phys.solid.kappa} onChange={v => set('solid', { ...phys.solid, kappa: v })} />
                  <TextField className="w-28" label="T initial [K]" value={phys.T} onChange={v => set('T', v)} />
                  <TextField className="w-40" label="Heat source [W/m³] (optional)" value={phys.solid.heatSource} onChange={v => set('solid', { ...phys.solid, heatSource: v })} />
                </div>
              </Section>
            )}

            {m.physics === 'solidMechanics' && (
              <Section title="Elastic solid">
                <div className="flex flex-wrap gap-2">
                  {(['rho', 'E', 'nu', 'Cv', 'kappa', 'alphav'] as const).map(k => (
                    <TextField key={k} className="w-28" label={{ rho: 'ρ [kg/m³]', E: 'E [Pa]', nu: 'Poisson ν', Cv: 'Cv [J/(kg K)]', kappa: 'κ [W/(m K)]', alphav: 'α [1/K]' }[k]}
                      value={phys.elastic[k]} onChange={v => set('elastic', { ...phys.elastic, [k]: v })} />
                  ))}
                  <TextField className="w-28" label="T initial [K]" value={phys.T} onChange={v => set('T', v)} />
                </div>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-xs cursor-pointer"><Checkbox checked={phys.elastic.planeStress} onCheckedChange={v => set('elastic', { ...phys.elastic, planeStress: v === true })} /> Plane stress (thin 2D plate)</label>
                  <label className="flex items-center gap-2 text-xs cursor-pointer"><Checkbox checked={phys.elastic.thermalStress} onCheckedChange={v => set('elastic', { ...phys.elastic, thermalStress: v === true })} /> Thermal stresses (solve T too)</label>
                </div>
              </Section>
            )}

            {m.family === 'flow' && m.physics !== 'shock' || ['vof', 'compressibleVof', 'driftFlux', 'shock'].includes(m.physics) ? (
              <Section title="Initial regions (setFields)"
                hint="Zones that start with other values than the rest of the domain: a water column, a hot spot, a high-pressure chamber. setFields fills them after the mesh is built.">
                <RegionEditor regions={phys.initialRegions} onChange={r => set('initialRegions', r)} fields={p.fields} box={p.box} />
              </Section>
            ) : null}
          </>
        )}

        {m.physics !== 'tutorial' && !phys.seed && (
          <p className="text-[11px] text-muted-foreground flex items-start gap-1">
            <Info className="w-3 h-3 mt-px flex-shrink-0" />
            Each patch&apos;s own values (inlet velocity, wall temperature, heat flux, load…) are set in the Fields step, next to its conditions.
          </p>
        )}
        {p.catalog === null && (
          <p className="text-[11px] text-amber-600 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> The installation&apos;s catalogue is still being read; lists will narrow to it once it arrives.</p>
        )}
      </CardContent>
    </Card>
  );
}

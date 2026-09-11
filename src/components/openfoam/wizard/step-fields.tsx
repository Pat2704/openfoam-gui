'use client';

/**
 * The Fields step: one condition per patch, per field.
 *
 * Two layers. "Patch values" says what each patch imposes in physical terms —
 * the inlet's velocity, a wall's temperature or heat flux, an outlet's
 * pressure, a load — and "Apply" turns them into the conditions every field
 * gets (src/lib/wizard/boundary.ts). Below it, the conditions themselves,
 * editable one by one; an edit stays until Apply is pressed again.
 */

import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Wind, Plus, Trash2, RefreshCw, Eye, AlertTriangle } from 'lucide-react';
import type { FieldConfig, MeshPatch } from '@/lib/case-templates';
import { ROLE_INFO } from '@/lib/wizard/roles';
import type { PhysicsKind } from '@/lib/wizard/modules';
import type { FullPhysics, PatchValues } from '@/lib/wizard/physics';
import { Hint } from './ui';

function V({ label, value, onChange, placeholder, w = 'w-32' }: { label: string; value: string | undefined; onChange: (v: string) => void; placeholder?: string; w?: string }) {
  return (
    <div className={w}>
      <Label className="text-[10px]">{label}</Label>
      <Input value={value ?? ''} placeholder={placeholder} onChange={e => onChange(e.target.value)} className="font-mono text-xs h-7 mt-0.5" />
    </div>
  );
}

/** The inputs a patch's role asks for, in this module. */
function PatchValueInputs({ patch, kind, phys, value, onChange }: {
  patch: MeshPatch; kind: PhysicsKind; phys: FullPhysics; value: PatchValues; onChange: (v: PatchValues) => void;
}) {
  const set = (u: Partial<PatchValues>) => onChange({ ...value, ...u });
  const thermal = ['thermal', 'multicomponent', 'compressibleVof', 'shock'].includes(kind);
  const twoPhase = ['vof', 'compressibleVof', 'driftFlux'].includes(kind);
  const r = patch.role;
  const out: React.ReactNode[] = [];
  if (r === 'inlet') {
    out.push(<V key="U" label="Velocity [m/s]" value={value.U} placeholder={phys.inletVelocity} onChange={v => set({ U: v })} />);
    if (thermal) out.push(<V key="T" label="Temperature [K]" value={value.T} placeholder={phys.T} onChange={v => set({ T: v })} w="w-24" />);
    if (twoPhase) out.push(<V key="a" label={`alpha.${phys.phases[0].name}`} value={value.alpha} placeholder={kind === 'driftFlux' ? 'as inside' : '1'} onChange={v => set({ alpha: v })} w="w-24" />);
    if (kind === 'multicomponent') {
      for (const s of phys.species) {
        out.push(<V key={s.name} label={`Y ${s.name}`} value={value.Y?.[s.name]} placeholder={s.initial} w="w-20"
          onChange={v => set({ Y: { ...(value.Y ?? {}), [s.name]: v } })} />);
      }
    }
  }
  if (r === 'outlet' || r === 'pressureInlet' || r === 'atmosphere' || r === 'freestream') {
    out.push(<V key="p" label={r === 'outlet' ? 'Static pressure' : 'Total pressure'} value={value.p}
      placeholder={kind === 'incompressible' ? '0 (kinematic)' : ['vof', 'driftFlux'].includes(kind) ? '0 (p_rgh)' : phys.p} onChange={v => set({ p: v })} />);
    if (r === 'freestream') out.push(<V key="U" label="Free-stream velocity" value={value.U} placeholder={phys.inletVelocity} onChange={v => set({ U: v })} />);
    if (thermal) out.push(<V key="T" label="Backflow T [K]" value={value.T} placeholder={phys.T} onChange={v => set({ T: v })} w="w-24" />);
  }
  if (r === 'movingWall') out.push(<V key="U" label="Wall velocity [m/s]" value={value.U} placeholder="(1 0 0)" onChange={v => set({ U: v })} />);
  if ((r === 'wall' || r === 'movingWall') && (kind === 'thermal' || kind === 'multicomponent')) {
    out.push(
      <div key="th" className="w-40">
        <Label className="text-[10px]">Heat at the wall</Label>
        <Select value={value.thermal ?? 'adiabatic'} onValueChange={v => set({ thermal: v as PatchValues['thermal'] })}>
          <SelectTrigger className="h-7 text-xs mt-0.5"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="adiabatic" className="text-xs">Insulated</SelectItem>
            <SelectItem value="fixed" className="text-xs">Fixed temperature</SelectItem>
            <SelectItem value="flux" className="text-xs">Heat flux</SelectItem>
            <SelectItem value="coefficient" className="text-xs">Convection (h, Ta)</SelectItem>
          </SelectContent>
        </Select>
      </div>,
    );
    if (value.thermal === 'fixed') out.push(<V key="T" label="T [K]" value={value.T} placeholder={phys.T} onChange={v => set({ T: v })} w="w-24" />);
    if (value.thermal === 'flux') out.push(<V key="q" label="q [W/m²]" value={value.q} placeholder="0" onChange={v => set({ q: v })} w="w-24" />);
    if (value.thermal === 'coefficient') {
      out.push(<V key="h" label="h [W/(m² K)]" value={value.h} placeholder="10" onChange={v => set({ h: v })} w="w-24" />);
      out.push(<V key="Ta" label="Ta [K]" value={value.Ta} placeholder={phys.T} onChange={v => set({ Ta: v })} w="w-24" />);
    }
  }
  if (r === 'fixedTemperature') out.push(<V key="T" label="T [K]" value={value.T} placeholder={phys.T} onChange={v => set({ T: v })} w="w-24" />);
  if (r === 'heatFlux') out.push(<V key="q" label="q [W/m²]" value={value.q} placeholder="0" onChange={v => set({ q: v })} w="w-24" />);
  if (r === 'convection') {
    out.push(<V key="h" label="h [W/(m² K)]" value={value.h} placeholder="10" onChange={v => set({ h: v })} w="w-24" />);
    out.push(<V key="Ta" label="Ta [K]" value={value.Ta} placeholder={phys.T} onChange={v => set({ Ta: v })} w="w-24" />);
  }
  if (r === 'traction') {
    out.push(<V key="t" label="Traction [Pa]" value={value.traction} placeholder="(0 0 0)" onChange={v => set({ traction: v })} />);
    out.push(<V key="pr" label="Pressure [Pa]" value={value.pressure} placeholder="0" onChange={v => set({ pressure: v })} w="w-24" />);
  }
  if (!out.length) return <span className="text-[11px] text-muted-foreground">nothing to set</span>;
  return <div className="flex flex-wrap gap-2 items-end">{out}</div>;
}

export default function FieldsStep(p: {
  fields: FieldConfig[];
  setFields: (u: (f: FieldConfig[]) => FieldConfig[]) => void;
  patches: MeshPatch[];
  bcTypes: string[];
  bcNote: string;
  active: number;
  setActive: (i: number) => void;
  onApply: () => void;
  onAddField: () => void;
  onPreview: (f: FieldConfig) => void;
  /** Complete guide: the patch-values panel. */
  full?: { kind: PhysicsKind; phys: FullPhysics; setPatchValues: (name: string, v: PatchValues) => void; seeded: boolean };
  staleNote?: React.ReactNode;
}) {
  const f = p.fields[Math.min(p.active, Math.max(0, p.fields.length - 1))];
  const idx = p.fields.indexOf(f);
  const update = (u: Partial<FieldConfig>) => p.setFields(prev => prev.map((x, j) => (j === idx ? { ...x, ...u } : x)));
  const updateBC = (bi: number, u: Partial<FieldConfig['boundaryConditions'][number]>) =>
    update({ boundaryConditions: f.boundaryConditions.map((bc, j) => (j === bi ? { ...bc, ...u } : bc)) });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Wind className="w-5 h-5" /> Initial fields (0/)</CardTitle>
        <CardDescription>One condition per mesh patch (or patch group), per field.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {p.full && (
          <div className="rounded-md border p-2 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <Label className="text-sm">Patch values</Label>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={p.onApply}
                title={p.full.seeded ? 'Re-target the tutorial\'s conditions to the patches' : 'Rebuild every field\'s conditions from the physics and the values below'}>
                <RefreshCw className="w-3 h-3 mr-1" /> Apply to the fields
              </Button>
            </div>
            {p.full.seeded ? (
              <Hint>The conditions come from the tutorial, by role: each patch takes the condition the tutorial used on a patch of the same kind.</Hint>
            ) : p.patches.map(patch => (
              <div key={patch.name} className="grid grid-cols-1 md:grid-cols-[12rem_1fr] gap-2 items-center border-t pt-2 first:border-t-0 first:pt-0">
                <div className="text-xs">
                  <span className="font-mono">{patch.name}</span>
                  <Badge variant="secondary" className="ml-1 text-[9px]">{ROLE_INFO[patch.role]?.label ?? patch.role}</Badge>
                </div>
                <PatchValueInputs patch={patch} kind={p.full!.kind} phys={p.full!.phys}
                  value={p.full!.phys.patchValues[patch.name] ?? {}} onChange={v => p.full!.setPatchValues(patch.name, v)} />
              </div>
            ))}
          </div>
        )}

        {p.staleNote}

        <div className="flex items-center gap-2 flex-wrap">
          <Label className="font-semibold text-sm">Field:</Label>
          <Select value={String(idx)} onValueChange={v => p.setActive(Number(v))}>
            <SelectTrigger className="w-56 font-mono text-sm"><SelectValue placeholder="Select field" /></SelectTrigger>
            <SelectContent>
              {p.fields.map((x, i) => (
                <SelectItem key={i} value={String(i)} className="font-mono text-xs">
                  {x.fieldName || '(unnamed)'}{x.orig ? '.orig' : ''}
                  <span className="text-muted-foreground ml-2">({x.boundaryConditions.length} BC)</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Badge variant="secondary" className="text-xs">{p.fields.length} fields</Badge>
          <div className="ml-auto flex gap-1">
            {!p.full && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={p.onApply} title="Rebuild the generated fields from the Physics step">
                <RefreshCw className="w-3 h-3 mr-1" /> Apply physics
              </Button>
            )}
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={p.onAddField}><Plus className="w-3 h-3 mr-1" /> Add field</Button>
            {f && (
              <Button size="sm" variant="outline" className="h-7 text-xs text-red-500 hover:text-red-700"
                onClick={() => { p.setFields(prev => prev.filter((_, j) => j !== idx)); p.setActive(Math.max(0, idx - 1)); }}>
                <Trash2 className="w-3 h-3 mr-1" /> Delete
              </Button>
            )}
          </div>
        </div>

        {!f ? (
          <div className="text-center py-12 text-muted-foreground"><Wind className="w-10 h-10 mx-auto mb-2 opacity-30" /><p className="text-sm">No fields.</p></div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_1.5fr_1.5fr] gap-2">
              <div>
                <Label className="text-xs">Field name</Label>
                <Input value={f.fieldName} onChange={e => update({ fieldName: e.target.value })} className="font-mono text-sm h-8 mt-0.5" />
              </div>
              <div>
                <Label className="text-xs">Dimensions</Label>
                <Input value={f.dimensions} onChange={e => update({ dimensions: e.target.value })} className="font-mono text-xs h-8 mt-0.5" />
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Internal value</Label>
                  <Button size="sm" variant="ghost" className="h-5 text-[10px] px-1" onClick={() => p.onPreview(f)}><Eye className="w-3 h-3 mr-0.5" /> File preview</Button>
                </div>
                {f.internalField.trim().startsWith('{')
                  ? <pre className="text-[10px] font-mono bg-muted/30 rounded p-1 mt-0.5 max-h-20 overflow-auto">{f.internalField}</pre>
                  : <Input value={f.internalField} onChange={e => update({ internalField: e.target.value })} className="font-mono text-xs h-8 mt-0.5" />}
              </div>
            </div>
            {f.orig && <Hint>Written as 0/{f.fieldName}.orig: setFields fills its initial regions into 0/{f.fieldName} after the mesh is built.</Hint>}

            <Separator />

            <div>
              <div className="flex items-center justify-between mb-2">
                <Label className="text-sm font-medium">Boundary conditions ({f.boundaryConditions.length})</Label>
                <Button size="sm" variant="ghost" className="h-6 text-xs"
                  onClick={() => update({ boundaryConditions: [...f.boundaryConditions, { name: '', type: 'fixedValue', value: '' }] })}>
                  <Plus className="w-3 h-3 mr-1" /> Add BC
                </Button>
              </div>
              <ScrollArea className="max-h-[360px]">
                <div className="space-y-2">
                  {f.boundaryConditions.map((bc, bi) => {
                    const known = p.patches.some(x => x.name === bc.name.trim());
                    return (
                      <div key={bi} className="bg-muted/30 p-2 rounded-lg space-y-1">
                        <div className="grid grid-cols-[1fr_1.3fr_1fr_auto] gap-1.5 items-center">
                          <Input value={bc.name} onChange={e => updateBC(bi, { name: e.target.value })} placeholder="patch"
                            className={`h-7 text-xs font-mono ${known ? '' : 'border-amber-400'}`} title={known ? '' : 'This patch is not in the mesh'} />
                          <Select value={bc.type} onValueChange={v => updateBC(bi, { type: v })}>
                            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent className="max-h-72">
                              {[...new Set([bc.type, ...p.bcTypes])].map(t => <SelectItem key={t} value={t} className="text-xs font-mono">{t}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          <Input value={bc.value} onChange={e => updateBC(bi, { value: e.target.value })} placeholder="value" className="h-7 text-xs font-mono" />
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-400" aria-label={`Remove the condition on ${bc.name || 'this patch'}`}
                            onClick={() => update({ boundaryConditions: f.boundaryConditions.filter((_, j) => j !== bi) })}>
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                        <Input value={(bc.extra ?? '').replace(/\n/g, ' ⏎ ')} placeholder="other entries, e.g. inletValue uniform 0"
                          onChange={e => updateBC(bi, { extra: e.target.value.replace(/\s*⏎\s*/g, '\n') })}
                          className="h-6 text-[11px] font-mono" aria-label={`Other entries of ${bc.name}`} />
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
              <p className="text-[11px] text-muted-foreground mt-1.5">
                Patches: {p.patches.map(x => `${x.name} (${ROLE_INFO[x.role]?.label ?? x.role})`).join(' · ')}
              </p>
              <p className="text-[11px] text-muted-foreground">{p.bcNote}</p>
              {f.boundaryConditions.some(bc => !p.patches.some(x => x.name === bc.name.trim())) && (
                <p className="text-[11px] text-amber-600 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> A condition names a patch the mesh does not have.</p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

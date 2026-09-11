'use client';

/**
 * The box's patches: which face is which, and what each patch does.
 *
 * Every face belongs to exactly one patch, so clicking a face on a patch takes
 * it from whichever patch had it. The role decides the boundary conditions the
 * fields get (see src/lib/wizard/roles.ts); the type follows the role unless
 * changed. In 2D the z faces are always the empty frontAndBack patch.
 */

import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Trash2 } from 'lucide-react';
import {
  BOX_FACES, defaultBoxPatches, typeForRole,
  type BoxFace, type BoxPatch, type MeshSpec, type PatchRole, type PatchType,
} from '@/lib/case-templates';
import { ROLE_INFO } from '@/lib/wizard/roles';
import { Hint } from './ui';

const FACE_LABEL: Record<BoxFace, string> = {
  xMin: '−x', xMax: '+x', yMin: '−y', yMax: '+y', zMin: '−z', zMax: '+z',
};

const TYPES: PatchType[] = ['patch', 'wall', 'symmetryPlane', 'symmetry'];

interface Preset { id: string; label: string; roles: PatchRole[]; patches: (twoD: boolean) => BoxPatch[] }

const side = (twoD: boolean): BoxFace[] => (twoD ? ['yMin', 'yMax'] : ['yMin', 'yMax', 'zMin', 'zMax']);

const PRESETS: Preset[] = [
  { id: 'channel', label: 'Channel', roles: ['inlet', 'outlet', 'wall'], patches: twoD => defaultBoxPatches(twoD) },
  {
    id: 'external', label: 'External flow', roles: ['inlet', 'outlet', 'slipWall'],
    patches: twoD => [
      { name: 'inlet', type: 'patch', role: 'inlet', faces: ['xMin'] },
      { name: 'outlet', type: 'patch', role: 'outlet', faces: ['xMax'] },
      { name: 'sides', type: 'wall', role: 'slipWall', faces: side(twoD) },
    ],
  },
  {
    id: 'cavity', label: 'Lid-driven cavity', roles: ['movingWall', 'wall'],
    patches: twoD => [
      { name: 'movingWall', type: 'wall', role: 'movingWall', faces: ['yMax'] },
      { name: 'fixedWalls', type: 'wall', role: 'wall', faces: ['xMin', 'xMax', 'yMin', ...(twoD ? [] : ['zMin', 'zMax'] as BoxFace[])] },
    ],
  },
  {
    id: 'tank', label: 'Open-top tank', roles: ['atmosphere', 'wall'],
    patches: twoD => [
      { name: 'atmosphere', type: 'patch', role: 'atmosphere', faces: ['yMax'] },
      { name: 'walls', type: 'wall', role: 'wall', faces: ['xMin', 'xMax', 'yMin', ...(twoD ? [] : ['zMin', 'zMax'] as BoxFace[])] },
    ],
  },
  {
    id: 'closed', label: 'Closed box', roles: ['wall'],
    patches: twoD => [{ name: 'walls', type: 'wall', role: 'wall', faces: BOX_FACES.filter(f => !twoD || (f !== 'zMin' && f !== 'zMax')) }],
  },
  {
    id: 'hotCold', label: 'Hot / cold sides', roles: ['fixedTemperature', 'adiabatic'],
    patches: twoD => [
      { name: 'hot', type: 'wall', role: 'fixedTemperature', faces: ['xMin'] },
      { name: 'cold', type: 'wall', role: 'fixedTemperature', faces: ['xMax'] },
      { name: 'insulated', type: 'wall', role: 'adiabatic', faces: side(twoD) },
    ],
  },
  {
    id: 'clamped', label: 'Clamped and loaded', roles: ['fixedSupport', 'traction', 'tractionFree'],
    patches: twoD => [
      { name: 'fixed', type: 'wall', role: 'fixedSupport', faces: ['xMin'] },
      { name: 'load', type: 'patch', role: 'traction', faces: ['xMax'] },
      { name: 'free', type: 'patch', role: 'tractionFree', faces: side(twoD) },
    ],
  },
];

export default function BoxPatchEditor({ mesh, setMesh, roles }: {
  mesh: MeshSpec;
  setMesh: (update: (m: MeshSpec) => MeshSpec) => void;
  roles: PatchRole[];
}) {
  const patches = mesh.patches ?? defaultBoxPatches(mesh.twoD);
  const faces = mesh.twoD ? BOX_FACES.filter(f => f !== 'zMin' && f !== 'zMax') : BOX_FACES;
  const presets = PRESETS.filter(p => p.roles.every(r => roles.includes(r)));

  const set = (next: BoxPatch[]) => setMesh(m => ({ ...m, patches: next }));
  const update = (i: number, u: Partial<BoxPatch>) => set(patches.map((p, j) => (j === i ? { ...p, ...u } : p)));

  const toggleFace = (i: number, f: BoxFace) => {
    const has = patches[i].faces.includes(f);
    set(patches.map((p, j) => {
      if (j === i) return { ...p, faces: has ? p.faces.filter(x => x !== f) : [...p.faces, f] };
      return has ? p : { ...p, faces: p.faces.filter(x => x !== f) };
    }));
  };

  const addPatch = () => {
    const role = roles.includes('wall') ? 'wall' : roles[0];
    let n = patches.length + 1;
    while (patches.some(p => p.name === `patch${n}`)) n++;
    set([...patches, { name: `patch${n}`, type: typeForRole(role), role, faces: [] }]);
  };

  const unassigned = faces.filter(f => !patches.some(p => p.faces.includes(f)));

  return (
    <div className="space-y-2">
      {presets.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-muted-foreground">Start from:</span>
          {presets.map(p => (
            <Button key={p.id} size="sm" variant="outline" className="h-7 text-xs" onClick={() => set(p.patches(mesh.twoD))}>{p.label}</Button>
          ))}
        </div>
      )}

      {patches.map((p, i) => (
        <div key={i} className="grid grid-cols-1 lg:grid-cols-[1fr_1.3fr_1fr_auto_auto] gap-1.5 items-center rounded-md bg-muted/30 p-2">
          <Input value={p.name} onChange={e => update(i, { name: e.target.value.replace(/\s/g, '') })}
            className="h-7 text-xs font-mono" aria-label="Patch name" />
          <Select value={p.role} onValueChange={v => update(i, { role: v as PatchRole, type: typeForRole(v as PatchRole) })}>
            <SelectTrigger className="h-7 text-xs" aria-label="Role"><SelectValue /></SelectTrigger>
            <SelectContent>
              {roles.map(r => <SelectItem key={r} value={r} className="text-xs">{ROLE_INFO[r].label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={p.type} onValueChange={v => update(i, { type: v as PatchType })}>
            <SelectTrigger className="h-7 text-xs font-mono" aria-label="Patch type"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TYPES.map(t => <SelectItem key={t} value={t} className="text-xs font-mono">{t}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex gap-0.5" role="group" aria-label={`Faces of ${p.name}`}>
            {faces.map(f => (
              <button key={f} type="button" onClick={() => toggleFace(i, f)} aria-pressed={p.faces.includes(f)}
                className={`w-8 h-7 rounded border font-mono text-[11px] ${p.faces.includes(f) ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:border-primary/50'}`}>
                {FACE_LABEL[f]}
              </button>
            ))}
          </div>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-500" onClick={() => set(patches.filter((_, j) => j !== i))}
            aria-label={`Remove patch ${p.name}`} title="Remove this patch">
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      ))}

      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={addPatch}><Plus className="w-3 h-3 mr-1" /> Add patch</Button>
        {unassigned.length > 0 && <span className="text-xs text-amber-600">Faces in no patch: {unassigned.map(f => FACE_LABEL[f]).join(' ')}</span>}
      </div>
      <Hint>
        {ROLE_INFO[patches[0]?.role ?? 'wall']?.hint}. {mesh.twoD ? 'In 2D the ±z faces are the empty frontAndBack patch.' : ''}
      </Hint>
    </div>
  );
}

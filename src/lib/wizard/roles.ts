/**
 * What a patch can do, in the words the wizard shows, and which roles make
 * sense for which kind of case. The boundary conditions each role produces are
 * decided per module (./boundary.ts); this is only the vocabulary.
 */

import type { PatchRole, PatchType } from '../case-templates';

export type RoleFamily = 'flow' | 'solidThermal' | 'solidMechanics';

export interface RoleInfo {
  label: string;
  hint: string;
  /** The patch type a patch with this role gets by default. */
  type: PatchType;
  families: RoleFamily[];
}

export const ROLE_INFO: Record<PatchRole, RoleInfo> = {
  inlet: { label: 'Velocity inlet', hint: 'Flow enters with a fixed velocity (and temperature, composition, turbulence)', type: 'patch', families: ['flow'] },
  pressureInlet: { label: 'Pressure inlet', hint: 'Flow enters from a fixed total pressure; the velocity follows', type: 'patch', families: ['flow'] },
  outlet: { label: 'Pressure outlet', hint: 'Fixed static pressure; whatever arrives leaves', type: 'patch', families: ['flow'] },
  wall: { label: 'Wall', hint: 'No-slip wall', type: 'wall', families: ['flow'] },
  slipWall: { label: 'Slip wall', hint: 'Frictionless wall: no flow through it, none along it held back', type: 'wall', families: ['flow'] },
  movingWall: { label: 'Moving wall', hint: 'A wall sliding in its own plane, like a lid', type: 'wall', families: ['flow'] },
  atmosphere: { label: 'Open atmosphere', hint: 'Flow in or out at ambient pressure, like the open top of a tank', type: 'patch', families: ['flow'] },
  freestream: { label: 'Far field', hint: 'The undisturbed stream around a body', type: 'patch', families: ['flow'] },
  symmetry: { label: 'Symmetry', hint: 'A mirror: nothing crosses it (symmetryPlane only for a single flat face)', type: 'symmetry', families: ['flow', 'solidThermal', 'solidMechanics'] },
  empty: { label: 'Empty (2D)', hint: 'The front and back of a 2D case', type: 'empty', families: ['flow', 'solidThermal', 'solidMechanics'] },
  fixedTemperature: { label: 'Fixed temperature', hint: 'The surface is held at a temperature', type: 'wall', families: ['solidThermal', 'solidMechanics'] },
  heatFlux: { label: 'Heat flux', hint: 'A heat flux enters (positive) or leaves through the surface', type: 'wall', families: ['solidThermal'] },
  adiabatic: { label: 'Insulated', hint: 'No heat crosses the surface', type: 'wall', families: ['solidThermal', 'solidMechanics'] },
  convection: { label: 'Convection', hint: 'Heat exchanged with surroundings at a temperature, through a coefficient h', type: 'wall', families: ['solidThermal'] },
  fixedSupport: { label: 'Fixed support', hint: 'The surface cannot move', type: 'wall', families: ['solidMechanics'] },
  traction: { label: 'Load', hint: 'A traction vector and/or a pressure acts on the surface', type: 'patch', families: ['solidMechanics'] },
  tractionFree: { label: 'Free surface', hint: 'Nothing acts on the surface', type: 'patch', families: ['solidMechanics'] },
};

export const ALL_ROLES = Object.keys(ROLE_INFO) as PatchRole[];

/** The roles a case of this family may give a patch (empty comes from 2D, not from a choice). */
export function rolesFor(family: RoleFamily): PatchRole[] {
  return ALL_ROLES.filter(r => r !== 'empty' && ROLE_INFO[r].families.includes(family));
}

/** A readable role name, also for a role this build does not know. */
export function roleLabel(role: string): string {
  return ROLE_INFO[role as PatchRole]?.label ?? role;
}

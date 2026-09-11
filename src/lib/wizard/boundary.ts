/**
 * The boundary condition every field gets on every patch, for a
 * complete-guide case: decided by the patch's role (inlet, wall, open
 * atmosphere…), the module's physics, and the values the user gave the patch.
 *
 * The table is the installation survey's (docs/agent-log/module-spec.md A.0.3
 * and the module sections), written in the forms both 13 and 14 accept: an
 * explicit `value` on every derived condition (13 stops without it on
 * inletOutlet and pressureInletOutletVelocity), and the constraint types a
 * constraint patch imposes.
 */

import { constraintType, type BoundaryCondition, type FieldConfig, type MeshPatch } from '../case-templates';
import type { PhysicsKind } from './modules';
import {
  TURBULENCE_FIELDS, alphaField, fullDimensions, hasPrgh,
  type FullPhysics, type TurbulenceValues,
} from './physics';

export interface BcContext {
  kind: PhysicsKind;
  phys: FullPhysics;
  turb: TurbulenceValues;
}

const INFLOW = new Set(['inlet']);
const OUTFLOW = new Set(['outlet', 'pressureInlet', 'atmosphere', 'freestream']);
const WALLS = new Set(['wall', 'movingWall']);

function fmt(v: number): string {
  return String(Number(v.toPrecision(4)));
}

/** The uniform starting value of a field. */
export function internalValue(name: string, ctx: BcContext): string {
  const { phys: p, kind, turb } = ctx;
  if (name === 'U' || name === 'D') return 'uniform (0 0 0)';
  if (name === 'p') return kind === 'incompressible' ? 'uniform 0' : `uniform ${p.p}`;
  if (name === 'p_rgh') return kind === 'compressibleVof' ? `uniform ${p.p}` : 'uniform 0';
  if (name === 'T') return `uniform ${p.T}`;
  if (name === 'Ydefault') return 'uniform 0';
  if (name.startsWith('alpha.')) return kind === 'driftFlux' ? 'uniform 0.001' : 'uniform 0';
  const specie = p.species.find(s => s.name === name);
  if (specie) return `uniform ${specie.initial}`;
  switch (name) {
    case 'k': return `uniform ${fmt(turb.k)}`;
    case 'epsilon': return `uniform ${fmt(turb.epsilon)}`;
    case 'omega': return `uniform ${fmt(turb.omega)}`;
    case 'nuTilda': return `uniform ${fmt(turb.nuTilda)}`;
    case 'v2': return `uniform ${fmt(turb.k * 2 / 3)}`;
    default: return 'uniform 0';
  }
}

/** The condition `name` gets on `patch`. */
export function bcFor(name: string, patch: MeshPatch, ctx: BcContext): BoundaryCondition {
  const { phys: p, kind } = ctx;
  const pv = p.patchValues[patch.name] ?? {};
  const at = (type: string, value = '', extra = ''): BoundaryCondition =>
    (extra ? { name: patch.name, type, value, extra } : { name: patch.name, type, value });

  const constraint = constraintType(patch.type) ?? (patch.role === 'empty' ? 'empty' : patch.role === 'symmetry' ? 'symmetry' : null);
  if (constraint) return at(constraint);

  const role = patch.role;
  const inflow = INFLOW.has(role);
  const outflow = OUTFLOW.has(role);
  const wall = WALLS.has(role);
  const internal = internalValue(name, ctx);
  const prgh = hasPrgh(kind, p);

  // ── Solid mechanics ──
  if (name === 'D') {
    if (role === 'fixedSupport') return at('fixedValue', 'uniform (0 0 0)');
    const traction = role === 'traction' ? (pv.traction || '(0 0 0)') : '(0 0 0)';
    const pressure = role === 'traction' ? (pv.pressure || '0') : '0';
    return at('tractionDisplacement', 'uniform (0 0 0)', `traction uniform ${traction}\npressure uniform ${pressure}`);
  }

  // ── Temperature ──
  if (name === 'T') {
    const T0 = pv.T || p.T;
    if (kind === 'isothermal') return at('calculated', `uniform ${p.T}`);
    if (kind === 'solidThermal' || kind === 'solidMechanics') {
      switch (role) {
        case 'fixedTemperature': return at('fixedValue', `uniform ${T0}`);
        case 'heatFlux': return at('externalTemperature', '$internalField', `q uniform ${pv.q || '0'}`);
        case 'convection': return at('externalTemperature', '$internalField', `h uniform ${pv.h || '10'}\nTa constant ${pv.Ta || p.T}`);
        default: return at('zeroGradient');
      }
    }
    if (inflow) return at('fixedValue', `uniform ${T0}`);
    if (outflow) return at('inletOutlet', `uniform ${T0}`, `inletValue uniform ${T0}`);
    if (wall) {
      switch (pv.thermal) {
        case 'fixed': return at('fixedValue', `uniform ${T0}`);
        case 'flux': return at('externalTemperature', '$internalField', `q uniform ${pv.q || '0'}`);
        case 'coefficient': return at('externalTemperature', '$internalField', `h uniform ${pv.h || '10'}\nTa constant ${pv.Ta || p.T}`);
        default: return at('zeroGradient');
      }
    }
    return at('zeroGradient');
  }

  // ── Velocity ──
  if (name === 'U') {
    const Uin = pv.U || p.inletVelocity;
    switch (role) {
      case 'inlet': return at('fixedValue', `uniform ${Uin}`);
      case 'outlet':
        return kind === 'incompressible' ? at('zeroGradient') : at('pressureInletOutletVelocity', 'uniform (0 0 0)');
      case 'pressureInlet': case 'atmosphere': return at('pressureInletOutletVelocity', 'uniform (0 0 0)');
      case 'freestream': return at('freestreamVelocity', `uniform ${Uin}`, `freestreamValue uniform ${Uin}`);
      case 'movingWall': return at('movingWallVelocity', `uniform ${pv.U || '(1 0 0)'}`);
      case 'slipWall': return at('slip');
      default: return at('noSlip');
    }
  }

  // ── Pressure ──
  if (name === 'p' && prgh) return at('calculated', '$internalField');
  if (name === 'p') {
    const level = pv.p || (kind === 'incompressible' ? '0' : p.p);
    switch (role) {
      case 'outlet': return at('fixedValue', `uniform ${level}`);
      case 'pressureInlet': case 'atmosphere': return at('totalPressure', `uniform ${level}`, `p0 uniform ${level}`);
      case 'freestream': return at('freestreamPressure', `uniform ${level}`, `freestreamValue uniform ${level}`);
      default: return at('zeroGradient');
    }
  }
  if (name === 'p_rgh') {
    switch (role) {
      case 'outlet': case 'freestream': return at('fixedValue', pv.p ? `uniform ${pv.p}` : internal);
      case 'pressureInlet': case 'atmosphere': return at('prghTotalPressure', '$internalField', `p0 ${pv.p ? `uniform ${pv.p}` : '$internalField'}`);
      default: return at('fixedFluxPressure', '$internalField');
    }
  }

  // ── Volume fraction and species ──
  if (name.startsWith('alpha.') && name === alphaField(p)) {
    if (inflow) return at('fixedValue', pv.alpha ? `uniform ${pv.alpha}` : kind === 'driftFlux' ? '$internalField' : 'uniform 1');
    if (outflow) return at('inletOutlet', '$internalField', 'inletValue uniform 0');
    return at('zeroGradient');
  }
  const specie = p.species.find(s => s.name === name);
  if (specie || name === 'Ydefault') {
    const initial = specie ? specie.initial : '0';
    const inletY = specie ? (pv.Y?.[name] ?? initial) : '0';
    if (inflow) return at('fixedValue', `uniform ${inletY}`);
    if (outflow) return at('inletOutlet', `uniform ${initial}`, `inletValue uniform ${initial}`);
    return at('zeroGradient');
  }

  // ── Turbulence ──
  const les = p.simulationType === 'LES';
  const sa = p.model.startsWith('SpalartAllmaras');
  if (['k', 'epsilon', 'omega', 'nuTilda', 'v2'].includes(name)) {
    if (inflow) return at('fixedValue', internal);
    if (outflow) return at('inletOutlet', internal, `inletValue ${internal}`);
    if (role === 'slipWall') return at('zeroGradient');
    switch (name) {
      case 'k': return les ? at('fixedValue', 'uniform 0') : at('kqRWallFunction', internal);
      case 'epsilon': return at('epsilonWallFunction', internal);
      case 'omega': return at('omegaWallFunction', internal);
      case 'nuTilda': return at('fixedValue', 'uniform 0');
      default: return at('v2WallFunction', internal);
    }
  }
  if (name === 'f') return wall ? at('fWallFunction', 'uniform 0') : at('zeroGradient');
  if (name === 'nut') {
    if (!wall) return role === 'slipWall' ? at('zeroGradient') : at('calculated', 'uniform 0');
    if (sa) return at('nutUSpaldingWallFunction', 'uniform 0');
    if (les && !p.model.endsWith('DES')) return at('zeroGradient');
    return at('nutkWallFunction', 'uniform 0');
  }
  if (name === 'alphat') {
    if (!wall) return role === 'slipWall' || les ? at('zeroGradient') : at('calculated', 'uniform 0');
    return les ? at('zeroGradient') : at('compressible::alphatWallFunction', 'uniform 0', 'Prt 0.85');
  }

  return inflow ? at('fixedValue', internal) : at('zeroGradient');
}

/** A complete field for the wizard's Fields step. */
export function buildFullField(name: string, patches: MeshPatch[], ctx: BcContext): FieldConfig {
  const vector = name === 'U' || name === 'D';
  return {
    fieldName: name,
    cls: vector ? 'volVectorField' : 'volScalarField',
    dimensions: fullDimensions(name, ctx.kind, ctx.phys),
    internalField: internalValue(name, ctx),
    boundaryConditions: patches.map(p => bcFor(name, p, ctx)),
  };
}

/** Whether the turbulence model named needs this field (for the stale-field note). */
export function isTurbulenceField(name: string): boolean {
  return Object.values(TURBULENCE_FIELDS).some(list => list.includes(name)) || name === 'nut' || name === 'alphat';
}

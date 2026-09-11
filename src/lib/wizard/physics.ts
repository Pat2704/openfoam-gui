/**
 * The physics of a complete-guide case (OpenFOAM 13 and 14): what the Physics
 * step asks, the defaults for each solver module, and which 0/ fields follow.
 *
 * The values and structures come from the installation survey
 * (docs/agent-log/module-spec.md): each module's defaults are its simplest
 * tutorial's (pitzDailySteady, hotRoom, damBreakLaminar, dahl, lockExchange,
 * forwardStep, coolingCylinder2D, plateHole). Every choice list the UI offers
 * is intersected with the installation's own foamToC tables.
 */

import { estimateTurbulence } from '../case-templates';
import type { Vec3 } from '../geometry';
import type { ThermoCombo } from './thermo';
import type { SeedFile } from './seed';
import type { ModuleInfo, PhysicsKind } from './modules';

export type SimulationType = 'laminar' | 'RAS' | 'LES';

/** A fluid's (or phase's, or specie's) thermophysical properties. */
export interface ThermoProps {
  combo: ThermoCombo;
  /** molWeight, Cp, Cv, hf, mu, Pr, As, Ts, rho, rho0, T0, beta, kappa — as the combo needs. */
  coeffs: Record<string, string>;
  /** For `properties liquid`: the liquidProperties name (H2O…). */
  liquid: string;
}

/**
 * The keys each thermoType component reads (survey A.0.4: aggregated over every
 * tutorial physicalProperties file). A component outside this table has keys
 * the survey could not determine; the wizard does not offer it.
 */
export const COMPONENT_KEYS: Record<string, Record<string, string[]>> = {
  transport: { const: ['mu', 'Pr'], sutherland: ['As', 'Ts'], constIsoSolid: ['kappa'] },
  thermo: { hConst: ['Cp', 'hf'], eConst: ['Cv', 'hf'] },
  equationOfState: { perfectGas: [], rhoConst: ['rho'], Boussinesq: ['rho0', 'T0', 'beta'] },
};

export const COEFF_INFO: Record<string, { label: string; unit: string }> = {
  molWeight: { label: 'Molar mass', unit: 'kg/kmol' },
  Cp: { label: 'Cp', unit: 'J/(kg K)' },
  Cv: { label: 'Cv', unit: 'J/(kg K)' },
  hf: { label: 'Heat of formation hf', unit: 'J/kg' },
  mu: { label: 'Dynamic viscosity μ', unit: 'Pa s' },
  Pr: { label: 'Prandtl number', unit: '' },
  As: { label: 'Sutherland As', unit: 'Pa s/K^½' },
  Ts: { label: 'Sutherland Ts', unit: 'K' },
  rho: { label: 'Density ρ', unit: 'kg/m³' },
  rho0: { label: 'Reference density ρ0', unit: 'kg/m³' },
  T0: { label: 'Reference temperature T0', unit: 'K' },
  beta: { label: 'Expansion coefficient β', unit: '1/K' },
  kappa: { label: 'Conductivity κ', unit: 'W/(m K)' },
};

/** Whether the wizard knows every key of this combination's components. */
export function comboSupported(c: ThermoCombo): boolean {
  if (c.properties) return c.properties === 'liquid';
  return c.specie === 'specie'
    && c.transport in COMPONENT_KEYS.transport
    && c.thermo in COMPONENT_KEYS.thermo
    && c.equationOfState in COMPONENT_KEYS.equationOfState;
}

/** The coefficients this combination reads, in the order the dictionary writes them. */
export function thermoKeys(c: ThermoCombo): { specie: string[]; equationOfState: string[]; thermodynamics: string[]; transport: string[] } {
  if (c.properties) return { specie: [], equationOfState: [], thermodynamics: [], transport: [] };
  return {
    specie: ['molWeight'],
    equationOfState: COMPONENT_KEYS.equationOfState[c.equationOfState] ?? [],
    thermodynamics: COMPONENT_KEYS.thermo[c.thermo] ?? [],
    transport: COMPONENT_KEYS.transport[c.transport] ?? [],
  };
}

const combo = (type: string, mixture: string, transport: string, thermo: string, equationOfState: string, energy: string): ThermoCombo =>
  ({ type, mixture, transport, thermo, equationOfState, specie: 'specie', energy });

/** Named starting points; the UI checks each against the installation's table. */
export const THERMO_PRESETS: { id: string; label: string; props: ThermoProps }[] = [
  {
    id: 'air', label: 'Air (ideal gas)',
    props: { combo: combo('heRhoThermo', 'pureMixture', 'const', 'hConst', 'perfectGas', 'sensibleEnthalpy'), liquid: '',
      coeffs: { molWeight: '28.9', Cp: '1007', hf: '0', mu: '1.84e-05', Pr: '0.7' } },
  },
  {
    id: 'airPsi', label: 'Air (ideal gas, ψ-based)',
    props: { combo: combo('hePsiThermo', 'pureMixture', 'const', 'hConst', 'perfectGas', 'sensibleInternalEnergy'), liquid: '',
      coeffs: { molWeight: '28.96', Cp: '1004.5', hf: '0', mu: '1.8e-05', Pr: '0.7' } },
  },
  {
    id: 'airSutherland', label: 'Air (Sutherland viscosity)',
    props: { combo: combo('heRhoThermo', 'pureMixture', 'sutherland', 'hConst', 'perfectGas', 'sensibleEnthalpy'), liquid: '',
      coeffs: { molWeight: '28.9', Cp: '1007', hf: '0', As: '1.4792e-06', Ts: '116' } },
  },
  {
    id: 'water', label: 'Water (constant density)',
    props: { combo: combo('heRhoThermo', 'pureMixture', 'const', 'eConst', 'rhoConst', 'sensibleInternalEnergy'), liquid: '',
      coeffs: { molWeight: '18', rho: '1000', Cv: '4184', hf: '0', mu: '1e-03', Pr: '7' } },
  },
  {
    id: 'waterLiquid', label: 'Water (liquidProperties H2O)',
    props: { combo: { type: 'heRhoThermo', mixture: 'pureMixture', transport: '', thermo: '', equationOfState: '', specie: '', energy: 'sensibleInternalEnergy', properties: 'liquid' },
      liquid: 'H2O', coeffs: {} },
  },
];

export function preset(id: string): ThermoProps {
  const p = THERMO_PRESETS.find(x => x.id === id) ?? THERMO_PRESETS[0];
  return structuredClone(p.props);
}

// ── Turbulence ──────────────────────────────────────────────────────────────

/**
 * Models whose fields the wizard knows (survey A.0.5; each ran with exactly
 * these fields on 13 and 14, or is a tutorial's). The UI offers the ones the
 * installation also lists.
 */
export const TURBULENCE_FIELDS: Record<string, string[]> = {
  kEpsilon: ['k', 'epsilon'], RNGkEpsilon: ['k', 'epsilon'], realizableKE: ['k', 'epsilon'],
  LaunderSharmaKE: ['k', 'epsilon'], LienCubicKE: ['k', 'epsilon'], ShihQuadraticKE: ['k', 'epsilon'],
  buoyantKEpsilon: ['k', 'epsilon'],
  kOmega: ['k', 'omega'], kOmega2006: ['k', 'omega'], kOmegaSST: ['k', 'omega'], kOmegaSSTSAS: ['k', 'omega'],
  SpalartAllmaras: ['nuTilda'], v2f: ['k', 'epsilon', 'v2', 'f'],
  Smagorinsky: [], WALE: [], kEqn: ['k'], dynamicKEqn: ['k'],
  SpalartAllmarasDES: ['nuTilda'], SpalartAllmarasDDES: ['nuTilda'], kOmegaSSTDES: ['k', 'omega'],
};

/** Incompressible RAS table (19) and compressible RAS table (14), survey A.0.5. */
const RAS_INCOMPRESSIBLE = ['kEpsilon', 'RNGkEpsilon', 'realizableKE', 'LaunderSharmaKE', 'LienCubicKE', 'ShihQuadraticKE', 'kOmega', 'kOmega2006', 'kOmegaSST', 'kOmegaSSTSAS', 'SpalartAllmaras', 'v2f'];
const RAS_COMPRESSIBLE = ['kEpsilon', 'RNGkEpsilon', 'realizableKE', 'LaunderSharmaKE', 'buoyantKEpsilon', 'kOmega', 'kOmega2006', 'kOmegaSST', 'kOmegaSSTSAS', 'SpalartAllmaras', 'v2f'];
const LES_MODELS = ['Smagorinsky', 'WALE', 'kEqn', 'dynamicKEqn', 'SpalartAllmarasDES', 'SpalartAllmarasDDES', 'kOmegaSSTDES'];

export function turbulenceChoices(kind: PhysicsKind, installed: { ras: string[]; les: string[] } | null): { ras: string[]; les: string[] } {
  const incompressible = kind === 'incompressible' || kind === 'vof';
  let ras = incompressible ? RAS_INCOMPRESSIBLE : RAS_COMPRESSIBLE;
  if (kind === 'driftFlux') ras = [...RAS_INCOMPRESSIBLE, 'buoyantKEpsilon'];
  const keep = (list: string[], have?: string[]) => (have?.length ? list.filter(m => have.includes(m)) : list);
  return { ras: keep(ras, installed?.ras), les: keep(LES_MODELS, installed?.les) };
}

export const LES_DELTAS = ['cubeRootVol', 'vanDriest', 'Prandtl', 'smooth', 'maxDeltaxyz'];

// ── The settings ────────────────────────────────────────────────────────────

export interface Phase { name: string; nu: string; rho: string; thermo: ThermoProps }
export interface Specie { name: string; coeffs: Record<string, string>; initial: string }

export type RegionShape = 'box' | 'sphere' | 'cylinder';

/** A zone setFields fills with other values than the rest of the domain. */
export interface InitialRegion {
  name: string;
  shape: RegionShape;
  min: Vec3; max: Vec3;
  centre: Vec3; radius: number;
  point1: Vec3; point2: Vec3;
  /** Field name → value, e.g. { 'alpha.water': '1', T: '600' }. */
  values: Record<string, string>;
}

/** What a patch imposes, beyond its role; empty means the module's default. */
export interface PatchValues {
  U?: string;          // inlet velocity, moving-wall velocity
  p?: string;          // outlet / total pressure
  T?: string;          // inlet or wall temperature
  alpha?: string;      // inlet volume fraction of the first phase
  Y?: Record<string, string>;
  /** Fluid walls: how heat crosses them. */
  thermal?: 'adiabatic' | 'fixed' | 'flux' | 'coefficient';
  q?: string;          // heat flux W/m²
  h?: string;          // heat transfer coefficient W/(m² K)
  Ta?: string;         // ambient temperature K
  traction?: string;   // solid load: traction vector Pa
  pressure?: string;   // solid load: pressure Pa
}

export interface FullPhysics {
  simulationType: SimulationType;
  model: string;
  delta: string;
  /** Turbulence intensity [%] and length scale [m] for the inlet estimates. */
  intensity: string;
  lengthScale: string;
  /** Default inlet velocity; a patch's own value wins. */
  inletVelocity: string;
  nu: string;
  fluid: ThermoProps;
  /** Initial/ambient pressure [Pa] and temperature [K] (compressible modules). */
  p: string;
  T: string;
  gravity: string;
  /** Solve p_rgh with gravity (fluid, isothermalFluid, multicomponentFluid). */
  buoyant: boolean;
  /** multicomponentFluid: the mixture's thermoType, the species and the default specie. */
  mixture: ThermoCombo;
  species: Specie[];
  defaultSpecie: string;
  /** Two-phase modules: the first phase is the one whose alpha is solved. */
  phases: [Phase, Phase];
  sigma: string;
  drift: {
    model: 'simple' | 'general';
    Vc: string; a: string; a1: string; residualAlpha: string;
    viscosity: 'plastic' | 'BinghamPlastic';
    coeff: string; exponent: string; muMax: string;
    BinghamCoeff: string; BinghamExponent: string; BinghamOffset: string;
  };
  solid: { rho: string; Cv: string; kappa: string; heatSource: string };
  elastic: { rho: string; E: string; nu: string; Cv: string; kappa: string; alphav: string; planeStress: boolean; thermalStress: boolean };
  initialRegions: InitialRegion[];
  patchValues: Record<string, PatchValues>;
  /** `#includeFunc` lines for system/functions. */
  functions: string[];
  decompose: { enabled: boolean; n: number };
  /** fvConstraints limitPressure (compressible pressure-based modules). */
  limitPressure: boolean;
  time: {
    adjustTimeStep: boolean; maxCo: string; maxAlphaCo: string; maxDeltaT: string;
    writeControl: 'timeStep' | 'runTime' | 'adjustableRunTime';
    purgeWrite: string; writeFormat: 'ascii' | 'binary';
  };
  /** Start from an installation tutorial of the module instead of the forms. */
  seed: { tutorial: string; files: SeedFile[]; overrides: Record<string, string> } | null;
}

export const DEFAULT_PHYSICS: FullPhysics = {
  simulationType: 'laminar', model: 'kOmegaSST', delta: 'cubeRootVol',
  intensity: '5', lengthScale: '',
  inletVelocity: '(1 0 0)',
  nu: '1e-05',
  fluid: preset('air'),
  p: '1e5', T: '300',
  gravity: '(0 -9.81 0)', buoyant: false,
  mixture: combo('heRhoThermo', 'multicomponentMixture', 'const', 'hConst', 'perfectGas', 'sensibleEnthalpy'),
  species: [
    { name: 'air', coeffs: { molWeight: '28.9', Cp: '1007', hf: '0', mu: '1.84e-05', Pr: '0.7' }, initial: '1' },
    { name: 'CO2', coeffs: { molWeight: '44.01', Cp: '846', hf: '0', mu: '1.47e-05', Pr: '0.77' }, initial: '0' },
  ],
  defaultSpecie: 'air',
  phases: [
    { name: 'water', nu: '1e-06', rho: '1000', thermo: preset('waterLiquid') },
    { name: 'air', nu: '1.48e-05', rho: '1', thermo: preset('air') },
  ],
  sigma: '0.07',
  drift: {
    model: 'simple', Vc: '2.241e-4', a: '285.84', a1: '0.1', residualAlpha: '0',
    viscosity: 'BinghamPlastic', coeff: '0.00023143', exponent: '179.26', muMax: '10',
    BinghamCoeff: '0.0005966', BinghamExponent: '1050.8', BinghamOffset: '0',
  },
  solid: { rho: '8940', Cv: '385', kappa: '380', heatSource: '' },
  elastic: { rho: '7854', E: '2e+11', nu: '0.3', Cv: '434', kappa: '60.5', alphav: '1.1e-05', planeStress: true, thermalStress: false },
  initialRegions: [],
  patchValues: {},
  functions: [],
  decompose: { enabled: false, n: 4 },
  limitPressure: false,
  time: { adjustTimeStep: false, maxCo: '1', maxAlphaCo: '1', maxDeltaT: '1', writeControl: 'timeStep', purgeWrite: '0', writeFormat: 'ascii' },
  seed: null,
};

/** The module's own defaults, on top of DEFAULT_PHYSICS. */
export function physicsForModule(m: ModuleInfo, box: { min: Vec3; max: Vec3 }): FullPhysics {
  const p = structuredClone(DEFAULT_PHYSICS);
  const lower = (frac: number): InitialRegion => {
    const mid = [0, 1, 2].map(a => box.min[a] + (box.max[a] - box.min[a]) * frac) as Vec3;
    return {
      name: 'initialRegion', shape: 'box',
      min: [box.min[0] - 1, box.min[1] - 1, box.min[2] - 1],
      max: [mid[0], mid[1], box.max[2] + 1],
      centre: mid, radius: (box.max[1] - box.min[1]) / 4,
      point1: [...box.min] as Vec3, point2: [...box.max] as Vec3, values: {},
    };
  };
  switch (m.physics) {
    case 'isothermal':
      p.fluid = preset('water');
      p.buoyant = true;
      break;
    case 'thermal':
      p.simulationType = 'RAS'; p.model = 'kEpsilon';
      p.limitPressure = true;
      break;
    case 'shock':
      p.fluid = preset('airPsi');
      p.inletVelocity = '(600 0 0)';
      p.time = { ...p.time, adjustTimeStep: true, maxCo: '0.2', maxDeltaT: '1', writeControl: 'adjustableRunTime' };
      break;
    case 'multicomponent':
      p.buoyant = false;
      break;
    case 'vof': {
      const r = lower(0.4); r.name = 'waterColumn'; r.values = { 'alpha.water': '1' };
      p.initialRegions = [r];
      p.time = { ...p.time, adjustTimeStep: true, maxCo: '1', maxAlphaCo: '1', writeControl: 'adjustableRunTime' };
      p.phases = [{ ...p.phases[0], thermo: preset('water') }, p.phases[1]];
      break;
    }
    case 'compressibleVof': {
      const r = lower(0.4); r.name = 'waterColumn'; r.values = { 'alpha.water': '1' };
      p.initialRegions = [r];
      p.time = { ...p.time, adjustTimeStep: true, maxCo: '1', maxAlphaCo: '1', writeControl: 'adjustableRunTime' };
      break;
    }
    case 'driftFlux':
      p.phases = [
        { name: 'sludge', nu: '1e-06', rho: '1996', thermo: preset('water') },
        { name: 'water', nu: '1.7871e-06', rho: '996', thermo: preset('water') },
      ];
      p.simulationType = 'RAS'; p.model = 'buoyantKEpsilon';
      p.inletVelocity = '(0.0191 0 0)';
      p.time = { ...p.time, adjustTimeStep: true, maxCo: '5', writeControl: 'adjustableRunTime' };
      break;
    case 'solidThermal':
    case 'solidMechanics':
      p.simulationType = 'laminar';
      break;
  }
  return p;
}

/** The fluid a module's thermo-based physics describes, for the stringent checks. */
export function usesThermo(kind: PhysicsKind): boolean {
  return kind === 'isothermal' || kind === 'thermal' || kind === 'shock' || kind === 'compressibleVof' || kind === 'multicomponent';
}

export function hasPrgh(kind: PhysicsKind, p: FullPhysics): boolean {
  return kind === 'vof' || kind === 'compressibleVof' || kind === 'driftFlux'
    || ((kind === 'isothermal' || kind === 'thermal' || kind === 'multicomponent') && p.buoyant);
}

/** The volume fraction a two-phase module solves: of the first phase. */
export function alphaField(p: FullPhysics): string {
  return `alpha.${p.phases[0].name}`;
}

/** Every 0/ field the case needs, in writing order. */
export function fieldNames(kind: PhysicsKind, p: FullPhysics): string[] {
  const turbulent = p.simulationType !== 'laminar';
  const turb = turbulent ? [...(TURBULENCE_FIELDS[p.model] ?? []), 'nut'] : [];
  switch (kind) {
    case 'incompressible': return ['U', 'p', ...turb];
    case 'isothermal': return ['U', 'p', ...(p.buoyant ? ['p_rgh'] : []), 'T', ...turb];
    case 'thermal':
    case 'shock':
      return ['U', 'p', ...(kind === 'thermal' && p.buoyant ? ['p_rgh'] : []), 'T', ...turb, ...(turbulent ? ['alphat'] : [])];
    case 'multicomponent':
      return ['U', 'p', ...(p.buoyant ? ['p_rgh'] : []), 'T', ...p.species.map(s => s.name), 'Ydefault', ...turb, ...(turbulent ? ['alphat'] : [])];
    case 'vof': return ['U', 'p_rgh', alphaField(p), ...turb];
    case 'compressibleVof': return ['U', 'p', 'p_rgh', 'T', alphaField(p), ...turb];
    case 'driftFlux': return ['U', 'p_rgh', alphaField(p), ...turb];
    case 'solidThermal': return ['T'];
    case 'solidMechanics': return ['D', 'T'];
    default: return [];
  }
}

/** Exponent-form dimensions: the form both 13 and 14 accept (survey 0.3). */
export function fullDimensions(name: string, kind: PhysicsKind, p: FullPhysics): string {
  const incompressibleP = kind === 'incompressible';
  if (name.startsWith('alpha.') || p.species.some(s => s.name === name) || name === 'Ydefault') return '[0 0 0 0 0 0 0]';
  switch (name) {
    case 'U': return '[0 1 -1 0 0 0 0]';
    case 'p': return incompressibleP ? '[0 2 -2 0 0 0 0]' : '[1 -1 -2 0 0 0 0]';
    case 'p_rgh': return '[1 -1 -2 0 0 0 0]';
    case 'T': return '[0 0 0 1 0 0 0]';
    case 'k': case 'v2': return '[0 2 -2 0 0 0 0]';
    case 'epsilon': return '[0 2 -3 0 0 0 0]';
    case 'omega': case 'f': return '[0 0 -1 0 0 0 0]';
    case 'nut': case 'nuTilda': return '[0 2 -1 0 0 0 0]';
    case 'alphat': return '[1 -1 -1 0 0 0 0]';
    case 'D': return '[0 1 0 0 0 0 0]';
    default: return '[0 0 0 0 0 0 0]';
  }
}

export interface TurbulenceValues { k: number; epsilon: number; omega: number; nuTilda: number }

/** Inlet turbulence from U, I and L (see case-templates estimateTurbulence). */
export function turbulenceValues(p: FullPhysics, speed: number, fallbackLength: number, nu: number): TurbulenceValues {
  const L = Number(p.lengthScale) || fallbackLength || 0.01;
  const est = estimateTurbulence(speed || 1, (Number(p.intensity) || 5) / 100, L);
  return { ...est, nuTilda: Number((nu * 4).toPrecision(4)) };
}

export function vectorMagnitude(v: string): number {
  const nums = (v.match(/-?[\d.eE+-]+/g) || []).map(Number).filter(Number.isFinite);
  return Math.hypot(...nums);
}

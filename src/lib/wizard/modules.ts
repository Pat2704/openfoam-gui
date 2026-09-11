/**
 * Which guide the New Case wizard gives, and — for OpenFOAM 13 and 14 — every
 * solver module it can build a case for.
 *
 * The version is never the user's choice: it is the installation the app is
 * using (/api/wsl?action=version).
 *
 *   13, 14   the complete guide: every solver module of the installation.
 *            Most are generated from forms; the ones whose physics is a set of
 *            many interlocking dictionaries (multiphaseEuler, XiFluid, …) start
 *            from one of the installation's own tutorials of that module,
 *            whose dictionaries are then edited here (the user's decision).
 *   11, 12   a shorter guide: incompressibleFluid, the case layout of 11+.
 *   9, 10    a shorter guide: the incompressible solver applications.
 *   unknown  no guide — a case written for the wrong version does not run.
 *
 * The summaries are the modules' own Description blocks
 * ($FOAM_APP/modules/<module>/<module>.H, v13 and v14), shortened.
 */

import type { RoleFamily } from './roles';

export type GuideTier = 'full' | 'basic-modular' | 'basic-legacy' | 'none';

export function guideForVersion(major: number | null): GuideTier {
  if (major === null || !Number.isFinite(major)) return 'none';
  if (major === 13 || major === 14) return 'full';
  if (major === 11 || major === 12) return 'basic-modular';
  if (major === 9 || major === 10) return 'basic-legacy';
  return 'none';
}

export function guideDescription(tier: GuideTier, version: string | null): string {
  switch (tier) {
    case 'full': return `OpenFOAM ${version}: the complete guide, with every solver module of this installation.`;
    case 'basic-modular': return `OpenFOAM ${version}: a shorter guide (incompressibleFluid). The complete guide covers OpenFOAM 13 and 14.`;
    case 'basic-legacy': return `OpenFOAM ${version}: a shorter guide (the incompressible solver applications). The complete guide covers OpenFOAM 13 and 14.`;
    default: return version
      ? `OpenFOAM ${version} is not one the wizard can write cases for (it supports Foundation 9 to 14).`
      : 'The OpenFOAM version could not be detected. Select an installation in the Dashboard.';
  }
}

export type ModuleCategory = 'incompressible' | 'compressible' | 'multiphase' | 'reacting' | 'solid' | 'particles' | 'film' | 'other';

export const CATEGORY_LABEL: Record<ModuleCategory, string> = {
  incompressible: 'Incompressible flow',
  compressible: 'Compressible flow and heat transfer',
  multiphase: 'Multiphase flow',
  reacting: 'Multicomponent and reacting flow',
  solid: 'Solids',
  particles: 'Particle-laden flow',
  film: 'Liquid films',
  other: 'Other',
};

/** What the physics step asks for, and which files follow. */
export type PhysicsKind =
  | 'incompressible'     // nu; U, p
  | 'isothermal'         // thermo (T fixed); U, p, p_rgh optional
  | 'thermal'            // thermo + energy; U, p, T, (p_rgh, alphat)
  | 'multicomponent'     // thermal + species
  | 'shock'              // thermal, density-based
  | 'vof'                // two phases, incompressible
  | 'compressibleVof'    // two phases with thermo
  | 'driftFlux'          // two phases, mixture + relative velocity
  | 'solidThermal'       // solid heat conduction
  | 'solidMechanics'     // linear elasticity
  | 'tutorial';          // seeded from an installation tutorial

export interface ModuleInfo {
  id: string;
  label: string;
  category: ModuleCategory;
  summary: string;
  physics: PhysicsKind;
  family: RoleFamily;
  /** Can run steady (SIMPLE / steadyState ddt). */
  steady: boolean;
  /** Needs a transient run. */
  transientOnly: boolean;
  /** A momentum transport model (laminar/RAS/LES) is chosen. */
  turbulence: boolean;
  /** Gravity: none, optional, or required. */
  gravity: 'none' | 'optional' | 'required';
}

export const MODULES: ModuleInfo[] = [
  {
    id: 'incompressibleFluid', label: 'incompressibleFluid', category: 'incompressible', physics: 'incompressible', family: 'flow',
    summary: 'Steady or transient turbulent flow of incompressible isothermal fluids.',
    steady: true, transientOnly: false, turbulence: true, gravity: 'none',
  },
  {
    id: 'isothermalFluid', label: 'isothermalFluid', category: 'compressible', physics: 'isothermal', family: 'flow',
    summary: 'Steady or transient turbulent flow of compressible isothermal fluids.',
    steady: true, transientOnly: false, turbulence: true, gravity: 'optional',
  },
  {
    id: 'fluid', label: 'fluid', category: 'compressible', physics: 'thermal', family: 'flow',
    summary: 'Steady or transient turbulent flow of compressible fluids with heat transfer (HVAC, buoyancy, natural convection).',
    steady: true, transientOnly: false, turbulence: true, gravity: 'optional',
  },
  {
    id: 'shockFluid', label: 'shockFluid', category: 'compressible', physics: 'shock', family: 'flow',
    summary: 'Density-based compressible flow (central-upwind Kurganov–Tadmor schemes), for shocks and high speeds.',
    // Laminar only: every surveyed shockFluid tutorial but one is laminar, and
    // the survey did not establish the turbulence terms its flux scheme needs.
    steady: false, transientOnly: true, turbulence: false, gravity: 'none',
  },
  {
    id: 'multicomponentFluid', label: 'multicomponentFluid', category: 'reacting', physics: 'multicomponent', family: 'flow',
    summary: 'Steady or transient turbulent flow of compressible multicomponent fluids, optionally reacting.',
    steady: true, transientOnly: false, turbulence: true, gravity: 'optional',
  },
  {
    id: 'incompressibleVoF', label: 'incompressibleVoF', category: 'multiphase', physics: 'vof', family: 'flow',
    summary: 'Two incompressible, isothermal immiscible fluids with a VoF interface (free surfaces, sloshing, dam breaks).',
    steady: false, transientOnly: true, turbulence: true, gravity: 'required',
  },
  {
    id: 'compressibleVoF', label: 'compressibleVoF', category: 'multiphase', physics: 'compressibleVof', family: 'flow',
    summary: 'Two compressible, non-isothermal immiscible fluids with a VoF interface.',
    steady: false, transientOnly: true, turbulence: true, gravity: 'required',
  },
  {
    id: 'incompressibleDriftFlux', label: 'incompressibleDriftFlux', category: 'multiphase', physics: 'driftFlux', family: 'flow',
    summary: 'Two incompressible fluids as a mixture with a drift-flux relative velocity (settling, sludge).',
    steady: false, transientOnly: true, turbulence: true, gravity: 'required',
  },
  {
    id: 'solid', label: 'solid', category: 'solid', physics: 'solidThermal', family: 'solidThermal',
    summary: 'Heat conduction in a solid (on its own, or as a region of a conjugate heat transfer case).',
    steady: true, transientOnly: false, turbulence: false, gravity: 'none',
  },
  {
    id: 'solidDisplacement', label: 'solidDisplacement', category: 'solid', physics: 'solidMechanics', family: 'solidMechanics',
    summary: 'Linear-elastic, small-strain deformation of a solid, with optional thermal stresses.',
    steady: true, transientOnly: false, turbulence: false, gravity: 'none',
  },
  // Seeded from an installation tutorial.
  {
    id: 'multiphaseEuler', label: 'multiphaseEuler', category: 'multiphase', physics: 'tutorial', family: 'flow',
    summary: 'Any number of compressible phases with a common pressure (Euler–Euler): bubble columns, fluidised beds, boiling.',
    steady: false, transientOnly: true, turbulence: false, gravity: 'required',
  },
  {
    id: 'incompressibleMultiphaseVoF', label: 'incompressibleMultiphaseVoF', category: 'multiphase', physics: 'tutorial', family: 'flow',
    summary: 'Several incompressible, isothermal immiscible fluids with VoF interfaces.',
    steady: false, transientOnly: true, turbulence: false, gravity: 'required',
  },
  {
    id: 'compressibleMultiphaseVoF', label: 'compressibleMultiphaseVoF', category: 'multiphase', physics: 'tutorial', family: 'flow',
    summary: 'Several compressible, isothermal immiscible fluids with VoF interfaces.',
    steady: false, transientOnly: true, turbulence: false, gravity: 'required',
  },
  {
    id: 'XiFluid', label: 'XiFluid', category: 'reacting', physics: 'tutorial', family: 'flow',
    summary: 'Premixed and partially-premixed combustion with the Weller b–Xi flame model.',
    steady: false, transientOnly: true, turbulence: false, gravity: 'none',
  },
  {
    id: 'incompressibleDenseParticleFluid', label: 'incompressibleDenseParticleFluid', category: 'particles', physics: 'tutorial', family: 'flow',
    summary: 'Incompressible isothermal flow coupled with dense particle clouds.',
    steady: false, transientOnly: true, turbulence: false, gravity: 'required',
  },
  {
    id: 'isothermalFilm', label: 'isothermalFilm', category: 'film', physics: 'tutorial', family: 'flow',
    summary: 'Flow of compressible isothermal liquid films.',
    steady: false, transientOnly: true, turbulence: false, gravity: 'required',
  },
  {
    id: 'film', label: 'film', category: 'film', physics: 'tutorial', family: 'flow',
    summary: 'Flow of compressible liquid films (the installation\'s film tutorials).',
    steady: false, transientOnly: true, turbulence: false, gravity: 'required',
  },
  {
    id: 'movingMesh', label: 'movingMesh', category: 'other', physics: 'tutorial', family: 'flow',
    summary: 'Moves the mesh only, as dynamicMeshDict specifies.',
    steady: false, transientOnly: true, turbulence: false, gravity: 'none',
  },
  {
    id: 'functions', label: 'functions', category: 'other', physics: 'tutorial', family: 'flow',
    summary: 'Runs function objects over the fields of another solver module, without solving it.',
    steady: false, transientOnly: true, turbulence: false, gravity: 'none',
  },
];

export function findModule(id: string): ModuleInfo | undefined {
  return MODULES.find(m => m.id === id);
}

/**
 * The modules to offer: those the installation lists (foamToC -solvers), in
 * catalogue order. A module this build does not know is offered from its
 * tutorials, like the complex ones. Before the installation answers, the
 * catalogue itself.
 */
export function modulesOffered(installed: string[] | null): ModuleInfo[] {
  if (!installed?.length) return MODULES;
  const known = MODULES.filter(m => installed.includes(m.id));
  const unknown = installed.filter(id => !MODULES.some(m => m.id === id) && !/Solver$/.test(id)).map(id => ({
    id, label: id, category: 'other' as const, physics: 'tutorial' as const, family: 'flow' as const,
    summary: 'A solver module this version of the wizard does not describe; it starts from one of its tutorials.',
    steady: false, transientOnly: true, turbulence: false, gravity: 'none' as const,
  }));
  return [...known, ...unknown];
}

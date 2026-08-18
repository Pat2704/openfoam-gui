// OpenFOAM complete command database and case templates
//
// Commands carry an optional `minVersion` (major OpenFOAM version that introduced
// them). The Command Panel filters the list against the active OpenFOAM version
// (returned by /api/wsl?action=version) so users only see commands that actually
// exist in their installed version. Commands without `minVersion` are valid for
// every supported version (OpenFOAM 9+).

export interface OpenFOAMCommand {
  name: string;
  category: string;
  description: string;
  syntax: string;
  commonOptions?: string;
  /** Minimum OpenFOAM major version that ships this command. */
  minVersion?: number;
}

export const COMMAND_CATEGORIES = [
  'Execution',
  'Mesh Generation',
  'Mesh Utilities',
  'Pre-processing',
  'Post-processing',
  'Parallel Processing',
  'Field Utilities',
  'Sampling & Probes',
  'Surface Utilities',
  'Case Management',
  'Solver Modules',
  'Mesh Conversion',
  'Compilation & Debug',
  'Units & Dimensions',
] as const;

export const OPENFOAM_COMMANDS: OpenFOAMCommand[] = [
  // ═══════════════════════════════════════════════════════
  // EXECUTION — foamRun / foamMultiRun (introduced in v11, mainstream since v13)
  // ═══════════════════════════════════════════════════════
  { name: 'foamRun', category: 'Execution', minVersion: 11, description: 'Runs the solver module specified in system/controlDict (replaces simpleFoam, pimpleFoam, etc.)', syntax: 'foamRun', commonOptions: '-case <dir>, -parallel, -solver <name>' },
  { name: 'foamRun > log', category: 'Execution', minVersion: 11, description: 'Runs the solver and saves output to a log file (stdout+stderr)', syntax: 'foamRun > log.foamRun 2>&1 &', commonOptions: '' },
  { name: 'foamMultiRun', category: 'Execution', minVersion: 11, description: 'Runs a solver module for each region of a multi-region simulation (e.g. CHT)', syntax: 'foamMultiRun', commonOptions: '-case <dir>, -parallel' },
  { name: 'foamInitializeFields', category: 'Execution', minVersion: 14, description: 'Initializes fields using the new field functions and functionalFixedValue BC (v14)', syntax: 'foamInitializeFields', commonOptions: '-case <dir>' },

  // ═══════════════════════════════════════════════════════
  // MESH GENERATION
  // ═══════════════════════════════════════════════════════
  { name: 'blockMesh', category: 'Mesh Generation', description: 'Generates the block mesh from the blockMeshDict file in system/', syntax: 'blockMesh', commonOptions: '-case <dir>' },
  { name: 'snappyHexMesh', category: 'Mesh Generation', description: 'Generates a mesh conforming to STL geometries with adaptive refinement', syntax: 'snappyHexMesh -overwrite', commonOptions: '-overwrite, -parallel' },
  { name: 'cartesianMesh', category: 'Mesh Generation', description: 'Cartesian meshing (cfMesh)', syntax: 'cartesianMesh', commonOptions: '' },
  { name: 'pMesh', category: 'Mesh Generation', description: 'Polyhedral meshing (cfMesh)', syntax: 'pMesh', commonOptions: '' },
  { name: 'tetMesh', category: 'Mesh Generation', description: 'Tetrahedral meshing (cfMesh)', syntax: 'tetMesh', commonOptions: '' },

  // ═══════════════════════════════════════════════════════
  // MESH CONVERSION (from other formats)
  // ═══════════════════════════════════════════════════════
  { name: 'gmshToFoam', category: 'Mesh Conversion', description: 'Converts Gmsh (.msh) mesh into OpenFOAM format', syntax: 'gmshToFoam <file.msh>', commonOptions: '' },
  { name: 'fluent3DMeshToFoam', category: 'Mesh Conversion', description: 'Converts Fluent 3D (.msh) mesh into OpenFOAM format', syntax: 'fluent3DMeshToFoam <file.msh>', commonOptions: '' },
  { name: 'ansysToFoam', category: 'Mesh Conversion', description: 'Converts ANSYS mesh into OpenFOAM format', syntax: 'ansysToFoam <file>', commonOptions: '' },
  { name: 'star4ToFoam', category: 'Mesh Conversion', description: 'Converts STAR-CD mesh into OpenFOAM format', syntax: 'star4ToFoam <file>', commonOptions: '' },
  { name: 'ideasToFoam', category: 'Mesh Conversion', description: 'Converts I-DEAS (.unv) mesh into OpenFOAM format', syntax: 'ideasToFoam <file.unv>', commonOptions: '' },
  { name: 'kivaToFoam', category: 'Mesh Conversion', description: 'Converts KIVA3V mesh into OpenFOAM format', syntax: 'kivaToFoam <file>', commonOptions: '' },
  { name: 'mshToFoam', category: 'Mesh Conversion', description: 'Converts generic msh-format mesh', syntax: 'mshToFoam <file.msh>', commonOptions: '' },
  { name: 'netgenNeutralToFoam', category: 'Mesh Conversion', description: 'Converts NETGEN mesh into OpenFOAM format', syntax: 'netgenNeutralToFoam <file>', commonOptions: '' },
  { name: 'plot3dToFoam', category: 'Mesh Conversion', description: 'Converts PLOT3D mesh into OpenFOAM format', syntax: 'plot3dToFoam <file>', commonOptions: '' },
  { name: 'tetgenToFoam', category: 'Mesh Conversion', description: 'Converts Tetgen mesh into OpenFOAM format', syntax: 'tetgenToFoam <file>', commonOptions: '' },

  // ═══════════════════════════════════════════════════════
  // MESH UTILITIES
  // ═══════════════════════════════════════════════════════
  { name: 'checkMesh', category: 'Mesh Utilities', description: 'Checks mesh quality (aspect ratio, non-orthogonality, skewness)', syntax: 'checkMesh', commonOptions: '-case <dir>, -allTopology, -noZero' },
  { name: 'refineMesh', category: 'Mesh Utilities', description: 'Refines the mesh globally or in specific regions', syntax: 'refineMesh', commonOptions: '-overwrite, -all' },
  { name: 'mirrorMesh', category: 'Mesh Utilities', description: 'Creates a mirrored domain', syntax: 'mirrorMesh', commonOptions: '' },
  { name: 'mergeMeshes', category: 'Mesh Utilities', description: 'Merges two or more meshes', syntax: 'mergeMeshes <case1> <case2> <outputCase>', commonOptions: '' },
  { name: 'splitMeshRegions', category: 'Mesh Utilities', description: 'Splits the mesh into regions (for multi-region cases)', syntax: 'splitMeshRegions', commonOptions: '-cellZones, -overwrite' },
  { name: 'stitchMesh', category: 'Mesh Utilities', description: 'Stitches adjacent patches', syntax: 'stitchMesh <masterPatch> <slavePatch>', commonOptions: '-tolerance <val>' },
  { name: 'transformPoints', category: 'Mesh Utilities', description: 'Translates, rotates or scales the mesh', syntax: 'transformPoints "rotate=(...) (..., ...) ..."', commonOptions: '-scale <factor>' },
  { name: 'makeAxialMesh', category: 'Mesh Utilities', description: 'Converts a 3D mesh into an axisymmetric mesh', syntax: 'makeAxialMesh', commonOptions: '-axis <point> <point>' },
  { name: 'collapseEdges', category: 'Mesh Utilities', description: 'Collapses short mesh edges', syntax: 'collapseEdges', commonOptions: '-overwrite' },
  { name: 'modifyMesh', category: 'Mesh Utilities', description: 'Modifies the mesh (removes/hides cells)', syntax: 'modifyMesh', commonOptions: '-patch <name> -set <cellSet>' },
  { name: 'smoothMesh', category: 'Mesh Utilities', description: 'Smooths the mesh with a Laplacian', syntax: 'smoothMesh', commonOptions: '-overwrite' },
  { name: 'extrudeMesh', category: 'Mesh Utilities', description: 'Extrudes a 2D mesh into 3D', syntax: 'extrudeMesh', commonOptions: '' },
  { name: 'extrudeToRegionMesh', category: 'Mesh Utilities', description: 'Extrudes a patch into a new region', syntax: 'extrudeToRegionMesh', commonOptions: '' },
  { name: 'renumberMesh', category: 'Mesh Utilities', description: 'Renumbers cells to improve the sparse matrix', syntax: 'renumberMesh', commonOptions: '-overwrite' },
  { name: 'writeCellCentres', category: 'Mesh Utilities', description: 'Writes cell centres as fields', syntax: 'writeCellCentres', commonOptions: '' },

  // ═══════════════════════════════════════════════════════
  // PRE-PROCESSING
  // ═══════════════════════════════════════════════════════
  { name: 'setFields', category: 'Pre-processing', description: 'Sets initial values for fields', syntax: 'setFields', commonOptions: '-case <dir>' },
  { name: 'setExprFields', category: 'Pre-processing', description: 'Sets fields with mathematical expressions', syntax: 'setExprFields', commonOptions: '' },
  { name: 'initTopoSet', category: 'Pre-processing', description: 'Initializes topological sets (cellSet, faceSet, pointSet)', syntax: 'initTopoSet', commonOptions: '' },
  { name: 'topoSet', category: 'Pre-processing', description: 'Creates and modifies topological sets', syntax: 'topoSet', commonOptions: '' },
  { name: 'createPatch', category: 'Pre-processing', description: 'Creates/modifies patches', syntax: 'createPatch -overwrite', commonOptions: '-overwrite' },
  { name: 'autoPatch', category: 'Pre-processing', description: 'Groups faces into patches automatically by angle', syntax: 'autoPatch <angle>', commonOptions: '-overwrite' },
  { name: 'surfaceFeatureExtract', category: 'Pre-processing', description: 'Extracts feature edges from STL for snappyHexMesh', syntax: 'surfaceFeatureExtract', commonOptions: '' },
  { name: 'surfaceCheck', category: 'Pre-processing', description: 'Checks STL surface', syntax: 'surfaceCheck <file.stl>', commonOptions: '' },
  { name: 'decomposePar', category: 'Pre-processing', description: 'Decomposes the case for parallel computation (decomposeParDict)', syntax: 'decomposePar', commonOptions: '-force' },

  // ═══════════════════════════════════════════════════════
  // POST-PROCESSING
  // ═══════════════════════════════════════════════════════
  { name: 'foamPostProcess', category: 'Post-processing', description: 'Runs post-processing functions (funObjects) defined in controlDict', syntax: 'foamPostProcess', commonOptions: '-func <name>, -latestTime, -time <t>' },
  { name: 'foamCalc', category: 'Post-processing', description: 'Computes derived fields (vorticity, divergence, gradient, mag, etc.)', syntax: 'foamCalc <component> <field>', commonOptions: '' },
  { name: 'foamListTimes', category: 'Post-processing', description: 'Lists the saved timesteps in the case', syntax: 'foamListTimes', commonOptions: '-rm, -latestTime, -time <t>' },
  { name: 'foamGetRange', category: 'Post-processing', description: 'Shows the range of available timesteps', syntax: 'foamGetRange', commonOptions: '' },
  { name: 'paraFoam', category: 'Post-processing', description: 'Launches ParaView for visualization (requires X11 display)', syntax: 'paraFoam -builtin', commonOptions: '-builtin, -case <dir>' },
  { name: 'patchAverage', category: 'Post-processing', description: 'Computes the average of a field over a patch', syntax: 'patchAverage <field> <patch>', commonOptions: '' },
  { name: 'patchIntegrate', category: 'Post-processing', description: 'Integrates a field over a patch', syntax: 'patchIntegrate <field> <patch>', commonOptions: '' },
  { name: 'wallShearStress', category: 'Post-processing', description: 'Computes the wall shear stress', syntax: 'wallShearStress', commonOptions: '' },
  { name: 'yPlusRAS', category: 'Post-processing', description: 'Computes y+ for RANS', syntax: 'yPlusRAS', commonOptions: '' },
  { name: 'yPlusLES', category: 'Post-processing', description: 'Computes y+ for LES', syntax: 'yPlusLES', commonOptions: '' },
  { name: 'turbulenceFields', category: 'Post-processing', description: 'Generates turbulence fields (k, epsilon, omega, nuTilda, R, L)', syntax: 'turbulenceFields', commonOptions: '' },
  { name: 'vorticity', category: 'Post-processing', description: 'Computes the vorticity field', syntax: 'vorticity', commonOptions: '' },
  { name: 'pressureDifference', category: 'Post-processing', description: 'Computes the pressure difference between two patches', syntax: 'pressureDifference <patch1> <patch2>', commonOptions: '' },
  { name: 'flowRatePatch', category: 'Post-processing', description: 'Computes volumetric/mass flow rate over a patch', syntax: 'flowRatePatch <patch>', commonOptions: '' },

  // ═══════════════════════════════════════════════════════
  // EXPORT RESULTS
  // ═══════════════════════════════════════════════════════
  { name: 'foamToVTK', category: 'Post-processing', description: 'Exports results in VTK format for ParaView', syntax: 'foamToVTK', commonOptions: '-latestTime, -time <t>' },
  { name: 'foamToEnsight', category: 'Post-processing', description: 'Exports results in EnSight format', syntax: 'foamToEnsight', commonOptions: '-latestTime' },
  { name: 'foamToCSV', category: 'Post-processing', description: 'Exports probe/sets data to CSV', syntax: 'foamToCSV', commonOptions: '' },
  { name: 'foamToSurface', category: 'Post-processing', description: 'Exports patches as surfaces', syntax: 'foamToSurface', commonOptions: '' },

  // ═══════════════════════════════════════════════════════
  // SAMPLING & PROBES
  // ═══════════════════════════════════════════════════════
  { name: 'sample', category: 'Sampling & Probes', description: 'Performs sampling according to system/sampleDict', syntax: 'sample', commonOptions: '-latestTime' },
  { name: 'setsToVTK', category: 'Sampling & Probes', description: 'Exports topological sets to VTK', syntax: 'setsToVTK', commonOptions: '' },

  // ═══════════════════════════════════════════════════════
  // PARALLEL PROCESSING
  // ═══════════════════════════════════════════════════════
  { name: 'decomposePar', category: 'Parallel Processing', description: 'Decomposes the case for parallel computation', syntax: 'decomposePar', commonOptions: '-force' },
  { name: 'reconstructPar', category: 'Parallel Processing', description: 'Reconstructs the parallel case into a single domain', syntax: 'reconstructPar', commonOptions: '-latestTime' },
  { name: 'reconstructParMesh', category: 'Parallel Processing', description: 'Reconstructs the parallel mesh', syntax: 'reconstructParMesh', commonOptions: '' },
  { name: 'redistributePar', category: 'Parallel Processing', description: 'Redistributes parallel data across processors', syntax: 'redistributePar', commonOptions: '-decomposeParDict <file>' },

  // ═══════════════════════════════════════════════════════
  // FIELD UTILITIES
  // ═══════════════════════════════════════════════════════
  { name: 'mapFields', category: 'Field Utilities', description: 'Maps fields from one case to another (different meshes)', syntax: 'mapFields <sourceCase> -consistent', commonOptions: '-consistent, -sourceTime <t>' },
  { name: 'mapFieldsPar', category: 'Field Utilities', description: 'Maps fields for parallel cases', syntax: 'mapFieldsPar <sourceCase>', commonOptions: '' },
  { name: 'interpolateFields', category: 'Field Utilities', description: 'Interpolates fields between different meshes', syntax: 'interpolateFields', commonOptions: '' },
  { name: 'foamDictionary', category: 'Field Utilities', description: 'Reads/writes values in OpenFOAM dictionary files', syntax: 'foamDictionary <file> -entry <key>', commonOptions: '-entry, -set, -add, -remove' },

  // ═══════════════════════════════════════════════════════
  // SURFACE UTILITIES
  // ═══════════════════════════════════════════════════════
  { name: 'surfaceTransformPoints', category: 'Surface Utilities', description: 'Applies a transformation to an STL surface', syntax: 'surfaceTransformPoints <input> <output> "rotate=(...) ..."', commonOptions: '' },
  { name: 'surfaceSplitByPatch', category: 'Surface Utilities', description: 'Splits a surface by patch', syntax: 'surfaceSplitByPatch <input> <output>', commonOptions: '' },
  { name: 'surfacePatch', category: 'Surface Utilities', description: 'Adds patch info to a surface', syntax: 'surfacePatch <input> <output>', commonOptions: '' },
  { name: 'surfaceSmooth', category: 'Surface Utilities', description: 'Smooths an STL surface', syntax: 'surfaceSmooth <input> <output>', commonOptions: '' },
  { name: 'surfaceCheck', category: 'Surface Utilities', description: 'Checks STL surface quality', syntax: 'surfaceCheck <file.stl>', commonOptions: '' },

  // ═══════════════════════════════════════════════════════
  // CASE MANAGEMENT
  // ═══════════════════════════════════════════════════════
  { name: 'foamCleanCase', category: 'Case Management', description: 'Cleans the case (removes mesh, timesteps > 0, logs, processor*)', syntax: 'foamCleanCase', commonOptions: '' },
  { name: 'foamCleanPolyMesh', category: 'Case Management', description: 'Removes only the polyMesh/ directory', syntax: 'foamCleanPolyMesh', commonOptions: '' },
  { name: 'foamCloneCase', category: 'Case Management', description: 'Clones a case (only mesh and 0/)', syntax: 'foamCloneCase <source> <target>', commonOptions: '' },
  { name: 'foamMergeCase', category: 'Case Management', minVersion: 13, description: 'Merges structure and files of multiple cases into one (introduced in v13)', syntax: 'foamMergeCase <source1> <source2> ... <target>', commonOptions: '' },
  { name: 'foamListTimes', category: 'Case Management', description: 'Lists saved timesteps', syntax: 'foamListTimes', commonOptions: '-rm, -latestTime' },
  { name: 'foamGetRange', category: 'Case Management', description: 'Shows the range of timesteps', syntax: 'foamGetRange', commonOptions: '' },

  // ═══════════════════════════════════════════════════════
  // SOLVER MODULES — modular solvers, specified in controlDict.
  // Introduced in v11, evolved in v12/v13/v14.
  // ═══════════════════════════════════════════════════════
  { name: 'incompressibleFluid', category: 'Solver Modules', minVersion: 11, description: 'Incompressible flow (steady-state/transient, RAS/LES/laminar) — replaces simpleFoam, pimpleFoam, icoFoam', syntax: '(in controlDict: application foamRun; solverModule incompressibleFluid)', commonOptions: '' },
  { name: 'incompressibleVoF', category: 'Solver Modules', minVersion: 11, description: 'Incompressible two-phase VOF — replaces interFoam, interPhaseChangeFoam', syntax: 'solverModule incompressibleVoF', commonOptions: '' },
  { name: 'compressibleFluid', category: 'Solver Modules', minVersion: 11, description: 'Compressible flow (steady-state/transient) — replaces rhoSimpleFoam, rhoPimpleFoam', syntax: 'solverModule compressibleFluid', commonOptions: '' },
  { name: 'compressibleVoF', category: 'Solver Modules', minVersion: 11, description: 'Compressible two-phase VOF', syntax: 'solverModule compressibleVoF', commonOptions: '' },
  { name: 'incompressibleMultiphaseEuler', category: 'Solver Modules', minVersion: 12, description: 'Incompressible Euler-Euler multiphase — replaces multiphaseEulerFoam', syntax: 'solverModule incompressibleMultiphaseEuler', commonOptions: '' },
  { name: 'compressibleMultiphaseEuler', category: 'Solver Modules', minVersion: 12, description: 'Compressible Euler-Euler multiphase', syntax: 'solverModule compressibleMultiphaseEuler', commonOptions: '' },
  { name: 'LagrangianDPM', category: 'Solver Modules', minVersion: 12, description: 'Discrete Phase Model for particles — replaces DPMFoam', syntax: 'solverModule LagrangianDPM', commonOptions: '' },
  { name: 'LagrangianMPPIC', category: 'Solver Modules', minVersion: 12, description: 'Multi-Phase PIC for dense particles — replaces MPPICFoam', syntax: 'solverModule LagrangianMPPIC', commonOptions: '' },
  { name: 'buoyancy', category: 'Solver Modules', minVersion: 11, description: 'Natural convection (Boussinesq/compressible) — replaces buoyantSimpleFoam, buoyantPimpleFoam', syntax: 'solverModule buoyancy', commonOptions: '' },
  { name: 'heatTransfer', category: 'Solver Modules', minVersion: 11, description: 'Conjugate heat transfer solid-fluid — replaces chtMultiRegionFoam', syntax: 'solverModule heatTransfer', commonOptions: '' },
  { name: 'isothermalFluid', category: 'Solver Modules', minVersion: 14, description: 'Improved isothermal fluid for supersonic inlet flow (v14)', syntax: 'solverModule isothermalFluid', commonOptions: '' },
  { name: 'isothermalFilm', category: 'Solver Modules', minVersion: 13, description: 'Isothermal film (thin liquid film) — volumetric flow constraint with fixed velocity BC (v13, improved in v14)', syntax: 'solverModule isothermalFilm', commonOptions: '' },
  { name: 'XiFluid', category: 'Solver Modules', minVersion: 14, description: 'Premixed flame combustion rewritten in v14 as a two-phase solver with MULES — replaces XiFoam', syntax: 'solverModule XiFluid', commonOptions: '' },
  { name: 'DNS', category: 'Solver Modules', minVersion: 12, description: 'Direct Numerical Simulation — replaces dnsFoam', syntax: 'solverModule DNS', commonOptions: '' },
  { name: 'combustion', category: 'Solver Modules', minVersion: 12, description: 'Generic combustion — replaces reactingFoam, fireFoam', syntax: 'solverModule combustion', commonOptions: '' },
  { name: 'solid', category: 'Solver Modules', minVersion: 12, description: 'Solid heat transfer', syntax: 'solverModule solid', commonOptions: '' },

  // ═══════════════════════════════════════════════════════
  // COMPILATION & DEBUG
  // ═══════════════════════════════════════════════════════
  { name: 'wmake', category: 'Compilation & Debug', description: 'Compiles OpenFOAM C++ source code', syntax: 'wmake', commonOptions: '' },
  { name: 'wclean', category: 'Compilation & Debug', description: 'Cleans compiled files', syntax: 'wclean', commonOptions: '' },
  { name: 'testFoam', category: 'Compilation & Debug', description: 'Test suite for OpenFOAM', syntax: 'testFoam', commonOptions: '' },
  { name: 'foamExec', category: 'Compilation & Debug', description: 'Runs a command in the OpenFOAM environment', syntax: 'foamExec <cmd>', commonOptions: '' },

  // ═══════════════════════════════════════════════════════
  // UNITS & DIMENSIONS — new in v14
  // ═══════════════════════════════════════════════════════
  { name: 'foamUnits', category: 'Units & Dimensions', minVersion: 14, description: 'v14 utility: lists/verifies standard units for input parameters and named dimensions (introduced in v14)', syntax: 'foamUnits', commonOptions: '-list, -verify' },
];

// ── Version-aware filtering ──
//
// Returns the subset of OPENFOAM_COMMANDS compatible with the given major
// OpenFOAM version. If `version` is null/undefined/NaN (e.g. WSL offline or
// version not yet detected), returns ALL commands so the UI is still usable.
export function getCommandsForVersion(version: number | null | undefined): OpenFOAMCommand[] {
  if (version === null || version === undefined || !Number.isFinite(version)) {
    return OPENFOAM_COMMANDS;
  }
  return OPENFOAM_COMMANDS.filter(c => c.minVersion === undefined || version >= c.minVersion);
}

// ── Parse a version string like "14", "v14", "OpenFOAM-14", "13.0" into a major number ──
export function parseMajorVersion(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

export interface CaseTemplate {
  name: string;
  description: string;
  category: string;
  tutorialPath: string;
  files: {
    '0'?: Record<string, string>;
    system?: Record<string, string>;
    constant?: Record<string, string>;
  };
}

export const CASE_TEMPLATES: CaseTemplate[] = [
  {
    name: 'Cavity (lid-driven)',
    description: 'Flow in a cavity with moving top wall - classic 2D test',
    category: 'Incompressible - Laminar',
    tutorialPath: 'incompressible/icoFoam/cavity/cavity',
    files: {}
  },
  {
    name: 'Pipe Flow',
    description: 'Flow in a pipe with circular cross-section - boundary layer development',
    category: 'Incompressible - Turbulent',
    tutorialPath: 'incompressible/simpleFoam/pitzDaily',
    files: {}
  },
  {
    name: 'Airfoil (NACA 0012)',
    description: 'Flow around a NACA 0012 airfoil',
    category: 'Incompressible - Turbulent',
    tutorialPath: 'incompressible/simpleFoam/airFoil2D',
    files: {}
  },
  {
    name: 'Backward Facing Step',
    description: 'Flow with separation and reattachment behind a step',
    category: 'Incompressible - Turbulent',
    tutorialPath: 'incompressible/pisoFoam/ras/cavity',
    files: {}
  },
  {
    name: 'Dam Break',
    description: 'Dam break - collapsing water column (VOF)',
    category: 'Multiphase',
    tutorialPath: 'multiphase/interFoam/laminar/damBreak/damBreak',
    files: {}
  },
  {
    name: 'Buoyant Cavity',
    description: 'Natural convection in a square cavity (Boussinesq)',
    category: 'Heat Transfer',
    tutorialPath: 'heatTransfer/buoyantBoussinesqSimpleFoam/hotRoom',
    files: {}
  },
  {
    name: 'Motorbike',
    description: 'Turbulent flow around a motorbike with snappyHexMesh',
    category: 'Incompressible - Turbulent',
    tutorialPath: 'incompressible/simpleFoam/motorBike/motorBike',
    files: {}
  },
  {
    name: 'T-junction',
    description: 'Flow in a T-shaped pipe junction',
    category: 'Incompressible - Turbulent',
    tutorialPath: 'incompressible/pimpleFoam/TJunction',
    files: {}
  },
  {
    name: 'Wind Around Buildings',
    description: 'Wind simulation around buildings',
    category: 'Incompressible - Turbulent',
    tutorialPath: 'incompressible/simpleFoam/windAroundBuildings',
    files: {}
  },
  {
    name: 'Flange',
    description: 'Flow in a flange with snappyHexMesh',
    category: 'Incompressible - Turbulent',
    tutorialPath: 'incompressible/simpleFoam/flange',
    files: {}
  },
  {
    name: 'Multi-region Heater',
    description: 'Conjugate heat transfer solid-fluid',
    category: 'Heat Transfer',
    tutorialPath: 'heatTransfer/chtMultiRegionFoam/multiRegionHeater',
    files: {}
  },
  {
    name: 'Sloshing Tank',
    description: 'Sloshing in a tank (VOF)',
    category: 'Multiphase',
    tutorialPath: 'multiphase/interFoam/laminar/sloshingTank3D',
    files: {}
  },
  {
    name: 'Reacting Parcel',
    description: 'Reacting particles in a flow',
    category: 'Lagrangian',
    tutorialPath: 'lagrangian/coalChemistryFoam/simplifiedSiwek',
    files: {}
  },
  {
    name: 'Compressible Nozzle',
    description: 'Compressible flow in a converging-diverging nozzle',
    category: 'Compressible',
    tutorialPath: 'compressible/rhoPimpleFoam/laminar/planarPoiseuille',
    files: {}
  },
  {
    name: 'Buoyant Hot Room',
    description: 'Natural convection in a room with a heat source',
    category: 'Heat Transfer',
    tutorialPath: 'heatTransfer/buoyantSimpleFoam/hotRoom',
    files: {}
  },
  {
    name: 'Empty',
    description: 'Empty case with minimal structure (0/, system/, constant/)',
    category: 'Custom',
    tutorialPath: '',
    files: {}
  },
];

export interface FileTemplate {
  path: string;
  directory: '0' | 'system' | 'constant';
  description: string;
  content: string;
}

export const FILE_TEMPLATES: Record<string, FileTemplate[]> = {
  'Cavity (lid-driven)': [
    {
      path: 'U',
      directory: '0',
      description: 'Velocity field',
      content: `/*--------------------------------*- C++ -*----------------------------------*\\
| =========                 |                                                 |
| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |
|  \\\\    /   O peration     | Version:  dev                                   |
|   \\\\  /    A nd           | Web:      www.OpenFOAM.org                      |
|    \\\\/     M anipulation  |                                                 |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       volVectorField;
    location    "0";
    object      U;
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

dimensions      [0 1 -1 0 0 0 0];

internalField   uniform (0 0 0);

boundaryField
{
    movingWall
    {
        type            fixedValue;
        value           uniform (1 0 0);
    }

    fixedWalls
    {
        type            noSlip;
    }

    frontAndBack
    {
        type            empty;
    }
}

// ************************************************************************* //
`
    },
    {
      path: 'p',
      directory: '0',
      description: 'Pressure field',
      content: `/*--------------------------------*- C++ -*----------------------------------*\\
| =========                 |                                                 |
| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |
|  \\\\    /   O peration     | Version:  dev                                   |
|   \\\\  /    A nd           | Web:      www.OpenFOAM.org                      |
|    \\\\/     M anipulation  |                                                 |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    location    "0";
    object      p;
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

dimensions      [0 2 -2 0 0 0 0];

internalField   uniform 0;

boundaryField
{
    movingWall
    {
        type            zeroGradient;
    }

    fixedWalls
    {
        type            zeroGradient;
    }

    frontAndBack
    {
        type            empty;
    }
}

// ************************************************************************* //
`
    },
    {
      path: 'controlDict',
      directory: 'system',
      description: 'Simulation controls',
      content: `/*--------------------------------*- C++ -*----------------------------------*\\
| =========                 |                                                 |
| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |
|  \\\\    /   O peration     | Version:  dev                                   |
|   \\\\  /    A nd           | Web:      www.OpenFOAM.org                      |
|    \\\\/     M anipulation  |                                                 |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    location    "system";
    object      controlDict;
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

application     icoFoam;

startFrom       latestTime;

startTime       0;

stopAt          endTime;

endTime         0.5;

deltaT          0.005;

writeControl    timeStep;

writeInterval   20;

purgeWrite      0;

writeFormat     ascii;

writePrecision  6;

writeCompression uncompressed;

timeFormat      general;

timePrecision   6;

runTimeModifiable yes;

// ************************************************************************* //
`
    },
    {
      path: 'fvSchemes',
      directory: 'system',
      description: 'Discretization schemes',
      content: `/*--------------------------------*- C++ -*----------------------------------*\\
| =========                 |                                                 |
| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |
|  \\\\    /   O peration     | Version:  dev                                   |
|   \\\\  /    A nd           | Web:      www.OpenFOAM.org                      |
|    \\\\/     M anipulation  |                                                 |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    location    "system";
    object      fvSchemes;
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

ddtSchemes
{
    default         Euler;
}

gradSchemes
{
    default         Gauss linear;
}

divSchemes
{
    default         none;
    div(phi,U)      Gauss linear;
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
}

// ************************************************************************* //
`
    },
    {
      path: 'fvSolution',
      directory: 'system',
      description: 'Solver settings and algorithms',
      content: `/*--------------------------------*- C++ -*----------------------------------*\\
| =========                 |                                                 |
| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |
|  \\\\    /   O peration     | Version:  dev                                   |
|   \\\\  /    A nd           | Web:      www.OpenFOAM.org                      |
|    \\\\/     M anipulation  |                                                 |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    location    "system";
    object      fvSolution;
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

solvers
{
    p
    {
        solver          PCG;
        preconditioner  DIC;
        tolerance       1e-06;
        relTol          0;
    }

    pFinal
    {
        $p;
        relTol          0;
    }

    U
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-05;
        relTol          0;
    }
}

PISO
{
    nCorrectors     2;
    nNonOrthogonalCorrectors 0;
    pRefCell        0;
    pRefValue       0;
}

// ************************************************************************* //
`
    },
    {
      path: 'blockMeshDict',
      directory: 'system',
      description: 'Block mesh definition',
      content: `/*--------------------------------*- C++ -*----------------------------------*\\
| =========                 |                                                 |
| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |
|  \\\\    /   O peration     | Version:  dev                                   |
|   \\\\  /    A nd           | Web:      www.OpenFOAM.org                      |
|    \\\\/     M anipulation  |                                                 |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      blockMeshDict;
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

scale   0.1;

vertices
(
    (0 0 0)
    (1 0 0)
    (1 1 0)
    (0 1 0)
    (0 0 0.1)
    (1 0 0.1)
    (1 1 0.1)
    (0 1 0.1)
);

blocks
(
    hex (0 1 2 3 4 5 6 7) (20 20 1) simpleGrading (1 1 1)
);

edges
(
);

boundary
(
    movingWall
    {
        type wall;
        faces
        (
            (3 7 6 2)
        );
    }

    fixedWalls
    {
        type wall;
        faces
        (
            (0 3 7 4)
            (0 4 5 1)
            (1 5 6 2)
        );
    }

    frontAndBack
    {
        type empty;
        faces
        (
            (0 1 2 3)
            (4 5 6 7)
        );
    }
);

mergePatchPairs
(
);

// ************************************************************************* //
`
    },
    {
      path: 'transportProperties',
      directory: 'constant',
      description: 'Fluid properties (viscosity)',
      content: `/*--------------------------------*- C++ -*----------------------------------*\\
| =========                 |                                                 |
| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |
|  \\\\    /   O peration     | Version:  dev                                   |
|   \\\\  /    A nd           | Web:      www.OpenFOAM.org                      |
|    \\\\/     M anipulation  |                                                 |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    location    "constant";
    object      transportProperties;
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

transportModel  Newtonian;

nu              [0 2 -1 0 0 0 0] 0.01;

// ************************************************************************* //
`
    },
    {
      path: 'turbulenceProperties',
      directory: 'constant',
      description: 'Turbulence settings',
      content: `/*--------------------------------*- C++ -*----------------------------------*\\
| =========                 |                                                 |
| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |
|  \\\\    /   O peration     | Version:  dev                                   |
|   \\\\  /    A nd           | Web:      www.OpenFOAM.org                      |
|    \\\\/     M anipulation  |                                                 |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    location    "constant";
    object      turbulenceProperties;
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

simulationType  laminar;

// ************************************************************************* //
`
    },
  ],
};

// Additional standalone file templates for custom cases
export const STANDALONE_FILE_TEMPLATES: FileTemplate[] = [
  // 0/ directory files
  {
    path: 'U',
    directory: '0',
    description: 'Velocity field (incompressible)',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       volVectorField;
    object      U;
}
dimensions      [0 1 -1 0 0 0 0];
internalField   uniform (0 0 0);
boundaryField
{
    inlet
    {
        type            fixedValue;
        value           uniform (1 0 0);
    }
    outlet
    {
        type            zeroGradient;
    }
    walls
    {
        type            noSlip;
    }
}`
  },
  {
    path: 'p',
    directory: '0',
    description: 'Pressure field (incompressible)',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      p;
}
dimensions      [0 2 -2 0 0 0 0];
internalField   uniform 0;
boundaryField
{
    inlet
    {
        type            zeroGradient;
    }
    outlet
    {
        type            fixedValue;
        value           uniform 0;
    }
    walls
    {
        type            zeroGradient;
    }
}`
  },
  {
    path: 'k',
    directory: '0',
    description: 'Turbulent kinetic energy (k-epsilon)',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      k;
}
dimensions      [0 2 -2 0 0 0 0];
internalField   uniform 0.375;
boundaryField
{
    inlet
    {
        type            fixedValue;
        value           uniform 0.375;
    }
    outlet
    {
        type            zeroGradient;
    }
    walls
    {
        type            kqRWallFunction;
        value           uniform 0.375;
    }
}`
  },
  {
    path: 'epsilon',
    directory: '0',
    description: 'Turbulent dissipation (k-epsilon)',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      epsilon;
}
dimensions      [0 2 -3 0 0 0 0];
internalField   uniform 14.855;
boundaryField
{
    inlet
    {
        type            fixedValue;
        value           uniform 14.855;
    }
    outlet
    {
        type            zeroGradient;
    }
    walls
    {
        type            epsilonWallFunction;
        value           uniform 14.855;
    }
}`
  },
  {
    path: 'omega',
    directory: '0',
    description: 'Specific dissipation rate (k-omega SST)',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      omega;
}
dimensions      [0 0 -1 0 0 0 0];
internalField   uniform 47.0363;
boundaryField
{
    inlet
    {
        type            fixedValue;
        value           uniform 47.0363;
    }
    outlet
    {
        type            zeroGradient;
    }
    walls
    {
        type            omegaWallFunction;
        value           uniform 47.0363;
    }
}`
  },
  {
    path: 'nut',
    directory: '0',
    description: 'Kinematic turbulent viscosity',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      nut;
}
dimensions      [0 2 -1 0 0 0 0];
internalField   uniform 0;
boundaryField
{
    inlet
    {
        type            calculated;
        value           uniform 0;
    }
    outlet
    {
        type            calculated;
        value           uniform 0;
    }
    walls
    {
        type            nutkWallFunction;
        value           uniform 0;
    }
}`
  },
  {
    path: 'p_rgh',
    directory: '0',
    description: 'Hydrostatic pressure (for buoyant solver)',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      p_rgh;
}
dimensions      [0 2 -2 0 0 0 0];
internalField   uniform 0;
boundaryField
{
    inlet
    {
        type            fixedValue;
        value           uniform 0;
    }
    outlet
    {
        type            zeroGradient;
    }
    walls
    {
        type            fixedFluxPressure;
        value           uniform 0;
    }
}`
  },
  {
    path: 'T',
    directory: '0',
    description: 'Temperature field (for heat transfer)',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      T;
}
dimensions      [0 0 0 1 0 0 0];
internalField   uniform 300;
boundaryField
{
    inlet
    {
        type            fixedValue;
        value           uniform 300;
    }
    outlet
    {
        type            zeroGradient;
    }
    walls
    {
        type            fixedValue;
        value           uniform 400;
    }
}`
  },
  {
    path: 'alpha.water',
    directory: '0',
    description: 'Water volume fraction (interFoam)',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      alpha.water;
}
dimensions      [0 0 0 0 0 0 0];
internalField   uniform 0;
boundaryField
{
    inlet
    {
        type            fixedValue;
        value           uniform 1;
    }
    outlet
    {
        type            zeroGradient;
    }
    walls
    {
        type            noSlip;
    }
}`
  },
  {
    path: 'phi',
    directory: '0',
    description: 'Mass flux (optional, automatically generated)',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       surfaceScalarField;
    object      phi;
}
dimensions      [0 3 -1 0 0 0 0];
internalField   uniform 0;
boundaryField
{
    inlet
    {
        type            fixedValue;
        value           uniform 0;
    }
    outlet
    {
        type            zeroGradient;
    }
    walls
    {
        type            fixedValue;
        value           uniform 0;
    }
}`
  },
  // system/ directory files
  {
    path: 'controlDict',
    directory: 'system',
    description: 'Main simulation controls',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      controlDict;
}
application     simpleFoam;
startFrom       latestTime;
startTime       0;
stopAt          endTime;
endTime         1000;
deltaT          1;
writeControl    timeStep;
writeInterval   100;
purgeWrite      0;
writeFormat     ascii;
writePrecision  6;
writeCompression uncompressed;
timeFormat      general;
timePrecision   6;
runTimeModifiable yes;

functions
{
    #includeEtc "caseDicts/postProcessing/graphs/sampleDict"
}`
  },
  {
    path: 'fvSchemes',
    directory: 'system',
    description: 'Complete discretization schemes',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      fvSchemes;
}
ddtSchemes
{
    default         Euler;
}
gradSchemes
{
    default         Gauss linear;
    grad(p)         Gauss linear;
    grad(U)         Gauss linear;
}
divSchemes
{
    default         none;
    div(phi,U)      Gauss upwind;
    div(phi,k)      Gauss upwind;
    div(phi,epsilon) Gauss upwind;
    div(phi,omega)  Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}
laplacianSchemes
{
    default         Gauss linear orthogonal;
    laplacian(nuEff,U) Gauss linear orthogonal;
    laplacian((1|A(U)),p) Gauss linear orthogonal;
    laplacian(DkEff,k) Gauss linear orthogonal;
    laplacian(DepsilonEff,epsilon) Gauss linear orthogonal;
    laplacian(DomegaEff,omega) Gauss linear orthogonal;
}
interpolationSchemes
{
    default         linear;
}
snGradSchemes
{
    default         orthogonal;
}
wallDist
{
    method meshWave;
}`
  },
  {
    path: 'fvSolution',
    directory: 'system',
    description: 'Solver and algorithms (simpleFoam with k-epsilon)',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      fvSolution;
}
solvers
{
    p
    {
        solver          PCG;
        preconditioner  DIC;
        tolerance       1e-06;
        relTol          0.01;
    }
    U
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-05;
        relTol          0.1;
    }
    k
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-05;
        relTol          0.1;
    }
    epsilon
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-05;
        relTol          0.1;
    }
}
SIMPLE
{
    nNonOrthogonalCorrectors 0;
    residualControl
    {
        p               1e-4;
        U               1e-4;
        k               1e-4;
        epsilon         1e-4;
    }
}
relaxationFactors
{
    fields
    {
        p               0.3;
    }
    equations
    {
        U               0.7;
        k               0.7;
        epsilon         0.7;
    }
}`
  },
  {
    path: 'decomposeParDict',
    directory: 'system',
    description: 'Decomposition for parallel computation',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      decomposeParDict;
}
numberOfSubdomains 4;
method          simple;
simpleCoeffs
{
    n               (2 2 1);
    delta           0.001;
}
hierarchicalCoeffs
{
    n               (2 2 1);
    delta           0.001;
    order           xyz;
}
scotchCoeffs
{
    processorWeights ( 1 1 1 1 );
}`
  },
  {
    path: 'snappyHexMeshDict',
    directory: 'system',
    description: 'snappyHexMesh configuration (meshing with STL)',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      snappyHexMeshDict;
}
castellatedMeshControls
{
    maxLocalCells   100000;
    maxGlobalCells  2000000;
    minRefinementCells 10;
    maxCellSize     0.5;
    nCellsBetweenLevels 3;
    features
    (
        //{
        //    file            "surfaceFeatureExtractDict";
        //    level           3;
        //}
    );
    refinementSurfaces
    {
        //{
        //    "geometry.stl"
        //    {
        //        level           (1 2);
        //        patchInfo
        //        {
        //            type            wall;
        //            inGroups        (wall);
        //        };
        //    }
        //}
    }
    resolveFeatureAngle 30;
    refinementRegions
    {
    }
    locationInMesh  (0 0 0);
    allowFreeStandingZoneFaces true;
}
snapControls
{
    nSmoothPatch    3;
    tolerance       2.0;
    nSolveIter      30;
    nRelaxIter      5;
    nFeatureSnapIter 10;
    implicitFeatureSnap false;
    explicitFeatureSnap true;
    multiRegionFeatureSnap false;
}
addLayersControls
{
    layers
    {
    };
    nGrow          0;
    relativeSizes  true;
    finalLayerThickness 0.3;
    firstLayerThickness 0.3;
    minThickness   0.1;
    nSmoothSurfaceNormals 1;
    nSmoothThickness 10;
    maxFaceThicknessRatio 0.5;
    maxThicknessToMedialRatio 0.3;
    minMedianAxisAngle 130;
    nBufferCellsNoExtrude 0;
    nLayerIter     50;
    nRelaxedIter   20;
}
meshQualityControls
{
    maxNonOrtho 65;
    maxSkewness 4;
    maxBoundarySkewness 20;
    maxInternalSkewness 4;
    maxConcave 80;
    minVol 1e-13;
    minTetQuality 1e-15;
    minArea -1;
    minTwist 0.02;
    minDeterminant 0.001;
    minFaceWeight 0.05;
    minVolRatio 0.01;
    minTriangleTwist -1;
    nSmoothScale 4;
    errorReduction 0.75;
    relaxed
    {
        maxNonOrtho 75;
    }
}
writeFlags
(
    scalarLevels
    layerSets
    layerFields
);
mergeTolerance 1e-6;`
  },
  {
    path: 'sampleDict',
    directory: 'system',
    description: 'Post-processing sampling configuration',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      sampleDict;
}
type            sets;
setFormat       raw;
sets
(
    lineX
    {
        type        uniform;
        axis        x;
        start       (0 0.05 0);
        end         (0.1 0.05 0);
        nPoints     100;
    }
);
fields          ( p U );
interpolationScheme cellPoint;`
  },
  {
    path: 'topoSetDict',
    directory: 'system',
    description: 'Topological set definition',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      topoSetDict;
}
actions
(
    {
        type            cellSet;
        name            inletCells;
        action          new;
        source          boxToCell;
        sourceInfo
        {
            box (-0.01 -0.01 -0.01) (0.01 0.01 0.01);
        }
    }
);`
  },
  // constant/ directory files
  {
    path: 'transportProperties',
    directory: 'constant',
    description: 'Fluid transport properties (incompressible)',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      transportProperties;
}
transportModel  Newtonian;
nu              [0 2 -1 0 0 0 0] 1e-6;
// nu for air: 1.5e-5, water: 1e-6`
  },
  {
    path: 'turbulenceProperties',
    directory: 'constant',
    description: 'Turbulence model (laminar)',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      turbulenceProperties;
}
simulationType  laminar;
// Options: laminar, RAS, LES
// For RAS add an RAS section with the model`
  },
  {
    path: 'turbulenceProperties (k-epsilon)',
    directory: 'constant',
    description: 'k-epsilon turbulence model',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      turbulenceProperties;
}
simulationType  RAS;
RAS
{
    RASModel        kEpsilon;
    turbulence      on;
    printCoeffs     on;
}`
  },
  {
    path: 'turbulenceProperties (k-omega SST)',
    directory: 'constant',
    description: 'k-omega SST turbulence model',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      turbulenceProperties;
}
simulationType  RAS;
RAS
{
    RASModel        kOmegaSST;
    turbulence      on;
    printCoeffs     on;
}`
  },
  {
    path: 'turbulenceProperties (LES)',
    directory: 'constant',
    description: 'LES turbulence model (Smagorinsky)',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      turbulenceProperties;
}
simulationType  LES;
LES
{
    LESModel        Smagorinsky;
    turbulence      on;
    printCoeffs     on;
    delta           cubeRootVol;
    cubeRootVolCoeffs
    {
        deltaCoeff      1;
    }
    SmagorinskyCoeffs
    {
        Ck              0.094;
        Cs              0.1643;
    }
}`
  },
  {
    path: 'g',
    directory: 'constant',
    description: 'Gravity vector',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       uniformDimensionedVector;
    object      g;
}
dimensions      [0 1 -2 0 0 0 0];
value           (0 0 -9.81);`
  },
  {
    path: 'MRFProperties',
    directory: 'constant',
    description: 'Multiple Reference Frame (for rotating zones)',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      MRFProperties;
}
MRF1
{
    active          true;
    cellZone        MRFZone;
    nonRotatingPatches (inlet outlet);
    origin          (0 0 0);
    axis            (0 0 1);
    omega           100;  // rad/s
}`
  },
  {
    path: 'thermophysicalProperties',
    directory: 'constant',
    description: 'Thermophysical properties (for compressible solvers)',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      thermophysicalProperties;
}
thermoType
{
    type            hePsiThermo;
    mixture         pureMixture;
    transport       const;
    thermo          hConst;
    equationOfState perfectGas;
    specie          specie;
    energy          sensibleEnthalpy;
}
mixture
{
    specie
    {
        molWeight   28.96;
    }
    transport
    {
        mu          1.8e-5;
        Pr          0.71;
    }
    thermodynamics
    {
        Cp          1007;
        Hf          0;
    }
}`
  },
  {
    path: 'turbulenceProperties (Spalart-Allmaras)',
    directory: 'constant',
    description: 'Spalart-Allmaras turbulence model',
    content: `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      turbulenceProperties;
}
simulationType  RAS;
RAS
{
    RASModel        SpalartAllmaras;
    turbulence      on;
    printCoeffs     on;
}`
  },
];
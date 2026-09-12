/**
 * Read-only, installation-aware case preflight for the File Editor.
 *
 * This is deliberately conservative. A finding is an error only when the
 * case structure, OpenFOAM's own parser/runtime tables, or a direct cross-file
 * comparison proves it. Anything affected by custom code, preprocessing or a
 * check that would require starting the solver is labelled unverified instead
 * of being guessed at.
 */

import {
  checkCaseDictSyntax,
  ensureFoamIndex,
  validateDictText,
  type FoamIndex,
  type SyntaxProblem,
} from './foam-index';
import {
  getCaseInfo,
  readCasePreflightFiles,
  validateBoundaryConditions,
  type BCValidationResult,
  type CaseFileSlice,
  type CasePreflightFiles,
} from './wsl';
import { entries, parseFieldFile, stripComments } from './wizard/foam-dict';

export type PreflightSeverity = 'error' | 'warning' | 'unverified';
export type PreflightStatus = 'pass' | PreflightSeverity;

export interface PreflightIssue {
  id: string;
  severity: PreflightSeverity;
  category: string;
  title: string;
  message: string;
  file?: string;
  line?: number | null;
  /** False when `file` is a suggested path that does not exist yet. */
  openable?: boolean;
  suggestion?: string;
}

export interface PreflightSection {
  id: string;
  title: string;
  status: PreflightStatus;
  summary: string;
}

export interface CasePreflightReport {
  caseName: string;
  version: string;
  checkedAt: string;
  durationMs: number;
  initialTime: string | null;
  filesInspected: number;
  dictionaryFilesParsed: number;
  meshPresent: boolean;
  counts: Record<PreflightSeverity, number>;
  sections: PreflightSection[];
  issues: PreflightIssue[];
  scope: string[];
}

export interface PreflightAnalysisInput {
  caseName: string;
  index: FoamIndex;
  inventory: CasePreflightFiles;
  directories: string[];
  meshPresent: boolean;
  syntax: SyntaxProblem[];
  syntaxAttempted: boolean;
  syntaxPaths: string[];
  syntaxCandidateCount: number;
  syntaxUnavailableReason?: string | null;
  boundary: BCValidationResult | null;
}

const CATEGORY = {
  structure: 'Case structure',
  syntax: 'OpenFOAM syntax',
  installation: 'Installed-version vocabulary',
  fields: 'Fields and boundaries',
  runtime: 'Runtime controls',
  parallel: 'Mesh and parallel setup',
  coverage: 'Coverage',
} as const;

function topEntries(file: CaseFileSlice | undefined) {
  return file ? entries(stripComments(file.content)) : [];
}

function valueOf(file: CaseFileSlice | undefined, key: string): string | null {
  const entry = topEntries(file).find(item => item.key === key);
  return entry ? entry.body.trim().replace(/^"|"$/g, '') : null;
}

function numeric(value: string | null): number | null {
  if (!value || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function basename(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1);
}

/** Files for which foamDictionary is an authoritative parser. */
export function isDictionaryCandidate(file: CaseFileSlice): boolean {
  if (/\.json$/i.test(file.path) || /^\s*#!/.test(file.content)) return false;
  if (/\bFoamFile\s*\{/.test(file.content)) return true;
  if (!/^(?:system|constant)\//.test(file.path)) return false;
  return /[;{}]|^\s*#include/m.test(file.content);
}

function worstStatus(issues: PreflightIssue[]): PreflightStatus {
  if (issues.some(issue => issue.severity === 'error')) return 'error';
  if (issues.some(issue => issue.severity === 'warning')) return 'warning';
  if (issues.some(issue => issue.severity === 'unverified')) return 'unverified';
  return 'pass';
}

function sectionFor(id: keyof typeof CATEGORY, issues: PreflightIssue[], passSummary: string): PreflightSection {
  const own = issues.filter(issue => issue.category === CATEGORY[id]);
  const status = worstStatus(own);
  return {
    id,
    title: CATEGORY[id],
    status,
    summary: status === 'pass'
      ? passSummary
      : `${own.length} finding${own.length === 1 ? '' : 's'} to review`,
  };
}

/** Pure semantic/cross-file analysis, kept separate for exhaustive fixtures. */
export function analyzeCasePreflight(input: PreflightAnalysisInput): Omit<CasePreflightReport, 'checkedAt' | 'durationMs'> {
  const {
    caseName, index, inventory, directories, meshPresent, syntax,
    syntaxAttempted, syntaxPaths, syntaxCandidateCount, syntaxUnavailableReason, boundary,
  } = input;
  const issues: PreflightIssue[] = [];
  let serial = 0;
  const add = (issue: Omit<PreflightIssue, 'id'>) => {
    issues.push({ ...issue, id: `preflight-${++serial}` });
  };
  const fileMap = new Map(inventory.files.map(file => [file.path, file]));
  const findNamed = (name: string, root: 'system' | 'constant' = 'system') =>
    inventory.files.find(file => file.path === `${root}/${name}` || file.path.startsWith(`${root}/`) && basename(file.path) === name);
  const control = fileMap.get('system/controlDict');
  const major = Number.parseInt(index.version, 10);
  const hasCustomRuntime = inventory.files.some(file =>
    /\blibs\s*\([^)]*\)|#codeStream|\bcode(?:Include|Options|Libs|Execute|Write|End)\b|\btype\s+coded[A-Za-z]*/.test(file.content));

  // ── Structure ───────────────────────────────────────────────────────────
  if (!control) {
    add({ severity: 'error', category: CATEGORY.structure, title: 'controlDict is missing',
      message: 'A simulation cannot select its application/module or time controls without system/controlDict.',
      file: 'system/controlDict', openable: false, suggestion: 'Create or restore system/controlDict.' });
  }
  if (!findNamed('fvSchemes')) {
    add({ severity: 'warning', category: CATEGORY.structure, title: 'fvSchemes is missing',
      message: 'No discretisation dictionary was found in system/ or a region subdirectory.',
      file: 'system/fvSchemes', openable: false, suggestion: 'Add the fvSchemes required by the selected solver or module.' });
  }
  if (!findNamed('fvSolution')) {
    add({ severity: 'warning', category: CATEGORY.structure, title: 'fvSolution is missing',
      message: 'No linear-solver and algorithm dictionary was found in system/ or a region subdirectory.',
      file: 'system/fvSolution', openable: false, suggestion: 'Add the fvSolution required by the selected solver or module.' });
  }
  if (!inventory.initialTime) {
    add({ severity: 'error', category: CATEGORY.structure, title: 'Initial time directory is missing',
      message: 'No numeric directory (for example 0/ or -180/) exists from which OpenFOAM can read initial fields.',
      suggestion: 'Create the case initial-time directory and its required fields.' });
  }
  if (inventory.inventoryTruncated) {
    add({ severity: 'unverified', category: CATEGORY.coverage, title: 'File inventory was bounded',
      message: `${inventory.totalFiles} configuration files were found; only the first 200 were considered.`,
      suggestion: 'Reduce generated/configuration clutter and run the preflight again.' });
  }
  for (const skipped of inventory.skipped) {
    const reason = skipped.reason === 'large' ? `larger than 128 KB (${skipped.bytes.toLocaleString()} bytes)`
      : skipped.reason === 'binary' ? 'binary or compressed' : 'a symbolic link';
    add({ severity: 'unverified', category: CATEGORY.coverage, title: 'File not inspected',
      message: `${skipped.path} is ${reason}; its contents were not inferred.`, file: skipped.path,
      suggestion: skipped.reason === 'symlink' ? 'Inspect the link target manually.' : 'Use OpenFOAM’s own utility for this file type.' });
  }

  // ── Syntax from the selected installation's parser ──────────────────────
  for (const problem of syntax) {
    const parserTimedOut = /timed?\s*out/i.test(problem.message);
    const unclassified = /unclassified parser failure/i.test(problem.message);
    const includeFailure = /include|cannot find|cannot open/i.test(problem.message);
    const notProof = parserTimedOut || unclassified || includeFailure;
    add({
      severity: notProof ? 'unverified' : 'error',
      category: CATEGORY.syntax,
      title: parserTimedOut
        ? 'Parser check timed out'
        : unclassified ? 'Parser process did not provide a conclusive diagnostic'
          : includeFailure ? 'Included content could not be resolved' : 'OpenFOAM rejected the file syntax',
      message: problem.message,
      file: problem.path,
      line: problem.line,
      suggestion: parserTimedOut
        ? 'Inspect this file manually or simplify its preprocessor work before running preflight again.'
        : unclassified ? 'Run foamDictionary manually for this file if a conclusive parser result is required.'
          : includeFailure ? 'Check the include path and any environment variable it uses.'
            : 'Open the file at the reported line and correct the parser error.',
    });
  }
  if (!syntaxAttempted) {
    add({ severity: 'unverified', category: CATEGORY.syntax, title: 'Parser check was not completed',
      message: syntaxUnavailableReason || 'The selected installation’s foamDictionary parser did not complete, so syntax was not inferred.',
      suggestion: syntaxUnavailableReason
        ? 'Review the dynamic directive manually; preflight will not execute generated code.'
        : 'Verify that WSL and the selected OpenFOAM installation are available, then run the preflight again.' });
  } else if (syntaxCandidateCount > syntaxPaths.length) {
    add({ severity: 'unverified', category: CATEGORY.syntax, title: 'Parser pass was bounded',
      message: `${syntaxCandidateCount} dictionary candidates were found; the first ${syntaxPaths.length} were parsed to keep preflight short.`,
      suggestion: 'Inspect the remaining generated or unusually fragmented dictionaries manually.' });
  }

  // ── Installation-derived runtime names ──────────────────────────────────
  if (!index.hasToC) {
    add({ severity: 'unverified', category: CATEGORY.installation, title: 'Runtime vocabulary is not enumerable on this version',
      message: `OpenFOAM ${index.version} does not provide foamToC, so application presence is checked but runtime-selected types cannot be exhaustively enumerated.`,
      suggestion: 'Treat type/model findings as requiring runtime confirmation on OpenFOAM 9–10.' });
  } else {
    for (const file of inventory.files.filter(isDictionaryCandidate)) {
      for (const problem of validateDictText(index, file.content, file.path)) {
        add({
          severity: 'unverified',
          category: CATEGORY.installation,
          title: hasCustomRuntime ? 'Name absent from the base installation catalogue' : 'Name absent from the selected installation catalogue',
          message: `${problem.name} is not registered for ${problem.where}.`,
          file: file.path,
          suggestion: problem.suggestions.length
            ? `Closest installed names: ${problem.suggestions.join(', ')}.`
            : hasCustomRuntime ? 'Confirm that the case library registers this type.' : 'Choose a type provided by the selected installation.',
        });
      }
    }
  }
  if (hasCustomRuntime) {
    add({ severity: 'unverified', category: CATEGORY.installation, title: 'Custom runtime code is present',
      message: 'The case loads libraries or coded entries whose registrations and behaviour exist only after compilation/loading.',
      suggestion: 'The preflight validates the surrounding dictionaries but does not execute custom code.' });
  }

  const selectedKey = major >= 11 ? 'solver' : 'application';
  const selected = valueOf(control, selectedKey);
  if (control && !selected) {
    add({ severity: 'error', category: CATEGORY.runtime, title: `${selectedKey} is not selected`,
      message: `OpenFOAM ${index.version} expects a top-level ${selectedKey} entry in system/controlDict.`,
      file: 'system/controlDict', suggestion: `Set ${selectedKey} to a module/application supplied by this installation.` });
  } else if (selected) {
    const installed = major >= 11
      ? index.solvers.includes(selected)
      : index.applications.some(application => application.name === selected);
    if (!installed) {
      add({ severity: 'unverified', category: CATEGORY.runtime,
        title: `${selected} was not found in the selected installation`,
        message: `${selectedKey} ${selected} is absent from the OpenFOAM ${index.version} catalogue.`,
        file: 'system/controlDict',
        suggestion: hasCustomRuntime ? 'Confirm that a case library supplies it.' : 'Confirm any user-installed executable/module, or select a catalogued one.' });
    }
  }

  // ── Runtime controls ────────────────────────────────────────────────────
  if (control) {
    for (const key of ['startFrom', 'stopAt', 'endTime', 'deltaT', 'writeControl', 'writeInterval']) {
      if (valueOf(control, key) === null) {
        add({ severity: 'warning', category: CATEGORY.runtime, title: `${key} is missing`,
          message: `system/controlDict has no top-level ${key} entry.`, file: 'system/controlDict',
          suggestion: `Add ${key} using a value appropriate for this simulation.` });
      }
    }
    for (const [key, allowZero] of [['deltaT', false], ['writeInterval', false], ['purgeWrite', true]] as const) {
      const raw = valueOf(control, key);
      if (raw === null) continue;
      const parsed = numeric(raw);
      if (parsed === null) {
        if (/[$#]/.test(raw)) add({ severity: 'unverified', category: CATEGORY.runtime, title: `${key} is computed`,
          message: `${key} uses an expansion or directive (${raw}) that static analysis does not evaluate.`, file: 'system/controlDict' });
      } else if (parsed < 0 || (!allowZero && parsed === 0)) {
        add({ severity: 'error', category: CATEGORY.runtime, title: `${key} is not usable`,
          message: `${key} is ${raw}; it must be ${allowZero ? 'zero or positive' : 'positive'}.`, file: 'system/controlDict',
          suggestion: `Set ${key} to a ${allowZero ? 'non-negative' : 'positive'} value.` });
      }
    }
    const startFrom = valueOf(control, 'startFrom');
    const startTime = numeric(valueOf(control, 'startTime'));
    const endTime = numeric(valueOf(control, 'endTime'));
    if (startFrom === 'startTime' && startTime !== null && endTime !== null && endTime <= startTime) {
      add({ severity: 'warning', category: CATEGORY.runtime, title: 'The run interval is empty',
        message: `endTime (${endTime}) is not greater than startTime (${startTime}).`, file: 'system/controlDict',
        suggestion: 'Increase endTime or choose a different start time.' });
    }
  }

  // ── Initial fields and their mesh coverage ──────────────────────────────
  const initialPrefix = inventory.initialTime ? `${inventory.initialTime}/` : '';
  const fields = inventory.files.filter(file => initialPrefix && file.path.startsWith(initialPrefix))
    .map(file => ({ file, parsed: parseFieldFile(file.content) }))
    .filter(item => item.parsed !== null);
  if (inventory.initialTime && fields.length === 0) {
    const skippedInitial = inventory.skipped.some(file => file.path.startsWith(initialPrefix));
    add({ severity: skippedInitial ? 'unverified' : 'error', category: CATEGORY.fields, title: 'No readable initial fields were found',
      message: `${inventory.initialTime}/ contains no text field with a boundaryField dictionary.`,
      suggestion: 'Add the fields required by the selected solver or inspect any binary/large fields reported below.' });
  }
  for (const { file, parsed } of fields) {
    const object = parsed!.object;
    const name = basename(file.path);
    if (object && object !== name) {
      add({ severity: 'warning', category: CATEGORY.fields, title: 'Field object and file name differ',
        message: `The FoamFile object is ${object}, while the file is named ${name}.`, file: file.path,
        suggestion: 'Confirm that the solver is meant to look up this field under the declared object name.' });
    }
  }
  if (boundary) {
    if (!boundary.success) {
      add({ severity: 'unverified', category: CATEGORY.fields, title: 'Boundary checker did not complete',
        message: 'The fast boundary-condition pass returned without a complete result.',
        suggestion: 'Confirm that the mesh and initial fields are readable, then run preflight again.' });
    }
    for (const warning of boundary.warnings) {
      const skipped = /not checked|skipped|preprocessor|no mesh/i.test(warning);
      add({ severity: skipped ? 'unverified' : 'warning', category: CATEGORY.fields,
        title: skipped ? 'Boundary coverage is incomplete' : 'Boundary-condition warning', message: warning,
        suggestion: skipped ? 'Resolve the stated prerequisite and run the preflight again.' : 'Review the referenced initial field.' });
    }
    for (const field of boundary.fields) {
      for (const patch of field.patches.filter(patch => !patch.valid)) {
        add({ severity: 'error', category: CATEGORY.fields, title: `Boundary entry does not match the mesh`,
          message: `${field.name}: ${patch.patch} — ${patch.note || 'invalid boundary entry'}.`,
          file: `0/${field.name}`, suggestion: 'Add, rename or remove the boundaryField entry so every mesh patch is covered exactly as intended.' });
      }
    }
  } else if (inventory.initialTime && inventory.initialTime !== '0') {
    add({ severity: 'unverified', category: CATEGORY.fields, title: 'Boundary-to-mesh matching was not run',
      message: `The initial time is ${inventory.initialTime}; the fast boundary checker currently reads 0/ only.`,
      suggestion: 'Inspect the initial fields and mesh patches manually.' });
  }

  // ── Mesh and decomposition ──────────────────────────────────────────────
  if (!meshPresent) {
    const hasMeshRecipe = Boolean(fileMap.get('system/blockMeshDict') || fileMap.get('system/snappyHexMeshDict'));
    add({ severity: hasMeshRecipe ? 'warning' : 'unverified', category: CATEGORY.parallel,
      title: 'No reconstructed mesh is present',
      message: hasMeshRecipe
        ? 'A mesh dictionary exists, but constant/polyMesh is not present yet.'
        : 'constant/polyMesh is absent and no supported mesh recipe was found in system/.',
      suggestion: hasMeshRecipe ? 'Build the mesh, then rerun preflight for boundary matching.' : 'Provide or generate the mesh before solving.' });
  } else {
    add({ severity: 'unverified', category: CATEGORY.parallel, title: 'Mesh quality was not executed',
      message: 'The mesh exists and boundary coverage can be checked, but this fast preflight deliberately does not run checkMesh.',
      suggestion: 'Use “Run checkMesh” in the Mesh tab when a quality assessment is required.' });
  }

  const decomposition = findNamed('decomposeParDict');
  const processorCount = directories.filter(directory => /^processor\d+$/.test(directory)).length;
  if (decomposition) {
    const raw = valueOf(decomposition, 'numberOfSubdomains');
    const count = numeric(raw);
    if (count === null || !Number.isInteger(count) || count < 1) {
      add({ severity: 'error', category: CATEGORY.parallel, title: 'Invalid decomposition size',
        message: `numberOfSubdomains is ${raw ?? 'missing'}; decomposePar requires a positive integer.`,
        file: decomposition.path, suggestion: 'Set numberOfSubdomains to a positive MPI rank count.' });
    } else if (processorCount > 0 && processorCount !== count) {
      add({ severity: 'warning', category: CATEGORY.parallel, title: 'Existing processor directories do not match the dictionary',
        message: `${processorCount} processor directories exist, while numberOfSubdomains is ${count}.`,
        file: decomposition.path, suggestion: 'Re-decompose the case before the next parallel run.' });
    }
    if (!valueOf(decomposition, 'method')) {
      add({ severity: 'error', category: CATEGORY.parallel, title: 'Decomposition method is missing',
        message: 'decomposeParDict has no top-level method entry.', file: decomposition.path,
        suggestion: 'Choose an installed decomposition method such as scotch.' });
    }
  } else if (processorCount > 0) {
    add({ severity: 'warning', category: CATEGORY.parallel, title: 'Decomposed data has no decomposeParDict',
      message: `${processorCount} processor directories exist, but the decomposition settings are not recorded in system/decomposeParDict.`,
      suggestion: 'Restore the dictionary before decomposing or changing the MPI size.' });
  }

  const sections = [
    sectionFor('structure', issues, `${inventory.initialTime ?? 'No'} initial time; core dictionaries found`),
    sectionFor('syntax', issues, `${syntaxPaths.length} dictionaries accepted by OpenFOAM ${index.version}`),
    sectionFor('installation', issues, index.hasToC ? 'Runtime-selected names exist in this installation' : 'Executable catalogue checked'),
    sectionFor('fields', issues, boundary?.meshChecked ? `${fields.length} fields compared with ${boundary.meshPatches.length} mesh patches` : `${fields.length} initial fields inspected`),
    sectionFor('runtime', issues, selected ? `${selectedKey} ${selected}; time controls are coherent` : 'Runtime controls inspected'),
    sectionFor('parallel', issues, decomposition ? 'Mesh presence and decomposition settings inspected' : 'Mesh presence inspected'),
    sectionFor('coverage', issues, `${inventory.files.length} bounded text files inspected`),
  ];

  const counts: Record<PreflightSeverity, number> = { error: 0, warning: 0, unverified: 0 };
  for (const issue of issues) counts[issue.severity]++;
  return {
    caseName,
    version: index.version,
    initialTime: inventory.initialTime,
    filesInspected: inventory.files.length,
    dictionaryFilesParsed: syntaxAttempted ? syntaxPaths.length : 0,
    meshPresent,
    counts,
    sections,
    issues,
    scope: [
      'Uses the selected OpenFOAM installation’s parser, runtime-selection tables and executable catalogue.',
      'Reads configuration and initial fields only; it does not create a case copy in $FOAM_RUN.',
      'Does not start a solver, mesher, checkMesh, custom library or coded entry.',
      'Physical suitability, convergence and behaviour reached only during later timesteps remain runtime questions.',
    ],
  };
}

/** Run the bounded read-only checks and assemble their honest coverage report. */
export async function runCasePreflight(caseName: string): Promise<CasePreflightReport> {
  const started = Date.now();
  const index = await ensureFoamIndex();
  if (!index) throw new Error('The selected OpenFOAM installation catalogue could not be built.');
  const major = Number.parseInt(index.version, 10);
  if (!Number.isInteger(major) || major < 9 || major > 14) {
    throw new Error(`OpenFOAM ${index.version || 'unknown'} is outside the supported Foundation versions 9–14.`);
  }

  const inventory = readCasePreflightFiles(caseName);
  const info = getCaseInfo(caseName);
  if (!info.exists) throw new Error(`Case "${caseName}" was not found.`);
  const constantItems = info.files.constant || [];
  const meshPresent = constantItems.some(item => item.isDir && item.name === 'polyMesh');
  const syntaxCandidates = inventory.files.filter(isDictionaryCandidate);
  // Starting one OpenFOAM parser per file is the only potentially noticeable
  // phase. Keep it strictly bounded; excess candidates are reported as
  // unverified rather than making the user wait on a hidden temporary tree.
  const syntaxFiles = syntaxCandidates.slice(0, 80);
  const dynamicDirectives = inventory.files.filter(file => /#(?:codeStream|calc)\b/.test(file.content));
  let syntax: SyntaxProblem[] = [];
  let syntaxAttempted = dynamicDirectives.length === 0;
  let syntaxUnavailableReason: string | null = dynamicDirectives.length
    ? `Syntax parsing was skipped because ${dynamicDirectives.map(file => file.path).slice(0, 3).join(', ')} contains #codeStream or #calc; preflight never compiles or executes case code.`
    : null;
  if (syntaxAttempted) {
    try {
      syntax = await checkCaseDictSyntax(inventory.files, syntaxFiles.map(file => file.path));
    } catch {
      syntaxAttempted = false;
      syntaxUnavailableReason = null;
    }
  }

  let boundary: BCValidationResult | null = null;
  if (inventory.initialTime === '0') {
    boundary = validateBoundaryConditions(caseName);
  }
  const report = analyzeCasePreflight({
    caseName,
    index,
    inventory,
    directories: info.directories,
    meshPresent,
    syntax,
    syntaxAttempted,
    syntaxPaths: syntaxFiles.map(file => file.path),
    syntaxCandidateCount: syntaxCandidates.length,
    syntaxUnavailableReason,
    boundary,
  });
  return { ...report, checkedAt: new Date().toISOString(), durationMs: Date.now() - started };
}

import path from 'path';
import { CASE_NAME_PATTERN } from './case-name';

export class WslInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WslInputError';
  }
}

export function validateCaseName(value: string): string {
  if (typeof value !== 'string' || !value) {
    throw new WslInputError('Case name required');
  }
  // The pattern lives in ./case-name so the wizard's preflight can apply exactly
  // this rule in the browser; it used to carry a looser one of its own and
  // approved names the server then refused. (`.` and `..` cannot match it — both
  // start with a dot — but the check is kept as a guard that reads locally.)
  if (!CASE_NAME_PATTERN.test(value) || value === '.' || value === '..') {
    throw new WslInputError('Invalid case name: use letters, numbers, dot, dash or underscore');
  }
  return value;
}

export function validateRelativePath(value: string, label = 'Path', allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value)) {
    throw new WslInputError(`${label} required`);
  }
  if (value.length > 1024 || value.includes('\\') || /[\0\r\n]/.test(value) || path.posix.isAbsolute(value)) {
    throw new WslInputError(`${label} invalid`);
  }

  if (allowEmpty && value === '') return '';
  const segments = value.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new WslInputError(`${label} must remain within the case`);
  }
  return segments.join('/');
}

export function validatePathWithin(basePath: string, candidatePath: string, label: string): string {
  if (typeof candidatePath !== 'string' || !candidatePath || /[\0\r\n]/.test(candidatePath)) {
    throw new WslInputError(`${label} invalid`);
  }

  const normalizedBase = path.posix.normalize(basePath).replace(/\/$/, '');
  const normalizedCandidate = path.posix.normalize(candidatePath);
  if (!path.posix.isAbsolute(normalizedBase) || !path.posix.isAbsolute(normalizedCandidate)) {
    throw new WslInputError(`${label} invalid`);
  }
  if (normalizedCandidate === normalizedBase || !normalizedCandidate.startsWith(`${normalizedBase}/`)) {
    throw new WslInputError(`${label} outside the tutorial directory`);
  }
  return normalizedCandidate;
}

export function validateLogName(value: string): string {
  if (value === 'log') return value;
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u.test(value)) {
    throw new WslInputError('Invalid log name');
  }
  return value;
}

export function validatePid(value: string): string {
  if (!/^[1-9]\d{0,9}$/.test(value)) {
    throw new WslInputError('Invalid PID');
  }
  return value;
}

export function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  // "Not supplied" has to reach `fallback`, and the obvious version of this did
  // not. `URLSearchParams.get()` answers `null` for a parameter that is absent,
  // `Number(null)` is 0, and 0 is finite — so an absent `?tail=` clamped to
  // `min` and returned ONE line of a log where the caller had asked for the
  // default hundred. The same held for an empty value (`?tail=`), for `[]`, and
  // for `false`. Only a number or a non-blank string is an answer; everything
  // else means the caller said nothing.
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/**
 * Does a command ARGUMENT stay inside the run directory?
 *
 * Used by the agent policy, which cannot judge an argument by its spelling. The
 * first attempt banned `..` outright and took out every two-case utility —
 * `mapFields ../coarse`, `foamCloneCase ../pitzDaily myCase` — although a
 * sibling case is inside $FOAM_RUN and the agent may already read and write it.
 * Resolving the token answers the question that actually matters.
 *
 * Pure and dependency-free so it can be tested; the caller supplies the two
 * directories.
 */
export function argumentStaysInside(token: string, casePath: string, runDir: string): boolean {
  if (!runDir.startsWith('/') || !casePath.startsWith('/')) return false;
  const base = path.posix.normalize(runDir).replace(/\/+$/, '');
  const resolved = token.startsWith('/')
    ? path.posix.normalize(token)
    : path.posix.normalize(`${casePath}/${token}`);
  return resolved === base || resolved.startsWith(`${base}/`);
}

/** Only tokens that could denote a path are worth resolving. */
export function looksLikePath(token: string): boolean {
  return token.startsWith('/') || token.includes('/') || token === '..' || token === '.';
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Files that live in 0/ but are not physical fields.
 *
 * The boundary-condition check used to validate EVERY regular file in 0/, and
 * the meshing tools put their own bookkeeping there. On a real snappyHexMesh
 * case (`combustor`) that meant five of the twelve entries were not physics at
 * all: `cellLevel` and `pointLevel` are the refinement level of each cell and
 * point, and `nSurfaceLayers`, `thickness` and `thicknessFraction` are what the
 * layer-addition stage wrote about the boundary layers it managed to insert.
 *
 * They LOOK like fields — `cellLevel` is a `volScalarField` with a
 * `boundaryField` — so neither the class nor the presence of boundary entries
 * can tell them apart; only the name can. (Their `dimensions []` is empty, which
 * corroborates it but is not something to rely on: several genuine fields are
 * dimensionless too.)
 *
 * Reporting them was worse than useless: they are written by the mesher with
 * `calculated` or `zeroGradient` on every patch, so they either padded the
 * report with rows the user cannot act on, or — when the mesher had not touched
 * a patch — raised complaints about a field nobody configured.
 */
const NON_PHYSICAL_ZERO_FILES = new Set([
  // snappyHexMesh — refinement
  'cellLevel', 'pointLevel', 'surfaceIndex',
  // snappyHexMesh — layer addition
  'nSurfaceLayers', 'thickness', 'thicknessFraction',
  // decomposePar -cellDist, and mesh motion
  'cellDist', 'meshPhi',
]);

/**
 * Is this 0/ entry a field whose boundary conditions are worth checking?
 *
 * Also drops the editor and tutorial debris that collects in a case directory —
 * `U.orig` is in a great many of the shipped tutorials, and validating a backup
 * copy of a field reports the same problems twice.
 */
export function isPhysicalFieldFile(name: string): boolean {
  if (!name || name.startsWith('.')) return false;
  if (NON_PHYSICAL_ZERO_FILES.has(name)) return false;
  // Backups and editor leftovers.
  if (/(^|\.)(orig|bak|old|save|swp|tmp)$/i.test(name)) return false;
  if (name.endsWith('~')) return false;
  return true;
}

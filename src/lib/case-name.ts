/**
 * What a case may be called — one definition, shared by both sides.
 *
 * This exists because there used to be two, and they disagreed in BOTH
 * directions. The wizard's preflight tested `/^[A-Za-z0-9._-]+$/`, while the
 * server's validateCaseName tests `/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u`,
 * so:
 *
 *   - `.hidden`, `-rf` and `_tmp` passed the wizard's check and were then
 *     rejected by the server at the moment of creation, after six steps of
 *     configuration, with a message about a name the wizard had just approved;
 *   - `café` was refused by the wizard although the server accepts it and the
 *     run directory is a Linux filesystem that has no trouble with it;
 *   - a 200-character name passed the wizard and was rejected by the server.
 *
 * The rule itself is the server's, because the server's is the one that decides.
 * A name must start with a letter or a digit — a leading dash would be read as
 * an option by the commands the name is interpolated into, and a leading dot
 * hides the case from every listing the app makes — and may then contain
 * letters, digits, dot, dash and underscore, up to 128 characters in total.
 *
 * This module deliberately imports NOTHING: it is pulled into the browser
 * bundle by the wizard, and `src/lib/wsl-input.ts` (which imports `path`) is
 * server-only.
 */

/** Longest a case name may be, in characters. */
export const CASE_NAME_MAX_LENGTH = 128;

/** The single pattern. Unicode-aware: the run directory is a Linux filesystem. */
export const CASE_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u;

export function isValidCaseName(value: unknown): value is string {
  return typeof value === 'string' && CASE_NAME_PATTERN.test(value);
}

/**
 * Why a name is unacceptable, phrased for a person, or null if it is fine.
 *
 * Split out from the boolean so the wizard can say which rule was broken
 * instead of repeating one catch-all sentence for five different mistakes.
 */
export function caseNameProblem(value: string): string | null {
  if (!value) return 'The case has no name.';
  if (value.length > CASE_NAME_MAX_LENGTH) {
    return `The name is ${value.length} characters; the limit is ${CASE_NAME_MAX_LENGTH}.`;
  }
  if (/[/\\]/.test(value)) return 'The name is a single folder name, so it cannot contain a slash. Choose the container separately.';
  if (/\s/.test(value)) return 'The name cannot contain spaces.';
  if (!/^[\p{L}\p{N}]/u.test(value)) {
    return 'The name must start with a letter or a number — not a dot, dash or underscore.';
  }
  if (!CASE_NAME_PATTERN.test(value)) {
    return 'The name may only contain letters, numbers, dot, dash and underscore.';
  }
  return null;
}

/**
 * Containers: a folder in the run directory that groups cases.
 *
 * A case is addressed by a CASE REFERENCE: its folder name when it sits
 * directly in the run directory (`cavity`), or `container/case` when it sits
 * in a container (`wing/cavity`). One level only — a container holds cases,
 * never another container — so a reference has one or two segments, and each
 * segment obeys the single-folder rule above.
 *
 * What makes a folder a container is the user saying so: the app writes
 * `CASE_CONTAINER_MARKER` into it. Nothing is inferred from its contents, so a
 * folder is never taken for the wrong thing. A folder without the marker is a
 * case, as every folder was before containers existed.
 */
export const CASE_CONTAINER_MARKER = '.ofstudio-container';

export interface CaseRef {
  /** The container's folder name, or null for a case directly in the run directory. */
  container: string | null;
  /** The case's own folder name. */
  name: string;
}

/** Split a case reference into its parts, or null if it is not a valid one. */
export function parseCaseRef(value: unknown): CaseRef | null {
  if (typeof value !== 'string' || !value) return null;
  const segments = value.split('/');
  if (segments.length > 2 || !segments.every(isValidCaseName)) return null;
  return segments.length === 2
    ? { container: segments[0], name: segments[1] }
    : { container: null, name: segments[0] };
}

/** The reference of the case `name` in `container` (empty or null: the run directory). */
export function joinCaseRef(container: string | null | undefined, name: string): string {
  return container ? `${container}/${name}` : name;
}

/** A case reference as part of a file name: `wing/cavity` becomes `wing-cavity`. */
export function caseFileStem(ref: string): string {
  return ref.split('/').join('-');
}

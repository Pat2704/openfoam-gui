/**
 * Which running OpenFOAM processes belong to a case.
 *
 * A process belongs to the case when its working directory is the case
 * directory (runDir/caseName). The match is on the path tail so the client does
 * not need to know runDir. A process with no cwd (older backend, readlink
 * denied) is never counted for the case: it stays "unknown" rather than
 * producing a false RUNNING badge.
 *
 * Shared by the Monitor, which shows the processes, and the File Editor, which
 * refuses to delete timesteps while the case's solver is writing them.
 */
export function isProcessForCase(p: { cwd?: string }, caseName: string): boolean {
  if (!p.cwd || !caseName) return false;
  const cwd = p.cwd.replace(/\/+$/, '');
  // The case dir itself, anything ending in /<caseName> (e.g. run/cavity), or
  // anything UNDER it (run/cavity/processor0: each parallel rank keeps its cwd
  // in a processor subdir).
  return cwd === caseName
    || cwd.endsWith('/' + caseName)
    || cwd.includes('/' + caseName + '/');
}

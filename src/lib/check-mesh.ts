/**
 * Reading checkMesh's report.
 *
 * The formats are the ones checkMesh prints on OpenFOAM 13 and 14 (from its
 * sources), and the old parser matched none of them, so statistics and issues
 * were always empty and a failing mesh showed a red banner with no reason:
 *
 *   - a failed check starts with " ***"   (" ***Max skewness = 5.3, …")
 *   - a warning starts with spaces and one "*"   ("   *Number of severely …")
 *   - the statistics are a "Mesh stats" block of "    key:   value" lines
 *   - "Overall domain bounding box (…) (…)" carries no "="
 *   - there is one verdict per mesh time checked ("Mesh OK." or
 *     "Failed N mesh checks."); the last one describes the current mesh, and the
 *     statistics and issues are those of that last report.
 */

export interface CheckMeshReport {
  overallStats: { key: string; value: string }[];
  failedChecks: { severity: 'fail' | 'warning'; message: string }[];
  meshOk: boolean;
  /** Whether a verdict line was printed at all (checkMesh got to judge). */
  verdictFound: boolean;
}

export function parseCheckMeshOutput(raw: string): CheckMeshReport {
  let overallStats: CheckMeshReport['overallStats'] = [];
  let failedChecks: CheckMeshReport['failedChecks'] = [];
  let inStats = false;
  let verdict: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (/^<<Writing/.test(line)) continue;

    if (/^\s*Mesh stats\s*$/.test(line)) {
      // A new report (one per mesh time): only the last one counts.
      overallStats = [];
      failedChecks = [];
      inStats = true;
      continue;
    }
    if (inStats) {
      const stat = line.match(/^\s+([A-Za-z][A-Za-z ]*?):\s+(\S.*)$/);
      if (stat) {
        overallStats.push({ key: stat[1].trim(), value: stat[2].trim() });
        continue;
      }
      inStats = false;
    }

    const bbox = line.match(/^\s*Overall domain bounding box\s+(.+)$/);
    if (bbox) {
      overallStats.push({ key: 'domain bounding box', value: bbox[1].trim() });
      continue;
    }
    const fail = line.match(/^\s*\*\*\*\s*(.+)$/);
    if (fail) {
      failedChecks.push({ severity: 'fail', message: fail[1].trim() });
      continue;
    }
    const warn = line.match(/^\s+\*(?!\*)\s*(.+)$/);
    if (warn) {
      failedChecks.push({ severity: 'warning', message: warn[1].trim() });
      continue;
    }
    const v = line.match(/^\s*(Mesh OK\.|Failed \d+ mesh checks?\.)/);
    if (v) verdict = v[1];
  }

  return {
    overallStats,
    failedChecks,
    meshOk: verdict !== null
      ? verdict.startsWith('Mesh OK')
      : !failedChecks.some(c => c.severity === 'fail'),
    verdictFound: verdict !== null,
  };
}

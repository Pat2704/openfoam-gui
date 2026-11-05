/**
 * The agent's read-only analysis of a case: its solver log, its time
 * directories (processor ones included), its postProcessing output and its
 * mesh.
 *
 * Each function runs one of the streaming scripts from ./case-digest in WSL
 * and returns the digest text. The scripts go through the ASYNC base64 runner:
 * a log or a large decomposed field set takes seconds to stream, and the
 * synchronous runner would hold every other request of the app for that long.
 * Nothing here writes to the case, except checkMesh when the caller asks for
 * the quality check (it records failing cells in polyMesh/sets).
 */

import {
  foamSource,
  getCasePath,
  listPostProcessing,
  readPostProcessDataset,
  runInWslScriptAsync,
  validateBoundaryConditions,
} from './wsl';
import { shellQuote, validateLogName, WslInputError } from './wsl-input';
import { parseCheckMeshOutput } from './check-mesh';
import { isTimeSeries, mergeRestarts, parseFoamTable, summarizeColumn } from './postprocess';
import {
  checkMeshQualityLines,
  fieldDigestScript,
  isFieldName,
  isTimeName,
  logDigestScript,
  logExcerptScript,
  logFileName,
  meshDigestScript,
  parseFieldDigest,
  parseLogDigest,
  parseMeshDigest,
  renderFieldDigest,
  renderLogDigest,
  renderLogExcerpt,
  renderMeshDigest,
  renderPostProcessDigest,
  type LogExcerptOptions,
  type MeshQuality,
  type PostProcessFileSummary,
} from './case-digest';

const run = (script: string, timeout: number) =>
  runInWslScriptAsync(Buffer.from(script).toString('base64'), timeout);

/** `foamRun`, `log.foamRun`, `log` — checked by the same rule as the Monitor's log names. */
function resolveLog(name: unknown): string {
  if (name === undefined || name === null || name === '') return '';
  if (typeof name !== 'string') throw new WslInputError('Invalid log name');
  const file = logFileName(name);
  validateLogName(file === 'log' ? 'log' : file.slice(4));
  return file;
}

export async function analyzeLog(caseName: string, log?: unknown): Promise<string> {
  const casePath = getCasePath(caseName);
  const output = await run(logDigestScript(casePath, resolveLog(log)), 300000);
  return renderLogDigest(parseLogDigest(output));
}

export async function readLogExcerpt(caseName: string, log: unknown, options: LogExcerptOptions): Promise<string> {
  const casePath = getCasePath(caseName);
  const file = resolveLog(log) || 'log.foamRun';
  const output = await run(logExcerptScript(casePath, file, options), 120000);
  return renderLogExcerpt(output, file, options);
}

export async function analyzeFields(caseName: string, time?: unknown, fields?: unknown): Promise<string> {
  const casePath = getCasePath(caseName);
  const requestedTime = typeof time === 'string' ? time.trim() : typeof time === 'number' ? String(time) : '';
  if (requestedTime && requestedTime !== 'latest' && !isTimeName(requestedTime)) {
    throw new WslInputError(`"${requestedTime}" is not a time directory name`);
  }
  const names = Array.isArray(fields) ? fields.filter((f): f is string => typeof f === 'string') : [];
  const invalid = names.filter(n => !isFieldName(n));
  if (invalid.length) throw new WslInputError(`Not field names: ${invalid.join(', ')}`);
  const output = await run(fieldDigestScript(casePath, requestedTime === 'latest' ? '' : requestedTime, names), 600000);
  return renderFieldDigest(parseFieldDigest(output));
}

/** How many function-object files one summary reads, at most. */
const MAX_POSTPROCESS_FILES = 24;
const MAX_COLUMNS = 10;

export async function summarizePostProcessing(caseName: string): Promise<string> {
  const datasets = listPostProcessing(caseName);
  const all = datasets.flatMap(dataset => dataset.files.map(file => ({ dataset: dataset.name, file })));
  const summaries: PostProcessFileSummary[] = [];
  for (const { dataset, file } of all.slice(0, MAX_POSTPROCESS_FILES)) {
    // Each read is a synchronous WSL call; yielding between them lets the
    // app's other requests through while a long list is summarised.
    await new Promise(resolve => setImmediate(resolve));
    let read;
    try {
      read = readPostProcessDataset(caseName, dataset, file.name);
    } catch (error) {
      summaries.push({ dataset, file: file.name, bytes: file.bytes, times: file.times.length, timeSeries: false, rows: 0, columns: [], moreColumns: 0,
        note: `could not be read: ${error instanceof Error ? error.message : 'error'}` });
      continue;
    }
    const slices = read.slices.map(slice => ({ startTime: slice.startTime, table: parseFoamTable(slice.content) }));
    const latest = slices[slices.length - 1];
    if (!latest || !latest.table.columns.length) {
      summaries.push({ dataset, file: file.name, bytes: file.bytes, times: file.times.length, timeSeries: false, rows: 0, columns: [], moreColumns: 0, note: 'no table could be read' });
      continue;
    }
    const series = isTimeSeries(latest.table.columns);
    // A time series is stitched across restarts; a profile (a sampled line)
    // is a snapshot per time, and the newest one is the result.
    const table = series ? mergeRestarts(slices) : latest.table;
    const columns = table.columns.slice(1, 1 + MAX_COLUMNS).map((name, index) => {
      const stats = summarizeColumn(table.rows, index + 1);
      return { name, last: stats.last, min: stats.min, max: stats.max, tailMean: stats.tailMean, drift: series ? stats.drift : NaN };
    });
    const notes: string[] = [];
    if (series && 'overwritten' in table && table.overwritten) notes.push(`${table.overwritten} rows replaced by a restart`);
    if (read.slices.some(slice => slice.truncated)) notes.push('only the first 8 MB of a slice were read');
    summaries.push({
      dataset, file: file.name, bytes: file.bytes, times: file.times.length, timeSeries: series,
      rows: table.rows.length,
      first: series ? table.rows[0]?.[0] : undefined,
      last: series ? table.rows[table.rows.length - 1]?.[0] : undefined,
      columns, moreColumns: Math.max(0, table.columns.length - 1 - MAX_COLUMNS),
      note: notes.join('; ') || undefined,
    });
  }
  return renderPostProcessDigest(summaries, Math.max(0, all.length - MAX_POSTPROCESS_FILES));
}

/**
 * checkMesh, asynchronously and with room for a large mesh. `-latestTime`
 * when the case keeps its mesh in a time directory (snappyHexMesh without
 * -overwrite, a moving mesh), so the mesh checked is the one the case uses.
 */
async function checkMeshQuality(casePath: string, latestTime: boolean): Promise<MeshQuality> {
  const script = `cd -- ${shellQuote(casePath)} || { echo "the case folder was not found" >&2; exit 1; }
${foamSource()}checkMesh${latestTime ? ' -latestTime' : ''} 2>&1
echo "__CHECKMESH_EXIT__$?"
exit 0
`;
  let out: string;
  try {
    out = await run(script, 600000);
  } catch (error) {
    return { ok: false, ran: true, error: error instanceof Error ? error.message : 'checkMesh could not run', stats: [], failed: [], lines: [] };
  }
  const exitCode = Number((out.match(/__CHECKMESH_EXIT__(\d+)/) || [])[1] ?? 0);
  const raw = out.replace(/\n?__CHECKMESH_EXIT__\d+\s*$/, '').trimEnd();
  const report = parseCheckMeshOutput(raw);
  if (!report.verdictFound && exitCode !== 0) {
    const reason = raw.split('\n').filter(l => l.trim()).slice(-8).join(' / ');
    return { ok: false, ran: true, error: reason || `checkMesh exited ${exitCode}`, stats: [], failed: [], lines: [] };
  }
  return { ok: report.meshOk, ran: true, stats: report.overallStats, failed: report.failedChecks, lines: checkMeshQualityLines(raw) };
}

export async function summarizeMesh(caseName: string, quality: boolean): Promise<string> {
  const casePath = getCasePath(caseName);
  const digest = parseMeshDigest(await run(meshDigestScript(casePath), 300000));
  const hasMesh = digest.hasRoot || digest.timeMeshes.length > 0;

  let check: MeshQuality | null = null;
  if (quality) {
    check = hasMesh
      ? await checkMeshQuality(casePath, digest.timeMeshes.length > 0)
      : {
          ok: false, ran: false, stats: [], failed: [], lines: [],
          error: digest.processors.length
            ? `only the processor directories hold a mesh; checkMesh needs the reconstructed one (reconstructParMesh) or a parallel run (mpirun -np ${digest.processors.length} checkMesh -parallel)`
            : 'there is no mesh to check',
        };
  }

  // The boundary-condition check compares 0/ with constant/polyMesh. When the
  // case runs on a mesh in a time directory those are different patches, and
  // the comparison would report problems that are not there.
  let bc: string[] | null = null;
  if (digest.hasRoot && !digest.latestTimeMesh) {
    try {
      const result = validateBoundaryConditions(caseName);
      if (result.meshChecked !== false) {
        bc = [
          ...result.fields.flatMap(field => field.patches.filter(p => !p.valid).map(p => `${field.name}: ${p.patch} (${p.type || 'no entry'})${p.note ? ` — ${p.note}` : ''}`)),
          ...result.warnings,
        ];
      }
    } catch { bc = null; }
  }
  return renderMeshDigest(digest, check, bc);
}

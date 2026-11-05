/**
 * Compact digests of a case's results and mesh, for the AI agent.
 *
 * A solver log runs to hundreds of MB, a field of a large mesh to tens, and a
 * decomposed case has one copy of every field per processor. Handing any of
 * that to the agent as text fills its context with numbers it cannot use, and
 * moving it out of WSL is slow in its own right. So the reading happens where
 * the files are: each digest is one bash script that streams the files through
 * awk inside WSL and prints a few kilobytes of tab-separated records, whatever
 * the size of the input. This module builds those scripts and turns their
 * records into the text the agent reads. It is pure — no WSL, no fs — so the
 * parsing is unit-tested; src/lib/case-analysis.ts runs the scripts.
 *
 * The awk is POSIX on purpose: Ubuntu ships gawk, but a minimal distro has mawk,
 * and gawk-only features (match() with an array, asort, gensub) would break the
 * digests there without a word.
 */

import { shellQuote } from './wsl-input';

/** The most `read_case_file` returns. Anything larger goes through a digest. */
export const MAX_AGENT_READ_BYTES = 256 * 1024;
/** Residual history rows in a log digest, evenly spread over the run. */
export const LOG_SAMPLE_ROWS = 30;
/** Fields summarised in one call, so a case with 60 fields stays readable. */
export const MAX_DIGEST_FIELDS = 40;

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A time directory name: what OpenFOAM writes, nothing a shell could read as syntax. */
export function isTimeName(value: string): boolean {
  return NUMBER_PATTERN.test(value);
}

/** A field name as OpenFOAM writes them: `U`, `p_rgh`, `alpha.water`, `k:0`. */
export function isFieldName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/.test(value);
}

function num(text: string | undefined): number {
  if (text === undefined || text === '') return NaN;
  return NUMBER_PATTERN.test(text.trim()) ? Number(text) : NaN;
}

/** Short, stable number formatting for the agent: 4 significant digits. */
export function fmt(value: number): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? '—' : String(value);
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e-3 && abs < 1e5) return String(Number(value.toPrecision(4)));
  return value.toExponential(3).replace(/\.?0+e/, 'e');
}

function bytes(size: number): string {
  if (!Number.isFinite(size)) return '?';
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(1)} GB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${size} B`;
}

/**
 * A list of time names in one line: `0, 0.005 … 0.5 (101 times)`.
 * Sorted numerically, because `ls` order puts 10 before 2.
 */
export function summarizeTimes(times: readonly string[]): string {
  const sorted = [...new Set(times)].filter(isTimeName).sort((a, b) => Number(a) - Number(b));
  if (!sorted.length) return 'none';
  if (sorted.length <= 6) return sorted.join(', ');
  return `${sorted[0]}, ${sorted[1]} … ${sorted[sorted.length - 1]} (${sorted.length} times)`;
}

/**
 * The shared head of every digest script: enter the case, and a test that a
 * path resolves inside it. A symlink in a case must not make a read leave the
 * case, the same rule listPostProcessing applies.
 */
function scriptHead(casePath: string): string {
  return `cd -- ${shellQuote(casePath)} 2>/dev/null || { echo "the case folder was not found" >&2; exit 1; }
root=$(pwd -P)
inside() { local r; r=$(realpath -e -- "$1" 2>/dev/null) || return 1; case "$r" in "$root"/*) return 0 ;; esac; return 1; }
isnum() { [[ $1 =~ ^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$ ]]; }
shopt -s nullglob
`;
}

// ── Solver log ──────────────────────────────────────────────────────────────

/**
 * One pass over a solver log. Records, one per line, tab-separated:
 *   H key value      header (exec, build, nprocs, date)
 *   S text           a "Selecting …" line (models), first 14 distinct
 *   T steps first last restarts
 *   F field solves first last min max maxIter lastIter lastFinal bad
 *   RF fields…       column order of the R rows
 *   R time values…   initial residuals at sampled time steps
 *   CO/ICO n lastMean lastMax maxMax timeOfMax   Courant (and interface Courant)
 *   DT n last min max
 *   CE n lastLocal maxLocal lastCumulative
 *   EX executionTime clockTime
 *   NC count lastLine        "Not converged within" (PIMPLE)
 *   CV count lastLine        "converged in N iterations"
 *   B field count firstTime worstMin   bounding
 *   W/X/C text               first warnings, fatal errors, crash lines
 *   WC/XC count, E ended, L text   last 15 lines
 *
 * The initial residual of a field at a time step is the one of its FIRST solve
 * in that step, the convention the Monitor and Post-Process charts use.
 */
const LOG_AWK = String.raw`
function after(s, key,    p, r) {
  p = index(s, key); if (p == 0) return ""
  r = substr(s, p + length(key)); sub(/^[ \t]+/, "", r); sub(/[,; \t].*$/, "", r); return r
}
function bad(v) { v = tolower(v); return (v ~ /nan/ || v ~ /inf/) }
function clip(s) { return substr(s, 1, 240) }
BEGIN {
  step = 0; nf = 0; nb = 0
  if (steps < 1) steps = 1
  for (k = 0; k < samples; k++) want[(samples > 1) ? int(1 + k * (steps - 1) / (samples - 1) + 0.5) : steps] = 1
  want[steps] = 1
}
{ sub(/\r$/, ""); ring[NR % 15] = $0 }
wcap > 0 { print "W\t" clip($0); wcap-- }
xcap > 0 { print "X\t" clip($0); xcap-- }
/FOAM Warning/ { warns++; if (warns <= 3) { print "W\t--- warning " warns " at line " NR; print "W\t" clip($0); wcap = 6 } }
/FOAM FATAL/ { fatals++; if (fatals <= 2) { print "X\t--- line " NR; print "X\t" clip($0); xcap = 30 } }
/Floating point exception|Segmentation fault|^#[0-9]+[ \t]+Foam::|^#[0-9]+[ \t]+\?/ { crashes++; if (crashes <= 12) print "C\t" clip($0) }
/^Exec[ \t]+:/ { if (exe == "") exe = substr($0, index($0, ":") + 2) }
/^Build[ \t]+:/ { if (build == "") build = substr($0, index($0, ":") + 2) }
/^Date[ \t]+:/ { if (date == "") date = substr($0, index($0, ":") + 2) }
/^nProcs[ \t]+:/ { nprocs = $3 }
/^[ \t]*Selecting / { t = $0; sub(/^[ \t]+/, "", t); sub(/[ \t]+$/, "", t); if (!(t in sel) && nsel < 14) { sel[t] = 1; nsel++; print "S\t" substr(t, 1, 160) } }
/^Time = / {
  t = $3; sub(/s$/, "", t); step++
  if (step == 1) firstT = t
  else if (t + 0 < lastT + 0) restarts++
  lastT = t
}
/Solving for / {
  f = after($0, "Solving for ")
  if (f != "") {
    ini = after($0, "Initial residual = "); fin = after($0, "Final residual = "); it = after($0, "No Iterations ")
    if (!(f in seen)) { seen[f] = 1; order[++nf] = f }
    if (bad(ini) || bad(fin)) nbad[f]++
    if (it != "") { it += 0; if (it > itmax[f]) itmax[f] = it; itlast[f] = it }
    if (fin != "") finlast[f] = fin
    if (step > 0 && stepOf[f] != step && !bad(ini) && ini != "") {
      stepOf[f] = step; v = ini + 0; cnt[f]++
      if (cnt[f] == 1) { rfirst[f] = v; rmin[f] = v; rmax[f] = v }
      if (v < rmin[f]) rmin[f] = v
      if (v > rmax[f]) rmax[f] = v
      rlast[f] = v
      if (step in want) { samp[step, f] = ini; sampT[step] = lastT }
    }
  }
}
/^Courant Number mean:/ { cm = after($0, "mean: "); cx = after($0, "max: "); nco++; if (nco == 1 || cx + 0 > comax + 0) { comax = cx; comaxT = lastT }; colm = cm; colx = cx }
/^Interface Courant Number mean:/ { cm = after($0, "mean: "); cx = after($0, "max: "); nic++; if (nic == 1 || cx + 0 > icmax + 0) { icmax = cx; icmaxT = lastT }; iclm = cm; iclx = cx }
/^deltaT = / { dt = $3; if (ndt == 0 || dt + 0 < dtmin + 0) dtmin = dt; if (ndt == 0 || dt + 0 > dtmax + 0) dtmax = dt; dtlast = dt; ndt++ }
/time step continuity errors/ { sl = after($0, "sum local = "); cu = after($0, "cumulative = "); nce++; if (nce == 1 || sl + 0 > slmax + 0) slmax = sl; sllast = sl; culast = cu }
/^ExecutionTime = / { et = after($0, "ExecutionTime = "); ct = after($0, "ClockTime = ") }
/Not converged within/ { notconv++; ncline = $0; sub(/^[ \t]+/, "", ncline) }
/onverged in [0-9]+ iterations/ { if ($0 !~ /[Nn]ot converged/) { conv++; cvline = $0; sub(/^[ \t]+/, "", cvline) } }
/^bounding / {
  bf = $2; sub(/,$/, "", bf); bmin = after($0, "min: ")
  if (!(bf in bcount)) { border[++nb] = bf; bfirst[bf] = lastT; bworst[bf] = bmin }
  bcount[bf]++
  if (bmin + 0 < bworst[bf] + 0) bworst[bf] = bmin
}
/^End[ \t]*$/ { ended = 1 }
END {
  print "H\texec\t" exe; print "H\tbuild\t" build; print "H\tdate\t" date; print "H\tnprocs\t" nprocs
  print "T\t" step "\t" firstT "\t" lastT "\t" (restarts + 0)
  for (i = 1; i <= nf; i++) {
    f = order[i]
    print "F\t" f "\t" (cnt[f] + 0) "\t" rfirst[f] "\t" rlast[f] "\t" rmin[f] "\t" rmax[f] "\t" itmax[f] "\t" itlast[f] "\t" finlast[f] "\t" (nbad[f] + 0)
  }
  line = "RF"; for (i = 1; i <= nf; i++) line = line "\t" order[i]; print line
  for (s = 1; s <= step; s++) if (s in sampT) {
    line = "R\t" sampT[s]
    for (i = 1; i <= nf; i++) line = line "\t" (((s, order[i]) in samp) ? samp[s, order[i]] : "")
    print line
  }
  print "CO\t" (nco + 0) "\t" colm "\t" colx "\t" comax "\t" comaxT
  if (nic > 0) print "ICO\t" nic "\t" iclm "\t" iclx "\t" icmax "\t" icmaxT
  print "DT\t" (ndt + 0) "\t" dtlast "\t" dtmin "\t" dtmax
  print "CE\t" (nce + 0) "\t" sllast "\t" slmax "\t" culast
  print "EX\t" et "\t" ct
  print "NC\t" (notconv + 0) "\t" ncline
  print "CV\t" (conv + 0) "\t" cvline
  for (i = 1; i <= nb; i++) { f = border[i]; print "B\t" f "\t" bcount[f] "\t" bfirst[f] "\t" bworst[f] }
  print "WC\t" (warns + 0); print "XC\t" (fatals + 0); print "E\t" (ended + 0)
  for (k = NR - 14; k <= NR; k++) if (k > 0) print "L\t" clip(ring[k % 15])
}
`;

/** `foamRun`, `log.foamRun` or `log` → the file name in the case. */
export function logFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === 'log') return 'log';
  return trimmed.startsWith('log.') ? trimmed : `log.${trimmed}`;
}

/**
 * The log digest script. With no log named it takes the newest log that holds
 * residuals — the solver's, not blockMesh's — and falls back to the newest log.
 */
export function logDigestScript(casePath: string, logFile: string, sampleRows = LOG_SAMPLE_ROWS): string {
  return `${scriptHead(casePath)}now=$(date +%s)
logs=()
for f in log log.*; do [ -f "$f" ] && inside "$f" && logs+=("$f"); done
for f in "\${logs[@]}"; do printf 'LOG\\t%s\\t%s\\t%s\\n' "$f" "$(stat -c %s -- "$f")" "$(( now - $(stat -c %Y -- "$f") ))"; done
req=${shellQuote(logFile)}
f=""
if [ -n "$req" ]; then
  for c in "\${logs[@]}"; do [ "$c" = "$req" ] && f="$c"; done
  [ -n "$f" ] || { printf 'NOLOG\\t%s\\n' "$req"; exit 0; }
else
  [ \${#logs[@]} -gt 0 ] || { printf 'NOLOG\\t\\n'; exit 0; }
  while IFS= read -r c; do
    if grep -m1 -q 'Solving for' -- "$c"; then f="$c"; break; fi
  done < <(ls -1t -- "\${logs[@]}")
  [ -n "$f" ] || f=$(ls -1t -- "\${logs[@]}" | head -n 1)
fi
printf 'USE\\t%s\\t%s\\t%s\\n' "$f" "$(stat -c %s -- "$f")" "$(( now - $(stat -c %Y -- "$f") ))"
steps=$(grep -c '^Time = ' -- "$f")
awk -v steps="$steps" -v samples=${Math.max(2, Math.floor(sampleRows))} '${LOG_AWK}' "$f"
`;
}

export interface LogFieldStats {
  field: string;
  solves: number;
  first: number;
  last: number;
  min: number;
  max: number;
  maxIterations: number;
  lastIterations: number;
  lastFinal: number;
  /** Solves whose residual was nan or inf. */
  bad: number;
}

export interface LogDigest {
  found: boolean;
  /** The log asked for that does not exist, if one was asked for. */
  missing?: string;
  logs: { name: string; size: number; ageSeconds: number }[];
  file: string;
  size: number;
  ageSeconds: number;
  header: Record<string, string>;
  selecting: string[];
  steps: number;
  firstTime: string;
  lastTime: string;
  restarts: number;
  fields: LogFieldStats[];
  sampleFields: string[];
  samples: { time: string; values: number[] }[];
  courant?: { count: number; lastMean: number; lastMax: number; maxMax: number; timeOfMax: string };
  interfaceCourant?: { count: number; lastMean: number; lastMax: number; maxMax: number; timeOfMax: string };
  deltaT?: { count: number; last: number; min: number; max: number };
  continuity?: { count: number; lastLocal: number; maxLocal: number; lastCumulative: number };
  executionTime: number;
  clockTime: number;
  notConverged: { count: number; line: string };
  converged: { count: number; line: string };
  bounding: { field: string; count: number; firstTime: string; worstMin: number }[];
  warnings: number;
  warningText: string[];
  fatals: number;
  fatalText: string[];
  crashText: string[];
  ended: boolean;
  tail: string[];
  /** Fields whose residual is always 0 (solved explicitly), left out of the tables. */
  trivialFields: string[];
}

export function parseLogDigest(output: string): LogDigest {
  const digest: LogDigest = {
    found: false, logs: [], file: '', size: 0, ageSeconds: 0, header: {}, selecting: [],
    steps: 0, firstTime: '', lastTime: '', restarts: 0, fields: [], sampleFields: [], samples: [],
    executionTime: NaN, clockTime: NaN, notConverged: { count: 0, line: '' }, converged: { count: 0, line: '' },
    bounding: [], warnings: 0, warningText: [], fatals: 0, fatalText: [], crashText: [], ended: false, tail: [],
    trivialFields: [],
  };
  const courant = (c: string[]) => ({ count: Number(c[1]) || 0, lastMean: num(c[2]), lastMax: num(c[3]), maxMax: num(c[4]), timeOfMax: c[5] ?? '' });
  for (const line of output.split('\n')) {
    if (!line) continue;
    const c = line.split('\t');
    switch (c[0]) {
      case 'LOG': digest.logs.push({ name: c[1], size: Number(c[2]) || 0, ageSeconds: Number(c[3]) || 0 }); break;
      case 'NOLOG': digest.missing = c[1] || undefined; break;
      case 'USE': digest.found = true; digest.file = c[1]; digest.size = Number(c[2]) || 0; digest.ageSeconds = Number(c[3]) || 0; break;
      case 'H': if (c[2]) digest.header[c[1]] = c.slice(2).join('\t').trim(); break;
      case 'S': digest.selecting.push(c.slice(1).join('\t')); break;
      case 'T': digest.steps = Number(c[1]) || 0; digest.firstTime = c[2] ?? ''; digest.lastTime = c[3] ?? ''; digest.restarts = Number(c[4]) || 0; break;
      case 'F': digest.fields.push({
        field: c[1], solves: Number(c[2]) || 0, first: num(c[3]), last: num(c[4]), min: num(c[5]), max: num(c[6]),
        maxIterations: num(c[7]), lastIterations: num(c[8]), lastFinal: num(c[9]), bad: Number(c[10]) || 0,
      }); break;
      case 'RF': digest.sampleFields = c.slice(1); break;
      case 'R': digest.samples.push({ time: c[1], values: c.slice(2).map(num) }); break;
      case 'CO': if (Number(c[1]) > 0) digest.courant = courant(c); break;
      case 'ICO': if (Number(c[1]) > 0) digest.interfaceCourant = courant(c); break;
      case 'DT': if (Number(c[1]) > 0) digest.deltaT = { count: Number(c[1]), last: num(c[2]), min: num(c[3]), max: num(c[4]) }; break;
      case 'CE': if (Number(c[1]) > 0) digest.continuity = { count: Number(c[1]), lastLocal: num(c[2]), maxLocal: num(c[3]), lastCumulative: num(c[4]) }; break;
      case 'EX': digest.executionTime = num(c[1]); digest.clockTime = num(c[2]); break;
      case 'NC': digest.notConverged = { count: Number(c[1]) || 0, line: c.slice(2).join('\t') }; break;
      case 'CV': digest.converged = { count: Number(c[1]) || 0, line: c.slice(2).join('\t') }; break;
      case 'B': digest.bounding.push({ field: c[1], count: Number(c[2]) || 0, firstTime: c[3] ?? '', worstMin: num(c[4]) }); break;
      case 'W': digest.warningText.push(c.slice(1).join('\t')); break;
      case 'X': digest.fatalText.push(c.slice(1).join('\t')); break;
      case 'C': digest.crashText.push(c.slice(1).join('\t')); break;
      case 'WC': digest.warnings = Number(c[1]) || 0; break;
      case 'XC': digest.fatals = Number(c[1]) || 0; break;
      case 'E': digest.ended = c[1] === '1'; break;
      case 'L': digest.tail.push(c.slice(1).join('\t')); break;
    }
  }
  // Pre-loop solves land on step 0 and are not counted; a field that was
  // never solved inside the time loop (rho by `diagonal`, at 0) says nothing.
  digest.fields = digest.fields.filter(f => f.solves > 0);
  // A field whose residual is always 0 is solved explicitly (rho by
  // `diagonal`): no convergence to report, so it only widens the table.
  digest.trivialFields = digest.fields.filter(f => f.min === 0 && f.max === 0).map(f => f.field);
  digest.fields = digest.fields.filter(f => !digest.trivialFields.includes(f.field));
  return digest;
}

function age(seconds: number): string {
  if (seconds < 120) return `${seconds} s ago`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

/** The text the agent reads. Facts first, then the few things worth flagging. */
export function renderLogDigest(d: LogDigest): string {
  const logList = d.logs.length
    ? d.logs.map(l => `${l.name} (${bytes(l.size)}, ${age(l.ageSeconds)})`).join(', ')
    : 'none';
  if (!d.found) {
    return d.missing
      ? `There is no ${d.missing} in this case. Logs present: ${logList}.`
      : 'This case has no log file (log or log.*). Nothing has been run with its output logged, or the logs were removed.';
  }
  const out: string[] = [];
  out.push(`LOG ${d.file} — ${bytes(d.size)}, last written ${age(d.ageSeconds)}. All logs: ${logList}.`);
  const h = d.header;
  const head = [h.exec && `exec: ${h.exec}`, h.build && `build ${h.build}`, Number(h.nprocs) > 1 && `parallel on ${h.nprocs} processes`, h.date && `started ${h.date}`].filter(Boolean);
  if (head.length) out.push(head.join(' · '));
  if (d.selecting.length) out.push(`Models: ${d.selecting.join(' | ')}`);

  let state: string;
  if (d.fatals > 0) state = 'STOPPED WITH A FATAL ERROR';
  else if (d.crashText.length) state = 'CRASHED (signal / stack trace)';
  else if (d.ended) state = 'finished normally (End)';
  else if (d.ageSeconds < 120) state = 'no End line and written moments ago — probably still running';
  else state = 'no End line — interrupted or killed';
  out.push(`STATE: ${state}.`);
  if (d.steps) {
    out.push(`Time steps: ${d.steps}, time ${d.firstTime} → ${d.lastTime}` +
      (d.restarts ? `; time went backwards ${d.restarts}× (restarts appended to this log)` : '') + '.');
  } else {
    out.push('No "Time = " lines: this is not a time-stepping log (a mesher or utility), or it stopped before the first step.');
  }
  if (Number.isFinite(d.executionTime)) out.push(`ExecutionTime ${fmt(d.executionTime)} s, ClockTime ${fmt(d.clockTime)} s` +
    (d.steps && d.executionTime > 0 ? ` (≈ ${fmt(d.executionTime / d.steps)} s per step).` : '.'));

  if (d.fields.length) {
    out.push('', 'INITIAL RESIDUALS (first solve of each step): field: first → last [min, max] · iterations max/last · final residual last');
    for (const f of d.fields) {
      const notes: string[] = [];
      if (f.bad) notes.push(`${f.bad} NaN/inf solves`);
      if (Number.isFinite(f.min) && f.min > 0 && Number.isFinite(f.last) && f.last / f.min >= 100) notes.push(`last is ${fmt(f.last / f.min)}× its minimum — rising`);
      if (Number.isFinite(f.maxIterations) && f.maxIterations >= 1000) notes.push('hit 1000 iterations (likely maxIter)');
      out.push(`  ${f.field}: ${fmt(f.first)} → ${fmt(f.last)} [${fmt(f.min)}, ${fmt(f.max)}] · iter ${fmt(f.maxIterations)}/${fmt(f.lastIterations)} · final ${fmt(f.lastFinal)}` +
        (notes.length ? `  ← ${notes.join('; ')}` : ''));
    }
    if (d.trivialFields.length) out.push(`  (${d.trivialFields.join(', ')}: residual always 0 — solved explicitly)`);
    if (d.samples.length > 1 && d.sampleFields.length) {
      const columns = d.sampleFields.filter(field => d.fields.some(f => f.field === field));
      const index = columns.map(field => d.sampleFields.indexOf(field));
      out.push('', `History (${d.samples.length} evenly spaced steps): time | ${columns.join(' | ')}`);
      for (const s of d.samples) out.push(`  ${s.time} | ${index.map(i => fmt(s.values[i])).join(' | ')}`);
    }
  }
  if (d.courant) out.push('', `Courant: last mean ${fmt(d.courant.lastMean)}, last max ${fmt(d.courant.lastMax)}, highest max ${fmt(d.courant.maxMax)} at t=${d.courant.timeOfMax}.`);
  if (d.interfaceCourant) out.push(`Interface Courant: last max ${fmt(d.interfaceCourant.lastMax)}, highest ${fmt(d.interfaceCourant.maxMax)} at t=${d.interfaceCourant.timeOfMax}.`);
  if (d.deltaT) out.push(`deltaT: last ${fmt(d.deltaT.last)}, range [${fmt(d.deltaT.min)}, ${fmt(d.deltaT.max)}].`);
  if (d.continuity) out.push(`Continuity errors: last sum local ${fmt(d.continuity.lastLocal)} (highest ${fmt(d.continuity.maxLocal)}), cumulative ${fmt(d.continuity.lastCumulative)}.`);
  if (d.notConverged.count) out.push(`"${d.notConverged.line}" — ${d.notConverged.count} steps did not converge within the outer iterations.`);
  if (d.converged.count) out.push(`Convergence: "${d.converged.line}"${d.converged.count > 1 ? ` (${d.converged.count} times)` : ''}.`);
  if (d.bounding.length) {
    out.push(`Bounding (negative values clipped): ${d.bounding.map(b => `${b.field} ${b.count}× from t=${b.firstTime}, worst min ${fmt(b.worstMin)}`).join('; ')}.`);
  }
  if (d.warnings) out.push('', `FOAM Warnings: ${d.warnings}. First ones:`, ...d.warningText.map(t => `  ${t}`));
  if (d.fatalText.length) out.push('', `FATAL (${d.fatals}):`, ...d.fatalText.map(t => `  ${t}`));
  if (d.crashText.length) out.push('', 'Crash lines:', ...d.crashText.map(t => `  ${t}`));
  if (!d.ended && d.tail.length) out.push('', 'Last lines:', ...d.tail.map(t => `  ${t}`));
  return out.join('\n');
}

// ── A slice of a log ────────────────────────────────────────────────────────

export interface LogExcerptOptions {
  /** Literal text to find (not a regular expression). */
  match?: string;
  occurrence?: 'first' | 'last';
  context?: number;
  /** 1-based line to start at. */
  line?: number;
  count?: number;
  tail?: number;
}

/** At most this many lines come back, each cut to EXCERPT_WIDTH characters. */
export const EXCERPT_MAX_LINES = 120;
const EXCERPT_WIDTH = 240;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

export function logExcerptScript(casePath: string, logFile: string, options: LogExcerptOptions): string {
  const match = typeof options.match === 'string' ? options.match.replace(/[\r\n]/g, ' ').slice(0, 200) : '';
  const context = clampInt(options.context, 15, 0, 60);
  const count = clampInt(options.count, 60, 1, EXCERPT_MAX_LINES);
  const tail = clampInt(options.tail, 0, 0, EXCERPT_MAX_LINES);
  const line = clampInt(options.line, 0, 0, Number.MAX_SAFE_INTEGER);
  const last = options.occurrence === 'last';
  let range: string;
  if (match) {
    range = `m=${shellQuote(match)}
hits=$(grep -c -F -- "$m" "$f" || true)
printf 'M\\t%s\\t%s\\n' "$hits" "$(grep -n -F -- "$m" "$f" | head -n 12 | cut -d: -f1 | tr '\\n' ' ')"
[ "$hits" -gt 0 ] || exit 0
at=$(grep -n -F -- "$m" "$f" | ${last ? 'tail' : 'head'} -n 1 | cut -d: -f1)
s=$(( at - ${context} )); e=$(( at + ${context} ))`;
  } else if (tail) {
    range = `s=$(( total - ${tail} + 1 )); e=$total`;
  } else if (line) {
    range = `s=${line}; e=$(( ${line} + ${count} - 1 ))`;
  } else {
    range = `s=$(( total - 40 + 1 )); e=$total`;
  }
  return `${scriptHead(casePath)}f=${shellQuote(logFile)}
{ [ -f "$f" ] && inside "$f"; } || { printf 'NOLOG\\n'; exit 0; }
total=$(wc -l < "$f")
printf 'N\\t%s\\n' "$total"
${range}
[ "$s" -ge 1 ] || s=1
[ $(( e - s + 1 )) -le ${EXCERPT_MAX_LINES} ] || e=$(( s + ${EXCERPT_MAX_LINES} - 1 ))
awk -v s="$s" -v e="$e" 'NR >= s { sub(/\\r$/, ""); printf "%d: %s\\n", NR, substr($0, 1, ${EXCERPT_WIDTH}) } NR >= e { exit }' "$f"
`;
}

export function renderLogExcerpt(output: string, logFile: string, options: LogExcerptOptions): string {
  const lines = output.split('\n');
  if (lines[0] === 'NOLOG') return `There is no ${logFile} in this case.`;
  const total = Number(lines.find(l => l.startsWith('N\t'))?.slice(2)) || 0;
  const hit = lines.find(l => l.startsWith('M\t'));
  const body = lines.filter(l => /^\d+: /.test(l));
  const head: string[] = [`${logFile}: ${total} lines.`];
  if (hit) {
    const [, count, at] = hit.split('\t');
    if (!Number(count)) return `${logFile}: "${options.match}" does not occur in its ${total} lines.`;
    head.push(`"${options.match}" occurs ${count}× (first at lines ${at.trim().split(' ').join(', ')}${Number(count) > 12 ? ', …' : ''}); showing the ${options.occurrence === 'last' ? 'last' : 'first'}.`);
  }
  return [...head, ...body].join('\n');
}

// ── Fields in the time directories ──────────────────────────────────────────

/**
 * One field file, streamed. Prints one F record per file:
 *   F loc field class format kind n nan [stats]
 * with stats `min max sum` for scalars, the same of the SQUARED magnitude plus
 * `cmins cmaxs` for vectors, `min max` over all components for tensors, or the
 * uniform value.
 * With -v bnd=1 it also reads boundaryField:  B field patch type value
 *
 * Nothing but these records leaves WSL: a 10-million-cell field is reduced to
 * one line.
 */
const FIELD_AWK = String.raw`
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function add(text,    a, c, i, v, s, m) {
  if (tolower(text) ~ /nan|inf/) { nan++; return }
  gsub(/[()]/, " ", text); c = split(text, a, " ")
  if (c < nc) return
  n++
  if (nc == 1) { v = a[1] + 0; if (n == 1 || v < mn) mn = v; if (n == 1 || v > mx) mx = v; sum += v; return }
  if (nc == 3) {
    s = 0; for (i = 1; i <= 3; i++) { v = a[i] + 0; s += v * v; if (n == 1 || v < cmin[i]) cmin[i] = v; if (n == 1 || v > cmax[i]) cmax[i] = v }
    # Squared magnitude: some awk builds (busybox) have no sqrt. The root is
    # taken in TypeScript, and the mean becomes an RMS.
    if (n == 1 || s < mn) mn = s; if (n == 1 || s > mx) mx = s; sum += s; return
  }
  for (i = 1; i <= nc; i++) { v = a[i] + 0; if (n == 1 && i == 1 || v < mn) mn = v; if (n == 1 && i == 1 || v > mx) mx = v }
}
function addInline(body,    a, c, i, j, g) {
  gsub(/[()]/, " ", body); c = split(body, a, " ")
  for (i = 1; i + nc - 1 <= c; i += nc) { g = a[i]; for (j = 1; j < nc; j++) g = g " " a[i + j]; add(g) }
}
function emit() { if (pname != "" && pname !~ /^procBoundary/) print "B\t" fld "\t" pname "\t" ptype "\t" substr(pval, 1, 60) }
BEGIN { mode = "head"; nc = 1; kind = "none"; n = 0; nan = 0; depth = 0 }
{ sub(/\r$/, "") }
mode == "head" {
  # match() rather than $1, so a one-line "FoamFile { … class volVectorField; }"
  # header, as hand-written 0/ files often have, is read too.
  if (cls == "" && match($0, /class[ \t]+[A-Za-z]+/)) { cls = substr($0, RSTART, RLENGTH); sub(/^class[ \t]+/, "", cls); nc = (cls ~ /SymmTensor/) ? 6 : (cls ~ /Tensor/) ? 9 : (cls ~ /Vector/) ? 3 : 1 }
  if (fm == "" && match($0, /format[ \t]+[A-Za-z]+/)) { fm = substr($0, RSTART, RLENGTH); sub(/^format[ \t]+/, "", fm) }
  if ($1 == "internalField") {
    if (fm == "binary") { kind = "binary"; exit }
    if ($2 == "uniform") { kind = "uniform"; v = $0; sub(/^[ \t]*internalField[ \t]+uniform[ \t]+/, "", v); sub(/[ \t]*;[ \t]*$/, "", v); uval = v; mode = "bfwait" }
    else if ($2 == "nonuniform") {
      kind = "nonuniform"; p = index($0, "(")
      if (p > 0) { body = substr($0, p + 1); sub(/\)[ \t]*;?[ \t]*$/, "", body); addInline(body); mode = "bfwait" }
      else mode = "open"
    } else { kind = "other"; uval = substr($0, 1, 60); mode = "bfwait" }
  }
  next
}
mode == "open" {
  t = trim($0)
  if (t == "(") { mode = "list"; next }
  p = index(t, "(")
  if (p > 0) {
    body = substr(t, p + 1)
    if (trim(body) == "") { mode = "list"; next }
    sub(/\)[ \t]*;?[ \t]*$/, "", body); addInline(body); mode = "bfwait"
  }
  next
}
mode == "list" { t = trim($0); if (t == ")" || t == ");") { mode = "bfwait"; next }; if (t != "") add(t); next }
mode == "bfwait" { if ($1 == "boundaryField") { if (!bnd) exit; mode = "bf" }; next }
mode == "bfskip" { t = trim($0); if (t == ")" || t == ");") mode = "bf"; next }
mode == "bf" {
  t = trim($0)
  if (t == "" || t ~ /^\/\//) next
  if (t == "{") { depth++; next }
  if (t == "}") { if (depth == 2) { emit(); pname = "" }; depth--; if (depth <= 0) exit; next }
  if (depth == 1) {
    if (t ~ /^#/) next
    b = index(t, "{")
    if (b > 0) {
      pname = trim(substr(t, 1, b - 1)); ptype = ""; pval = ""
      inner = substr(t, b + 1)
      if (index(inner, "}") > 0) {
        q = index(inner, "type"); if (q > 0) { ptype = substr(inner, q + 4); sub(/^[ \t]+/, "", ptype); sub(/[ \t;].*$/, "", ptype) }
        emit(); pname = ""
      } else depth = 2
      next
    }
    if (t !~ /;$/) { pname = t; ptype = ""; pval = "" }
    next
  }
  if (depth == 2) {
    if ($1 == "type") { ptype = $2; sub(/;$/, "", ptype) }
    else if ($1 == "value") {
      if ($2 == "uniform") { pv = t; sub(/^value[ \t]+uniform[ \t]+/, "", pv); sub(/[ \t]*;$/, "", pv); pval = "uniform " pv }
      else if ($2 == "nonuniform") { pval = "nonuniform"; if (t !~ /;$/) mode = "bfskip" }
      else { pval = t; sub(/^value[ \t]+/, "", pval); sub(/[ \t]*;$/, "", pval) }
    }
    else if ($2 == "nonuniform" && t !~ /;$/) mode = "bfskip"
  }
  next
}
END {
  printf "F\t%s\t%s\t%s\t%s\t%s\t%d\t%d", loc, fld, cls, fm, kind, n, nan
  if (kind == "uniform" || kind == "other") printf "\t%s", uval
  else if (n > 0) {
    if (nc == 1) printf "\t%.6g\t%.6g\t%.10g", mn, mx, sum
    else if (nc == 3) printf "\t%.6g\t%.6g\t%.10g\t%.6g %.6g %.6g\t%.6g %.6g %.6g", mn, mx, sum, cmin[1], cmin[2], cmin[3], cmax[1], cmax[2], cmax[3]
    else printf "\t%.6g\t%.6g", mn, mx
  }
  printf "\n"
}
`;

/**
 * The time-directory digest: every time at the root and in each processor
 * directory, then the chosen time (`time`, or the latest anywhere) summarised
 * field by field. A decomposed case is read in its processor directories
 * unless that time was also reconstructed at the root, which is the cheaper
 * read of the same data.
 */
export function fieldDigestScript(casePath: string, time: string, fields: readonly string[]): string {
  const wanted = fields.filter(isFieldName).slice(0, MAX_DIGEST_FIELDS);
  return `${scriptHead(casePath)}req=${shellQuote(isTimeName(time) ? time : '')}
want=(${wanted.map(shellQuote).join(' ')})
rt=$(for d in */; do d=\${d%/}; isnum "$d" && printf '%s\\n' "$d"; done | sort -g)
printf '%s\\n' "$rt" | while IFS= read -r d; do [ -n "$d" ] && printf 'RT\\t%s\\n' "$d"; done
procs=()
for p in processor*/; do p=\${p%/}; [[ $p =~ ^processor[0-9]+$ ]] && inside "$p" && procs+=("$p"); done
printf 'NP\\t%s\\n' "\${#procs[@]}"
pt=""
for p in $(printf '%s\\n' "\${procs[@]}" | sort -V); do
  ts=$(for d in "$p"/*/; do d=\${d%/}; d=\${d##*/}; isnum "$d" && printf '%s\\n' "$d"; done | sort -g)
  [ "$p" = processor0 ] && pt="$ts"
  printf 'PL\\t%s\\t%s\\t%s\\n' "$p" "$(printf '%s\\n' "$ts" | grep -c .)" "$(printf '%s\\n' "$ts" | tail -n 1)"
done
printf '%s\\n' "$pt" | while IFS= read -r d; do [ -n "$d" ] && printf 'PT\\t%s\\n' "$d"; done
if [ -n "$req" ]; then T="$req"
else T=$(printf '%s\\n%s\\n' "$(printf '%s\\n' "$rt" | tail -n 1)" "$(printf '%s\\n' "$pt" | tail -n 1)" | grep . | sort -g | tail -n 1)
fi
[ -n "$T" ] || { printf 'NOTIME\\n'; exit 0; }
locs=()
if [ -d "$T" ] && inside "$T"; then locs=("$T"); mode=root
else
  for p in $(printf '%s\\n' "\${procs[@]}" | sort -V); do [ -d "$p/$T" ] && inside "$p/$T" && locs+=("$p/$T"); done
  mode=processors
fi
[ \${#locs[@]} -gt 0 ] || { printf 'NOTIME\\t%s\\n' "$T"; exit 0; }
both=0; [ "$mode" = root ] && [ \${#procs[@]} -gt 0 ] && [ -d "processor0/$T" ] && both=1
printf 'USE\\t%s\\t%s\\t%s\\t%s\\n' "$T" "$mode" "\${#locs[@]}" "$both"
names=()
for f in "\${locs[0]}"/*; do
  [ -f "$f" ] || continue
  n=\${f##*/}; n=\${n%.gz}
  [[ $n =~ ^[A-Za-z_][A-Za-z0-9_.:-]*$ ]] || continue
  case "$n" in *.orig) continue ;; esac
  if [ \${#want[@]} -gt 0 ]; then ok=0; for w in "\${want[@]}"; do [ "$w" = "$n" ] && ok=1; done; [ $ok = 1 ] || continue
  else
    # Face and point fields (phi, Uf, pointDisplacement) double the read for
    # little: they are summarised only when asked for by name.
    case "$f" in *.gz) head=$(zcat -- "$f" 2>/dev/null | head -c 2048) ;; *) head=$(head -c 2048 -- "$f") ;; esac
    cls=$(printf '%s\\n' "$head" | grep -m1 -oE 'class[[:space:]]+[A-Za-z]+' | awk '{print $2}')
    case "$cls" in surface*|point*) printf 'SKIP\\t%s\\t%s\\n' "$n" "$cls"; continue ;; esac
  fi
  names+=("$n")
done
printf 'NF\\t%s\\n' "\${#names[@]}"
i=0
for n in "\${names[@]}"; do
  i=$(( i + 1 )); [ $i -le ${MAX_DIGEST_FIELDS} ] || break
  first=1
  for l in "\${locs[@]}"; do
    f="$l/$n"; [ -f "$f" ] || f="$l/$n.gz"
    { [ -f "$f" ] && inside "$f"; } || { printf 'F\\t%s\\t%s\\t\\t\\tmissing\\t0\\t0\\n' "$l" "$n"; continue; }
    case "$f" in
      *.gz) zcat -- "$f" | awk -v loc="$l" -v fld="$n" -v bnd=$first '${FIELD_AWK}' ;;
      *) awk -v loc="$l" -v fld="$n" -v bnd=$first '${FIELD_AWK}' "$f" ;;
    esac
    first=0
  done
done
`;
}

export interface FieldFileRecord {
  location: string;
  field: string;
  className: string;
  format: string;
  kind: 'uniform' | 'nonuniform' | 'binary' | 'missing' | 'other' | 'none';
  count: number;
  nan: number;
  min: number;
  max: number;
  sum: number;
  /** For a vector: the sum of squared magnitudes, from which the RMS comes. */
  sumSquares?: number;
  componentMin?: number[];
  componentMax?: number[];
  uniform?: string;
}

export interface FieldDigest {
  rootTimes: string[];
  processorCount: number;
  processorTimes: string[];
  processorLatest: { processor: string; count: number; latest: string }[];
  time: string;
  /** Where the analysed time was read. */
  source: 'root' | 'processors' | '';
  locations: number;
  /** The time is at the root and in the processor directories as well. */
  alsoInProcessors: boolean;
  noTime: boolean;
  fieldCount: number;
  files: FieldFileRecord[];
  boundary: { field: string; patch: string; type: string; value: string }[];
  /** Face and point fields left out because they were not asked for. */
  skipped: string[];
}

export function parseFieldDigest(output: string): FieldDigest {
  const d: FieldDigest = {
    rootTimes: [], processorCount: 0, processorTimes: [], processorLatest: [], time: '', source: '',
    locations: 0, alsoInProcessors: false, noTime: false, fieldCount: 0, files: [], boundary: [], skipped: [],
  };
  for (const line of output.split('\n')) {
    if (!line) continue;
    const c = line.split('\t');
    switch (c[0]) {
      case 'RT': d.rootTimes.push(c[1]); break;
      case 'NP': d.processorCount = Number(c[1]) || 0; break;
      case 'PL': d.processorLatest.push({ processor: c[1], count: Number(c[2]) || 0, latest: c[3] ?? '' }); break;
      case 'PT': d.processorTimes.push(c[1]); break;
      case 'NOTIME': d.noTime = true; d.time = c[1] ?? ''; break;
      case 'USE': d.time = c[1]; d.source = c[2] === 'root' ? 'root' : 'processors'; d.locations = Number(c[3]) || 0; d.alsoInProcessors = c[4] === '1'; break;
      case 'NF': d.fieldCount = Number(c[1]) || 0; break;
      case 'SKIP': d.skipped.push(c[1]); break;
      case 'B': d.boundary.push({ field: c[1], patch: c[2], type: c[3] ?? '', value: c[4] ?? '' }); break;
      case 'F': {
        const record: FieldFileRecord = {
          location: c[1], field: c[2], className: c[3] ?? '', format: c[4] ?? '',
          kind: (['uniform', 'nonuniform', 'binary', 'missing', 'other'].includes(c[5]) ? c[5] : 'none') as FieldFileRecord['kind'],
          count: Number(c[6]) || 0, nan: Number(c[7]) || 0, min: NaN, max: NaN, sum: NaN,
        };
        if (record.kind === 'uniform' || record.kind === 'other') record.uniform = c.slice(8).join('\t');
        else if (c.length > 8) {
          record.min = num(c[8]); record.max = num(c[9]); record.sum = num(c[10]);
          if (c[11] !== undefined) {
            // A vector: the script reports squared magnitudes (see FIELD_AWK).
            record.componentMin = c[11].split(' ').map(num);
            record.componentMax = (c[12] ?? '').split(' ').map(num);
            record.min = Math.sqrt(record.min);
            record.max = Math.sqrt(record.max);
            record.sumSquares = record.sum;
            record.sum = NaN;
          }
        }
        d.files.push(record);
        break;
      }
    }
  }
  return d;
}

export interface FieldSummary {
  field: string;
  className: string;
  /** Values read (cells for a vol field, faces for a surface one). */
  count: number;
  nan: number;
  min: number;
  max: number;
  mean: number;
  /** Root mean square magnitude, for a vector field. */
  rms: number;
  componentMin?: number[];
  componentMax?: number[];
  /** Distinct uniform values, where some or all copies were uniform. */
  uniform: string[];
  binary: number;
  missing: number;
  copies: number;
}

/** Combine the copies of one field (one per processor) into one summary. */
export function aggregateFields(files: readonly FieldFileRecord[]): FieldSummary[] {
  const byField = new Map<string, FieldFileRecord[]>();
  for (const file of files) {
    const list = byField.get(file.field) ?? [];
    list.push(file);
    byField.set(file.field, list);
  }
  const out: FieldSummary[] = [];
  for (const [field, copies] of byField) {
    const s: FieldSummary = {
      field, className: copies.find(c => c.className)?.className ?? '', count: 0, nan: 0,
      min: NaN, max: NaN, mean: NaN, rms: NaN, uniform: [], binary: 0, missing: 0, copies: copies.length,
    };
    let sum = 0;
    let counted = 0;
    let squares = 0;
    let squared = 0;
    for (const c of copies) {
      s.nan += c.nan;
      if (c.kind === 'binary') { s.binary++; continue; }
      if (c.kind === 'missing') { s.missing++; continue; }
      if ((c.kind === 'uniform' || c.kind === 'other') && c.uniform !== undefined) {
        if (!s.uniform.includes(c.uniform)) s.uniform.push(c.uniform);
        // A uniform copy still bounds the range (a vector by its magnitude and
        // components); its weight is unknown, so it does not enter the mean.
        const parts = c.uniform.replace(/[()]/g, ' ').trim().split(/\s+/).map(num);
        if (parts.length && parts.every(Number.isFinite)) {
          const value = parts.length === 3 ? Math.hypot(parts[0], parts[1], parts[2]) : parts[0];
          s.min = Number.isFinite(s.min) ? Math.min(s.min, value) : value;
          s.max = Number.isFinite(s.max) ? Math.max(s.max, value) : value;
          if (parts.length === 3) {
            s.componentMin = s.componentMin ? s.componentMin.map((v, i) => Math.min(v, parts[i])) : [...parts];
            s.componentMax = s.componentMax ? s.componentMax.map((v, i) => Math.max(v, parts[i])) : [...parts];
          }
        }
        continue;
      }
      if (c.count > 0) {
        s.count += c.count;
        s.min = Number.isFinite(s.min) ? Math.min(s.min, c.min) : c.min;
        s.max = Number.isFinite(s.max) ? Math.max(s.max, c.max) : c.max;
        if (Number.isFinite(c.sum)) { sum += c.sum; counted += c.count; }
        if (c.sumSquares !== undefined && Number.isFinite(c.sumSquares)) { squares += c.sumSquares; squared += c.count; }
        if (c.componentMin) s.componentMin = s.componentMin ? s.componentMin.map((v, i) => Math.min(v, c.componentMin![i])) : [...c.componentMin];
        if (c.componentMax) s.componentMax = s.componentMax ? s.componentMax.map((v, i) => Math.max(v, c.componentMax![i])) : [...c.componentMax];
      }
    }
    if (counted > 0) s.mean = sum / counted;
    if (squared > 0) s.rms = Math.sqrt(squares / squared);
    out.push(s);
  }
  return out;
}

/** Fields that cannot be negative, by the name OpenFOAM gives them. */
const NON_NEGATIVE = /^(k|epsilon|omega|nut|nuTilda|mut|alphat|T|rho|nuSgs|kl|kt|v2|f)$/;

function fieldFlags(s: FieldSummary): string[] {
  const flags: string[] = [];
  if (s.nan) flags.push(`${s.nan} NaN/inf values`);
  if (NON_NEGATIVE.test(s.field) && Number.isFinite(s.min) && s.min < 0) flags.push('NEGATIVE — must not be');
  if (/^alpha\./.test(s.field) && Number.isFinite(s.min) && (s.min < -1e-6 || s.max > 1 + 1e-6)) flags.push('outside [0, 1]');
  if (s.binary) flags.push(`${s.binary} cop${s.binary === 1 ? 'y' : 'ies'} in binary format, not readable here`);
  if (s.missing) flags.push(`missing in ${s.missing} location${s.missing === 1 ? '' : 's'}`);
  return flags;
}

export function renderFieldDigest(d: FieldDigest): string {
  const out: string[] = [];
  out.push(`TIME DIRECTORIES at the case root: ${summarizeTimes(d.rootTimes)}.`);
  if (d.processorCount) {
    out.push(`DECOMPOSED into ${d.processorCount} processor directories; processor0 holds ${summarizeTimes(d.processorTimes)}.`);
    const latest = new Set(d.processorLatest.map(p => p.latest));
    if (latest.size > 1) {
      out.push(`  The processors do NOT end at the same time: ${d.processorLatest.map(p => `${p.processor} → ${p.latest || 'none'}`).join(', ')} — a write was interrupted or a processor lost data.`);
    }
    const rootLatest = [...d.rootTimes].sort((a, b) => Number(a) - Number(b)).pop();
    const procLatest = [...d.processorTimes].sort((a, b) => Number(a) - Number(b)).pop();
    if (procLatest && (!rootLatest || Number(procLatest) > Number(rootLatest))) {
      out.push(`  Results after ${rootLatest ?? 'the start'} exist only in the processor directories (not reconstructed; reconstructPar would bring them to the root).`);
    }
  }
  if (d.noTime) {
    out.push(d.time ? `Time ${d.time} does not exist at the root or in the processor directories.` : 'No time directory to analyse.');
    return out.join('\n');
  }
  out.push(`ANALYSED t = ${d.time}, read from ${d.source === 'root' ? 'the case root' : `${d.locations} processor directories (combined)`}` +
    (d.alsoInProcessors ? ' (the processor directories hold this time too)' : '') + '.');
  const summaries = aggregateFields(d.files);
  if (d.fieldCount > summaries.length) out.push(`${d.fieldCount} fields present, the first ${summaries.length} summarised (pass fields to choose).`);
  out.push('field (class, values): min … max, mean');
  for (const s of summaries) {
    const cls = s.className.replace(/^vol/, '').replace(/Field$/, '') || '?';
    let body: string;
    if (s.count === 0 && s.uniform.length) body = `uniform ${s.uniform.join(' / ')}`;
    else if (s.count === 0) body = s.binary ? 'binary — not summarised' : 'no values read';
    else if (s.componentMin && s.componentMax) {
      body = `|${s.field}| ${fmt(s.min)} … ${fmt(s.max)}, rms ${fmt(s.rms)}; components x ${fmt(s.componentMin[0])} … ${fmt(s.componentMax[0])}, y ${fmt(s.componentMin[1])} … ${fmt(s.componentMax[1])}, z ${fmt(s.componentMin[2])} … ${fmt(s.componentMax[2])}`;
      if (s.uniform.length) body += `; uniform in some copies: ${s.uniform.join(' / ')}`;
    } else {
      body = `${fmt(s.min)} … ${fmt(s.max)}${Number.isFinite(s.mean) ? `, mean ${fmt(s.mean)}` : ''}`;
      if (s.uniform.length) body += `; uniform in some copies: ${s.uniform.join(' / ')}`;
    }
    const flags = fieldFlags(s);
    out.push(`  ${s.field} (${cls}, ${s.count}): ${body}${flags.length ? `  ← ${flags.join('; ')}` : ''}`);
  }
  if (d.skipped.length) out.push(`  Face/point fields not read (name them in fields to include): ${d.skipped.join(', ')}.`);
  if (summaries.some(s => s.binary)) {
    out.push('Binary fields cannot be streamed here; `foamPostProcess -func "fieldMinMax"` (it writes into postProcessing/) or writeFormat ascii would make them readable — offer it, do not run it unasked.');
  }
  if (d.boundary.length) {
    const byPatch = new Map<string, string[]>();
    for (const b of d.boundary) {
      // `calculated` is a derived field's placeholder, and "nonuniform" says
      // only that the values vary: neither tells the agent anything.
      if (b.type === 'calculated') continue;
      const list = byPatch.get(b.patch) ?? [];
      const value = b.value && b.value !== 'nonuniform' ? ` ${b.value}` : '';
      list.push(`${b.field} ${b.type || '?'}${value}`);
      byPatch.set(b.patch, list);
    }
    out.push('', `BOUNDARY CONDITIONS at t = ${d.time}${d.source === 'processors' ? ' (from processor0; processor patches left out)' : ''}, calculated ones left out:`);
    for (const [patch, list] of byPatch) out.push(`  ${patch}: ${list.join('; ')}`);
  }
  return out.join('\n');
}

// ── postProcessing ──────────────────────────────────────────────────────────

export interface PostProcessColumnSummary {
  name: string;
  last: number;
  min: number;
  max: number;
  tailMean: number;
  drift: number;
}

export interface PostProcessFileSummary {
  dataset: string;
  file: string;
  bytes: number;
  times: number;
  timeSeries: boolean;
  rows: number;
  first?: number;
  last?: number;
  columns: PostProcessColumnSummary[];
  moreColumns: number;
  note?: string;
}

export function renderPostProcessDigest(files: readonly PostProcessFileSummary[], skipped: number): string {
  if (!files.length) return 'This case has no tabular output in postProcessing/ (no function objects wrote any, or they write only surfaces/VTK).';
  const datasets = new Set(files.map(f => f.dataset));
  const out: string[] = [`POSTPROCESSING: ${datasets.size} function object output${datasets.size === 1 ? '' : 's'}, ${files.length} tabular file${files.length === 1 ? '' : 's'} summarised${skipped ? ` (${skipped} more not summarised)` : ''}. Surfaces, VTK and other non-tabular output are not read.`];
  out.push('Per column: last · min … max · mean of the final fifth · drift = change between the last two fifths (small = settled).');
  for (const f of files) {
    const span = f.timeSeries && f.first !== undefined && f.last !== undefined ? `, t ${fmt(f.first)} → ${fmt(f.last)}` : '';
    out.push('', `${f.dataset}/${f.file} — ${f.timeSeries ? 'time series' : 'profile (latest snapshot)'}, ${f.rows} rows${span}, ${bytes(f.bytes)}${f.times > 1 ? `, ${f.times} time directories` : ''}${f.note ? ` — ${f.note}` : ''}`);
    for (const c of f.columns) {
      const drift = Number.isFinite(c.drift) ? `${fmt(c.drift * 100)}%` : '—';
      out.push(`  ${c.name}: last ${fmt(c.last)} · ${fmt(c.min)} … ${fmt(c.max)} · tail mean ${fmt(c.tailMean)} · drift ${drift}`);
    }
    if (f.moreColumns) out.push(`  … ${f.moreColumns} more columns`);
  }
  return out.join('\n');
}

// ── Mesh ────────────────────────────────────────────────────────────────────

/** Names and sizes of cell/face/point zones, without reading their label lists. */
const ZONES_AWK = String.raw`
{ sub(/\r$/, ""); t = $0; sub(/^[ \t]+/, "", t); sub(/[ \t]+$/, "", t) }
skip > 0 { if (t == ")" || t == ");") skip = 0; next }
hdr == 0 { if (t ~ /^FoamFile/) hdr = 1; next }
hdr == 1 { if (t == "}") hdr = 2; next }
t == "{" { depth++; next }
t == "}" { depth--; if (depth == 0 && zname != "") { print "Z\t" kind "\t" zname "\t" zsize; zname = ""; zsize = "" }; next }
depth == 0 && t ~ /^[A-Za-z_"]/ && t !~ /;$/ { zname = t; next }
depth == 1 && $2 ~ /^List</ { s = $3; sub(/\(.*$/, "", s); if (zsize == "") zsize = s; if (t !~ /;$/) skip = 1; next }
`;

/** Processor patches of one processor's boundary file: count and faces. */
const PROC_BOUNDARY_AWK = String.raw`
{ sub(/\r$/, "") }
$1 == "type" { ty = $2; sub(/;$/, "", ty) }
$1 == "nFaces" { nf = $2 + 0 }
$1 == "}" { if (ty == "processor" || ty == "processorCyclic") { np++; pf += nf }; ty = ""; nf = 0 }
END { printf "%d\t%d\n", np, pf }
`;

/** Bounding box of an ASCII points file, streamed. */
const POINTS_AWK = String.raw`
BEGIN { inl = 0; n = 0 }
{ sub(/\r$/, "") }
$1 == "format" && $2 ~ /binary/ { print "BB\tbinary"; exit }
inl == 0 { if ($0 ~ /^\($/) inl = 1; next }
$0 ~ /^\)$/ { exit }
{ t = $0; gsub(/[()]/, " ", t); c = split(t, a, " "); if (c < 3) next
  n++; for (i = 1; i <= 3; i++) { v = a[i] + 0; if (n == 1 || v < lo[i]) lo[i] = v; if (n == 1 || v > hi[i]) hi[i] = v } }
END { if (n > 0) printf "BB\t%d\t%.6g %.6g %.6g\t%.6g %.6g %.6g\n", n, lo[1], lo[2], lo[3], hi[1], hi[2], hi[3] }
`;

/**
 * The mesh digest script. Every count comes from a file HEADER — owner's
 * `note "nPoints:… nCells:…"` — or a streamed pass, so points, faces, owner and
 * neighbour are never transferred.
 */
export function meshDigestScript(casePath: string): string {
  return `${scriptHead(casePath)}note() {
  local d="$1"
  if [ -f "$d/owner" ]; then head -c 4096 -- "$d/owner"; elif [ -f "$d/owner.gz" ]; then zcat -- "$d/owner.gz" 2>/dev/null | head -c 4096; fi | grep -m1 -o 'nPoints:[^"]*' || true
}
pm=constant/polyMesh
if [ -d "$pm" ] && inside "$pm"; then
  printf 'ROOT\\t%s\\n' "$(note "$pm")"
  if [ -f "$pm/boundary" ] && inside "$pm/boundary"; then printf 'BOUNDARY\\t%s\\n' "$(head -c 262144 -- "$pm/boundary" | base64 -w0)"; fi
  for z in cellZones faceZones pointZones; do
    f="$pm/$z"; { [ -f "$f" ] && inside "$f"; } || continue
    awk -v kind="$z" '${ZONES_AWK}' "$f"
  done
  if [ -d "$pm/sets" ]; then for s in "$pm"/sets/*; do [ -f "$s" ] && printf 'SET\\t%s\\n' "\${s##*/}"; done; fi
  if [ -f "$pm/points" ] && inside "$pm/points"; then awk '${POINTS_AWK}' "$pm/points"
  elif [ -f "$pm/points.gz" ] && inside "$pm/points.gz"; then zcat -- "$pm/points.gz" | awk '${POINTS_AWK}'; fi
else
  printf 'NOROOT\\n'
fi
tm=""
for d in $(for d in */; do d=\${d%/}; isnum "$d" && printf '%s\\n' "$d"; done | sort -g); do
  [ -d "$d/polyMesh" ] && inside "$d/polyMesh" || continue
  printf 'TIMEMESH\\t%s\\t%s\\n' "$d" "$(note "$d/polyMesh")"; tm="$d"
done
# The newest time mesh is the one a solver or checkMesh -latestTime would use.
if [ -n "$tm" ] && [ -f "$tm/polyMesh/boundary" ] && inside "$tm/polyMesh/boundary"; then
  printf 'TBOUNDARY\\t%s\\t%s\\n' "$tm" "$(head -c 262144 -- "$tm/polyMesh/boundary" | base64 -w0)"
fi
for p in $(for p in processor*/; do p=\${p%/}; [[ $p =~ ^processor[0-9]+$ ]] && printf '%s\\n' "$p"; done | sort -V); do
  d="$p/constant/polyMesh"
  { [ -d "$d" ] && inside "$d"; } || { printf 'PROC\\t%s\\t\\t0\\t0\\n' "$p"; continue; }
  pb=$(printf '0\\t0'); [ -f "$d/boundary" ] && pb=$(awk '${PROC_BOUNDARY_AWK}' "$d/boundary")
  printf 'PROC\\t%s\\t%s\\t%s\\n' "$p" "$(note "$d")" "$pb"
done
if [ -f system/decomposeParDict ] && inside system/decomposeParDict; then
  grep -E '^[[:space:]]*(numberOfSubdomains|method)[[:space:]]' system/decomposeParDict | head -n 4 | while IFS= read -r l; do printf 'DECOMP\\t%s\\n' "$l"; done
fi
`;
}

export interface BoundaryEntry {
  name: string;
  type: string;
  nFaces: number;
  startFace: number;
  groups: string[];
}

/** The entries of a polyMesh/boundary file, with their face counts. */
export function parseBoundaryEntries(text: string): BoundaryEntry[] {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const entries: BoundaryEntry[] = [];
  const pattern = /("[^"]*"|[^\s{}();"]+)\s*\{([^{}]*)\}/g;
  for (const match of clean.matchAll(pattern)) {
    const name = match[1].replace(/^"|"$/g, '');
    if (name === 'FoamFile') continue;
    const body = match[2];
    const type = body.match(/\btype\s+([^\s;]+)\s*;/)?.[1] ?? '';
    const groups = body.match(/\binGroups\s+(?:List<word>\s*)?\d*\s*\(([^)]*)\)/)?.[1].trim().split(/\s+/).filter(Boolean) ?? [];
    entries.push({
      name, type,
      nFaces: Number(body.match(/\bnFaces\s+(\d+)/)?.[1] ?? NaN),
      startFace: Number(body.match(/\bstartFace\s+(\d+)/)?.[1] ?? NaN),
      groups,
    });
  }
  return entries;
}

export interface MeshCounts { points: number; cells: number; faces: number; internalFaces: number }

/** `nPoints:12225  nCells:6000  nFaces:24170  nInternalFaces:11830` */
export function parseMeshNote(note: string): MeshCounts | null {
  const get = (key: string) => Number(note.match(new RegExp(`${key}:\\s*(\\d+)`))?.[1] ?? NaN);
  const counts = { points: get('nPoints'), cells: get('nCells'), faces: get('nFaces'), internalFaces: get('nInternalFaces') };
  return Number.isFinite(counts.cells) ? counts : null;
}

export interface MeshDigest {
  root: MeshCounts | null;
  hasRoot: boolean;
  boundary: BoundaryEntry[];
  zones: { kind: string; name: string; size: number }[];
  sets: string[];
  boundingBox?: { points: number; min: number[]; max: number[] } | 'binary';
  timeMeshes: { time: string; counts: MeshCounts | null }[];
  /** Patches of the newest mesh in a time directory, when there is one. */
  latestTimeMesh?: { time: string; boundary: BoundaryEntry[] };
  processors: { name: string; counts: MeshCounts | null; procPatches: number; procFaces: number }[];
  decomposition: string[];
}

export function parseMeshDigest(output: string): MeshDigest {
  const d: MeshDigest = { root: null, hasRoot: false, boundary: [], zones: [], sets: [], timeMeshes: [], processors: [], decomposition: [] };
  for (const line of output.split('\n')) {
    if (!line) continue;
    const c = line.split('\t');
    switch (c[0]) {
      case 'ROOT': d.hasRoot = true; d.root = parseMeshNote(c[1] ?? ''); break;
      case 'BOUNDARY': d.boundary = parseBoundaryEntries(Buffer.from(c[1] ?? '', 'base64').toString('utf-8')); break;
      case 'Z': d.zones.push({ kind: c[1], name: c[2].replace(/^"|"$/g, ''), size: Number(c[3]) }); break;
      case 'SET': d.sets.push(c[1]); break;
      case 'BB':
        if (c[1] === 'binary') d.boundingBox = 'binary';
        else d.boundingBox = { points: Number(c[1]), min: c[2].split(' ').map(Number), max: c[3].split(' ').map(Number) };
        break;
      case 'TIMEMESH': d.timeMeshes.push({ time: c[1], counts: parseMeshNote(c[2] ?? '') }); break;
      case 'PROC': d.processors.push({ name: c[1], counts: parseMeshNote(c[2] ?? ''), procPatches: Number(c[3]) || 0, procFaces: Number(c[4]) || 0 }); break;
      case 'TBOUNDARY': d.latestTimeMesh = { time: c[1], boundary: parseBoundaryEntries(Buffer.from(c[2] ?? '', 'base64').toString('utf-8')) }; break;
      case 'DECOMP': d.decomposition.push(c.slice(1).join('\t').trim().replace(/\s*;\s*$/, '').replace(/\s+/g, ' ')); break;
    }
  }
  return d;
}

export interface MeshQuality {
  ok: boolean;
  ran: boolean;
  /** Why checkMesh did not produce a verdict, when it did not. */
  error?: string;
  stats: { key: string; value: string }[];
  failed: { severity: 'fail' | 'warning'; message: string }[];
  /** The quality lines of the report: non-orthogonality, skewness, … */
  lines: string[];
}

/** The quality lines worth quoting from a checkMesh report. */
export function checkMeshQualityLines(raw: string): string[] {
  const keep = /(non-orthogonality|skewness|aspect ratio|minimum face area|min volume|determinant|boundary openness|face pyramids|face tets|concave|weights|volume ratio|regions|closedness|wrong orientation|zero or negative)/i;
  return raw.split('\n').map(l => l.trim()).filter(l => l && keep.test(l)).slice(0, 30);
}

export function renderMeshDigest(
  d: MeshDigest,
  quality: MeshQuality | null,
  bcProblems: string[] | null,
): string {
  const out: string[] = [];
  if (d.hasRoot) {
    out.push(d.root
      ? `MESH constant/polyMesh: ${d.root.cells} cells, ${d.root.points} points, ${d.root.faces} faces (${d.root.internalFaces} internal, ${d.root.faces - d.root.internalFaces} boundary).`
      : 'MESH constant/polyMesh exists but its owner file has no size note (or is missing): sizes unknown.');
  } else {
    out.push('NO MESH at constant/polyMesh' + (d.processors.length ? ' — only the processor directories have one.' : ' — run the mesher (blockMesh, snappyHexMesh, …) first.'));
  }
  if (d.boundingBox === 'binary') out.push('Bounding box: points are in binary format, not streamed.');
  else if (d.boundingBox) {
    const box = d.boundingBox;
    const size = box.max.map((v, i) => v - box.min[i]);
    out.push(`Bounding box: (${box.min.map(fmt).join(' ')}) → (${box.max.map(fmt).join(' ')}), size ${size.map(fmt).join(' × ')} (in the mesh's units, normally metres).`);
  }
  if (d.timeMeshes.length) {
    out.push(`Meshes in time directories (a moving/changing mesh, or a mesher run without -overwrite): ${d.timeMeshes.map(t => `${t.time}/polyMesh${t.counts ? ` ${t.counts.cells} cells` : ''}`).join(', ')}.`);
  }
  const patches = (title: string, boundary: readonly BoundaryEntry[]) => {
    const dims = boundary.some(b => b.type === 'empty') ? '2D (empty patches)'
      : boundary.some(b => b.type === 'wedge') ? 'axisymmetric (wedge patches)' : '3D';
    out.push('', `${title} (${boundary.length}, ${dims}): name type faces [groups]`);
    for (const b of boundary) {
      const flags = Number.isFinite(b.nFaces) && b.nFaces === 0 ? '  ← no faces' : '';
      out.push(`  ${b.name} ${b.type} ${Number.isFinite(b.nFaces) ? b.nFaces : '?'}${b.groups.length ? ` [${b.groups.join(' ')}]` : ''}${flags}`);
    }
  };
  if (d.latestTimeMesh?.boundary.length) {
    patches(`PATCHES of the newest mesh, ${d.latestTimeMesh.time}/polyMesh — the one the case runs on`, d.latestTimeMesh.boundary);
    if (d.boundary.length) patches('Patches of constant/polyMesh (the starting / background mesh)', d.boundary);
  } else if (d.boundary.length) patches('PATCHES', d.boundary);
  if (d.zones.length) out.push(`Zones: ${d.zones.map(z => `${z.name} (${z.kind.replace(/Zones$/, '')}, ${Number.isFinite(z.size) ? z.size : '?'})`).join(', ')}.`);
  if (d.sets.length) out.push(`Sets in polyMesh/sets: ${d.sets.slice(0, 20).join(', ')}${d.sets.length > 20 ? `, … (${d.sets.length})` : ''}. checkMesh writes the cells/faces that fail a check here.`);

  if (d.processors.length) {
    const cells = d.processors.map(p => p.counts?.cells ?? NaN).filter(Number.isFinite);
    out.push('', `DECOMPOSITION: ${d.processors.length} processor directories${d.decomposition.length ? ` (decomposeParDict: ${d.decomposition.join('; ')})` : ''}.`);
    if (cells.length) {
      const total = cells.reduce((a, b) => a + b, 0);
      const mean = total / cells.length;
      const max = Math.max(...cells);
      const min = Math.min(...cells);
      const faces = d.processors.reduce((a, p) => a + p.procFaces, 0);
      out.push(`  cells per processor: ${fmt(min)} … ${fmt(max)}, mean ${fmt(mean)} — imbalance ${fmt((max / mean - 1) * 100)}% (max/mean − 1); total ${total}` +
        (d.root && total !== d.root.cells ? ` ≠ ${d.root.cells} at the root: the decomposition is of a different mesh — run decomposePar again` : '') + '.');
      out.push(`  processor interface faces: ${faces / 2} shared faces (${d.processors.map(p => p.procPatches).reduce((a, b) => a + b, 0)} processor patches).`);
    }
    const missing = d.processors.filter(p => !p.counts).map(p => p.name);
    if (missing.length) out.push(`  No mesh in: ${missing.join(', ')}.`);
  }

  if (quality) {
    out.push('');
    if (!quality.ran) out.push(`checkMesh: not run — ${quality.error ?? 'no root mesh'}.`);
    else if (quality.error) out.push(`checkMesh stopped before judging the mesh: ${quality.error}`);
    else {
      out.push(`checkMesh: ${quality.ok ? 'Mesh OK' : `${quality.failed.filter(f => f.severity === 'fail').length} failed checks`}.`);
      for (const f of quality.failed) out.push(`  ${f.severity === 'fail' ? 'FAIL' : 'warn'}: ${f.message}`);
      if (quality.lines.length) out.push('  Report lines:', ...quality.lines.map(l => `    ${l}`));
    }
  }
  if (bcProblems) {
    out.push('', bcProblems.length
      ? `Boundary conditions in 0/ against these patches: ${bcProblems.length} problem${bcProblems.length === 1 ? '' : 's'}:`
      : 'Boundary conditions in 0/: every field covers every patch.');
    for (const p of bcProblems.slice(0, 25)) out.push(`  ${p}`);
  }
  return out.join('\n');
}

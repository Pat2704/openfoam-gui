/**
 * Reading what OpenFOAM's function objects write.
 *
 * WHY THIS EXISTS
 *
 * A solved case answers questions the log and the 3D view cannot: what is the
 * drag coefficient, the flow rate through the outlet, the pressure drop, the
 * velocity profile along a line, the history at a probe. OpenFOAM answers all
 * of them through function objects, which write plain-text tables under
 * `postProcessing/<function>/<startTime>/<file>`. Until now the app only ever
 * EXCLUDED that directory — the file editor skipped it, cloning dropped it, the
 * timestep listers filtered it out — so none of those numbers were reachable.
 *
 * Everything here is pure: no `fs`, no WSL, no React. The formats below are the
 * part where a mistake is silent — a mis-parsed column plots a confident wrong
 * curve — so this module is separated to be unit-tested on its own, the way
 * `wsl-input.ts` and `webgl-sizing.ts` are.
 *
 * THE FORMATS, as read from a real OpenFOAM 14 run rather than from memory:
 *
 *   volFieldValue.dat, a scalar time series
 *     # Selection   : all
 *     # Cells       : 400
 *     # Time        	volAverage(p)
 *     5             	-5.553211e-03
 *
 *   line.xy, a spatial profile, already expanded into scalar components
 *     #    distance             p           U_x           U_y           U_z
 *       7.20485e-18   -0.00901475    0.00145922       0.14085             0
 *
 *   probes/<field>, a time series whose cells are vectors
 *     # Probe 0 (0.005 0.005 0.005)
 *     # Probe 1 (0.007 0.007 0.005)
 *     # Time        0             1
 *     9             (0.00267728 -0.00317882 0) (-0.0134597 0.0123971 0)
 *
 * Three shapes, one grammar: a run of `#` comment lines whose LAST line names
 * the columns, then whitespace-separated cells whichever may be a bare number
 * or a parenthesised — possibly nested — tuple. `parseFoamTable` implements
 * exactly that, and refuses to guess when the counts do not line up.
 */

/** The one directory name every function object writes beneath. */
export const POST_PROCESSING_DIR = 'postProcessing';

/** A parsed table: every column scalar, every row the same length. */
export interface FoamTable {
  /** Column names, aligned with each row. The first is the independent variable. */
  columns: string[];
  /** One row per sample. A cell that could not be read is NaN, never dropped. */
  rows: number[][];
  /** The `#` lines above the data, header line excluded, comment marker stripped. */
  notes: string[];
  /** Set when the column names had to be invented because the header did not fit. */
  synthesizedColumns: boolean;
  /** Set when the row limit stopped the read before the end of the file. */
  truncated: boolean;
}

/**
 * OpenFOAM's own component names, so an expanded vector column reads the way
 * the user would write it in a dictionary rather than as `[0]`, `[1]`, `[2]`.
 */
const COMPONENT_NAMES: Record<number, string[]> = {
  3: ['x', 'y', 'z'],
  6: ['xx', 'xy', 'xz', 'yy', 'yz', 'zz'],
  9: ['xx', 'xy', 'xz', 'yx', 'yy', 'yz', 'zx', 'zy', 'zz'],
};

function componentSuffixes(count: number): string[] {
  const known = COMPONENT_NAMES[count];
  if (known) return known;
  return Array.from({ length: count }, (_, index) => `[${index}]`);
}

/**
 * Split one line into cells, treating a parenthesised group as a single cell.
 *
 * Depth-aware because the cells are not flat: a probe of U writes
 * `(0.0026 -0.0031 0)` and a forces file writes nested `((…) (…) (…))`. Naive
 * whitespace splitting turns one vector into three columns and silently shifts
 * every column after it.
 *
 * A token is only a tuple when it BEGINS with `(`. That distinction matters:
 * `volAverage(p)` is a column NAME containing balanced parentheses, and a plain
 * depth counter would have started a group in the middle of it.
 */
export function tokenizeFoamRow(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let depth = 0;
  for (const char of line) {
    if (char === '(') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')') {
      // A stray closing parenthesis cannot take the depth negative: a
      // malformed line should end up as unreadable cells, not as one giant
      // cell swallowing the rest of the file.
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (depth === 0 && /\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Is this cell a parenthesised group rather than a single value? */
function isTuple(token: string): boolean {
  return token.startsWith('(') && token.endsWith(')') && token.length >= 2;
}

/** The cells directly inside a tuple, one nesting level down. */
function tupleMembers(token: string): string[] {
  return tokenizeFoamRow(token.slice(1, -1));
}

/** Flatten a cell to the scalars it contains, at any nesting depth. */
function flattenCell(token: string): number[] {
  if (!isTuple(token)) return [Number(token)];
  return tupleMembers(token).flatMap(flattenCell);
}

/**
 * Names for one flattened cell, given whatever the header offered for it.
 *
 * When the header carries a matching tuple — the forces files write
 * `# Time (total_x total_y total_z) (pressure_x …)` — those names are used
 * verbatim, because OpenFOAM's own naming beats anything invented here.
 * Otherwise the base name gains component suffixes, so an expanded vector never
 * produces the same column name twice.
 */
function expandCellNames(headerToken: string, cell: string): string[] {
  const width = flattenCell(cell).length;

  if (isTuple(headerToken)) {
    const members = tupleMembers(headerToken);
    if (members.length === width) return members;
  }
  const base = (isTuple(headerToken) ? headerToken.slice(1, -1).trim() : headerToken) || 'value';
  if (width === 1) return [base];
  return componentSuffixes(width).map(suffix => `${base}_${suffix}`);
}

/**
 * Probe columns are named `0`, `1`, `2` … and the coordinates that give them
 * meaning sit in the comment lines above. Fold them together so a legend reads
 * `0 (0.005 0.005 0.005)` instead of a bare index.
 */
function labelProbeColumns(columns: string[], notes: string[]): string[] {
  const positions = new Map<string, string>();
  for (const note of notes) {
    const match = note.match(/^Probe\s+(\d+)\s+(\(.*\))\s*$/);
    if (match) positions.set(match[1], match[2]);
  }
  if (!positions.size) return columns;
  return columns.map(column => {
    // Only the exact index is rewritten; an expanded component keeps its
    // suffix, so `1_x` becomes `1 (…)_x` and stays distinguishable.
    const direct = positions.get(column);
    if (direct) return `${column} ${direct}`;
    const componentMatch = column.match(/^(\d+)(_.+)$/);
    const position = componentMatch && positions.get(componentMatch[1]);
    return position ? `${componentMatch![1]} ${position}${componentMatch![2]}` : column;
  });
}

export interface ParseTableOptions {
  /**
   * Stop after this many data rows. A probes file over a long transient can
   * hold hundreds of thousands of lines and nothing downstream can plot them.
   */
  maxRows?: number;
}

/**
 * Parse one function-object output file.
 *
 * Never throws on malformed input: a file that cannot be read as a table comes
 * back with no rows, which the caller reports as such. Silently returning a
 * PARTIAL table would be the dangerous outcome, so a row whose width does not
 * match the header is dropped rather than padded into place.
 */
export function parseFoamTable(content: string, options: ParseTableOptions = {}): FoamTable {
  const maxRows = options.maxRows ?? 200_000;
  const lines = content.split('\n');

  const notes: string[] = [];
  let headerLine = '';
  let firstDataIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      const stripped = line.replace(/^#\s?/, '').trimEnd();
      // Every comment line is a candidate header; the last one before the data
      // wins, and the ones it displaces become notes. This is what makes the
      // three formats one case: `# Time volAverage(p)`, `# distance p U_x …`
      // and the probes' `# Time 0 1` are all simply the last comment line.
      if (headerLine) notes.push(headerLine);
      headerLine = stripped;
      continue;
    }
    firstDataIndex = index;
    break;
  }

  if (firstDataIndex === -1) {
    const onlyNotes = headerLine ? [...notes, headerLine] : notes;
    return { columns: [], rows: [], notes: onlyNotes, synthesizedColumns: false, truncated: false };
  }

  const headerTokens = tokenizeFoamRow(headerLine);
  const firstCells = tokenizeFoamRow(lines[firstDataIndex]);

  // The header describes the data only when it has one name per cell. When it
  // does not — a version that writes a trailing `# Time` line on its own, a
  // file whose header was never written — names are invented, and the caller is
  // told so rather than being handed plausible-looking labels. Either way the
  // same expansion runs, so a synthesized vector column still gets its three
  // distinct component names instead of one name repeated three times.
  const usable = headerTokens.length === firstCells.length;
  const columns: string[] = [];
  for (let index = 0; index < firstCells.length; index += 1) {
    const headerToken = usable ? headerTokens[index] : index === 0 ? 'Time' : `column ${index}`;
    columns.push(...expandCellNames(headerToken, firstCells[index]));
  }

  const width = columns.length;
  const rows: number[][] = [];
  let truncated = false;
  for (let index = firstDataIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.startsWith('#')) continue;
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const values = tokenizeFoamRow(line).flatMap(flattenCell);
    // A short or long row means the file changed shape mid-stream, which a
    // crashed write can do. Keeping it would misalign every series after it.
    if (values.length !== width) continue;
    rows.push(values);
  }

  return {
    columns: labelProbeColumns(columns, notes),
    rows,
    notes,
    synthesizedColumns: !usable,
    truncated,
  };
}

/**
 * Does a time directory hold a CONTINUATION of one series, or a SNAPSHOT?
 *
 * Both live under `postProcessing/<function>/<time>/`, and confusing them
 * produces a chart that is quietly meaningless:
 *
 *   volFieldValue.dat  starts `# Time  volAverage(p)`. The directory is where a
 *                      run resumed from, and its rows continue the same series.
 *                      Stitching is right; a restart's recomputed rows replace
 *                      the older ones.
 *
 *   line.xy            starts `# distance  p  U_x …`. The directory IS the
 *                      instant the profile was sampled at, and each file is a
 *                      complete curve of its own. Merging 21 of them by distance
 *                      keeps whichever came last and silently throws away
 *                      twenty profiles — which is exactly what happened before
 *                      this distinction existed.
 *
 * The discriminator is the data's own independent variable rather than a list
 * of function names, so it holds for functions this app has never seen.
 */
export function isTimeSeries(columns: readonly string[]): boolean {
  return (columns[0] ?? '').trim().toLowerCase() === 'time';
}

/** One run's contribution to a dataset, keyed by the time directory it sits in. */
export interface RunSlice {
  /** The `postProcessing/<function>/<startTime>` directory name. */
  startTime: string;
  table: FoamTable;
}

export interface MergedTable extends FoamTable {
  /** The start times that contributed, oldest first. */
  startTimes: string[];
  /** Slices left out because their columns did not match the newest run's. */
  incompatible: string[];
  /** Rows that a later run replaced. Reported so a jump in the curve is explainable. */
  overwritten: number;
}

/**
 * Stitch the time directories of one function object into a single series.
 *
 * A restart does not append: it creates a NEW directory named after the time it
 * resumed from, and the old one keeps every row it had — including rows for
 * times the new run recomputed. Concatenating them makes the x axis travel
 * backwards mid-plot; the correct rule is that for any repeated x the later run
 * wins, because that is the run whose fields are on disk.
 */
export function mergeRestarts(slices: RunSlice[]): MergedTable {
  const ordered = [...slices].sort((a, b) => Number(a.startTime) - Number(b.startTime));
  const usable = ordered.filter(slice => slice.table.columns.length > 0);
  if (!usable.length) {
    return {
      columns: [], rows: [], notes: [], synthesizedColumns: false, truncated: false,
      startTimes: [], incompatible: [], overwritten: 0,
    };
  }

  // The newest run defines the shape: it is the one the user just produced, and
  // it is the one whose columns the chart should offer.
  const reference = usable[usable.length - 1];
  const signature = reference.table.columns.join(' ');
  const compatible = usable.filter(slice => slice.table.columns.join(' ') === signature);
  const incompatible = usable.filter(slice => slice.table.columns.join(' ') !== signature).map(slice => slice.startTime);

  const byIndependent = new Map<number, number[]>();
  let overwritten = 0;
  for (const slice of compatible) {
    for (const row of slice.table.rows) {
      if (byIndependent.has(row[0])) overwritten += 1;
      byIndependent.set(row[0], row);
    }
  }

  const rows = Array.from(byIndependent.values()).sort((a, b) => a[0] - b[0]);
  return {
    columns: reference.table.columns,
    rows,
    notes: reference.table.notes,
    synthesizedColumns: reference.table.synthesizedColumns,
    truncated: compatible.some(slice => slice.table.truncated),
    startTimes: compatible.map(slice => slice.startTime),
    incompatible,
    overwritten,
  };
}

/**
 * Thin a series to at most `limit` rows for plotting.
 *
 * Uniform stride rather than averaging, and the last row is always kept: on a
 * convergence plot the final value is the one being read off, and an averaged
 * or dropped endpoint would misreport it.
 */
export function downsampleRows(rows: number[][], limit: number): number[][] {
  if (limit <= 0 || rows.length <= limit) return rows;
  const stride = Math.ceil(rows.length / limit);
  const thinned: number[][] = [];
  for (let index = 0; index < rows.length; index += stride) thinned.push(rows[index]);
  const last = rows[rows.length - 1];
  if (thinned[thinned.length - 1] !== last) thinned.push(last);
  return thinned;
}

export interface ColumnStats {
  last: number;
  min: number;
  max: number;
  mean: number;
  /** Mean over the final fifth of the series — what a report quotes. */
  tailMean: number;
  /**
   * Relative change between the last two fifths, or NaN when there is too
   * little data or the quantity sits at zero. Small means settled.
   */
  drift: number;
  /** Samples that were finite and therefore counted. */
  samples: number;
}

/**
 * Summarise one column.
 *
 * The tail statistics are the point: "the last value" of a quantity that is
 * still oscillating is noise, and a mean over the whole run includes the
 * transient nobody wants in the average.
 */
export function summarizeColumn(rows: number[][], index: number): ColumnStats {
  const values = rows.map(row => row[index]).filter(Number.isFinite);
  if (!values.length) {
    return { last: NaN, min: NaN, max: NaN, mean: NaN, tailMean: NaN, drift: NaN, samples: 0 };
  }

  let min = Infinity;
  let max = -Infinity;
  let total = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    total += value;
  }

  const mean = (slice: number[]) => slice.reduce((sum, value) => sum + value, 0) / slice.length;
  const fifth = Math.max(1, Math.floor(values.length / 5));
  const tail = values.slice(values.length - fifth);
  const tailMean = mean(tail);

  // Two full windows are needed to speak of drift at all. Below that the honest
  // answer is "unknown", not zero — a zero would read as "converged".
  let drift = NaN;
  if (values.length >= 2 * fifth && fifth >= 1) {
    const previous = mean(values.slice(values.length - 2 * fifth, values.length - fifth));
    const scale = Math.max(Math.abs(tailMean), Math.abs(previous));
    if (scale > 0) drift = Math.abs(tailMean - previous) / scale;
  }

  return { last: values[values.length - 1], min, max, mean: total / values.length, tailMean, drift, samples: values.length };
}

// ── The function-object catalogue, read from the installation ──

/**
 * What kind of input one argument of a configured function object wants.
 *
 * Derived from the placeholder OpenFOAM writes in its own template files, so
 * the form the UI builds cannot drift from the installed version.
 */
export type FunctionArgKind =
  | 'number' | 'point' | 'pointList'
  | 'fieldName' | 'fieldList'
  | 'patchName' | 'patchList'
  | 'text';

export interface FunctionArg {
  name: string;
  kind: FunctionArgKind;
  /** True when the template shows the value already wrapped in parentheses. */
  listWrapped: boolean;
  /** The placeholder as written, e.g. `<fieldNames>`, or the supplied default. */
  placeholder: string;
  /** The template's own trailing comment, which is the best help text there is. */
  help: string;
  /** An argument with a concrete value in the template may be left alone. */
  required: boolean;
}

export interface FunctionTemplate {
  description: string;
  args: FunctionArg[];
}

/**
 * What kind of value a `<placeholder>` stands for.
 *
 * Classified by SHAPE rather than by a table of names, because the installed
 * templates use 57 distinct placeholders and a table would be wrong on the
 * first version that adds one. The shapes come from what OpenFOAM 14 actually
 * writes, counted across all 127 templates:
 *
 *   <fieldNames> 38   <fieldName> 22   <point> 11   <phaseName> 7
 *   <patchName> 6     <points> 5       <patchNames> 5   <nPoints> 5   …
 *
 * The singular/plural distinction is the one that matters most and the one the
 * first version missed: `patch <patchName>;` was falling through to plain text,
 * so the example kept the literal `<patchName>` instead of naming a patch of
 * the case. Anything unrecognised still falls through on purpose — a visible
 * `<placeholder>` reads as a hole to fill, which is better than a wrong guess.
 */
function placeholderKind(placeholder: string): FunctionArgKind {
  const bare = placeholder.replace(/^<|>$/g, '');
  const lower = bare.toLowerCase();
  const plural = lower.endsWith('s');

  if (lower === 'point') return 'point';
  if (lower === 'points') return 'pointList';
  // A vector written as one entry. `axis` is deliberately NOT here: in the
  // graph templates it means "x", "y", "z" or "distance", not a direction.
  if (['cofr', 'pitchaxis', 'liftdir', 'dragdir', 'normal', 'origin', 'centre', 'center', 'direction', 'coordinate'].includes(lower)) {
    return 'point';
  }
  if (['number', 'npoints', 'scalar', 'value', 'radius', 'isovalue'].includes(lower)) return 'number';
  if (lower.includes('field')) return plural ? 'fieldList' : 'fieldName';
  if (lower.includes('patch')) return plural ? 'patchList' : 'patchName';
  return 'text';
}

/** FoamFile header keywords, which describe the file rather than the function. */
const BANNER_KEYWORDS = new Set(['FoamFile', 'version', 'format', 'class', 'object', 'location', 'note']);

/**
 * Keys every function object has because it IS a function object.
 *
 * `type` and `libs` say which C++ class to load; the execute/write controls say
 * when to fire during a solve. None of them is a parameter of the calculation,
 * and none means anything when the function is replayed over times that are
 * already on disk. `yPlus` is the clean example: its template holds these four
 * entries and nothing else, so a form built without this filter offered four
 * fields for a function whose whole call is `-func yPlus`.
 *
 * This is a short list of the base interface's own keys, not a catalogue of
 * functions — the functions themselves are still read from the installation.
 */
const FUNCTION_PLUMBING = new Set([
  'type', 'libs', 'enabled', 'log', 'region',
  'executeControl', 'executeInterval', 'writeControl', 'writeInterval',
  'timeStart', 'timeEnd', 'setFormat', 'writeFields',
]);

/**
 * Read one `etc/caseDicts/postProcessing/**` template.
 *
 * These files are self-describing, which is the find that makes a generated
 * form possible for all 127 configured function objects at once:
 *
 *   Description
 *       Writes graph data for specified fields along a line, …
 *
 *   start           <point>;
 *   nPoints         <number>;
 *   fields          (<fieldNames>);
 *   axis            distance; // The independent variable of the graph. …
 *
 * Name, prose, argument names, argument types and per-argument help are all
 * there. Nothing about the catalogue is hard-coded here.
 */
/** OpenFOAM's decorative `// *****…***** //` separator, not documentation. */
function isBannerRule(text: string): boolean {
  return /^[*\s/-]*$/.test(text) && /[*-]{4}/.test(text);
}

export function parseFunctionTemplate(content: string): FunctionTemplate {
  const lines = content.split('\n');

  const descriptionLines: string[] = [];
  let inDescription = false;
  for (const line of lines) {
    if (/^\s*Description\s*$/.test(line)) {
      inDescription = true;
      continue;
    }
    if (!inDescription) continue;
    // The banner's closing `\*---…` ends the block, as does a blank line
    // followed by it; stopping on the marker alone is enough in practice.
    if (/^\s*\\\*-+/.test(line)) break;
    descriptionLines.push(line.trim());
  }

  const args: FunctionArg[] = [];
  for (const line of lines) {
    // A help comment often wraps onto its own line:
    //     lRef        <lRef>;         // Reference length scale for moment
    //                                 // calculations; e.g., 1 m
    // Those continuations belong to the entry above, and dropping them loses
    // exactly the half of the sentence that carries the example.
    const continuation = line.match(/^\s*\/\/\s?(.*)$/);
    if (continuation && args.length) {
      const text = continuation[1].trim();
      const previous = args[args.length - 1];
      // The file ends with OpenFOAM's own `// ****…**** //` rule, which is a
      // comment line like any other and was being glued onto the last argument's
      // help text — every forces field ended in a row of asterisks.
      if (text && !isBannerRule(text)) previous.help = previous.help ? `${previous.help} ${text}` : text;
      continue;
    }

    // `keyword value;` optionally followed by `// help`. Directives such as
    // `#includeEtc` and the FoamFile banner are not entries and must not turn
    // into form fields.
    const match = line.match(/^\s*([A-Za-z][\w.]*)\s+(.+?);\s*(?:\/\/\s?(.*))?$/);
    if (!match) continue;
    const [, name, rawValue, comment] = match;
    if (BANNER_KEYWORDS.has(name) || FUNCTION_PLUMBING.has(name)) continue;

    const listWrapped = rawValue.startsWith('(') && rawValue.endsWith(')');
    const inner = listWrapped ? rawValue.slice(1, -1).trim() : rawValue.trim();
    const isPlaceholder = /^<[^>]+>$/.test(inner);
    const help = (comment ?? '').trim();
    args.push({
      name,
      kind: isPlaceholder ? placeholderKind(inner) : 'text',
      listWrapped,
      placeholder: inner,
      help: isBannerRule(help) ? '' : help,
      required: isPlaceholder,
    });
  }

  return {
    description: descriptionLines.join(' ').replace(/\s+/g, ' ').trim(),
    args,
  };
}

/**
 * Characters a composed `-func` specification may contain.
 *
 * The specification is built from form fields, but the values inside it are
 * still user text on its way to a shell. `shellQuote` already makes any content
 * safe as a single argument; this is the second lock, and it is deliberately an
 * allowlist of what an OpenFOAM entry actually needs — names, numbers, lists,
 * and the `"(inlet|outlet)"` regex form patch selections use. Everything that
 * could end the argument or begin a command — `;`, `$`, backticks, redirection,
 * newlines — is simply not in the language.
 */
const FUNCTION_SPEC_ALLOWED = /^[A-Za-z0-9_.,:+\-*/()=|"[\] ]*$/;

/** A function-object name as OpenFOAM writes them, nothing else. */
const FUNCTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

export class FunctionSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FunctionSpecError';
  }
}

/**
 * Put an entry's value into the parentheses OpenFOAM expects.
 *
 * The template's own spelling is not enough to decide this. `fields
 * (<fieldNames>);` shows the parentheses, so `listWrapped` is set and `p U` has
 * to become `(p U)` — but `start <point>;` shows none, and a point value is
 * still `(0.01 0.05 0.005)`. Composing from `listWrapped` alone therefore sent
 * `start=0.01 0.05 0.005` and OpenFOAM rejected the whole specification.
 *
 * The rule that covers both, and every `text` argument a user fills with a
 * vector such as `CofR` or `liftDir`: a value that is already ONE balanced
 * group is left alone, and anything else is wrapped when the entry is a list or
 * when it is more than a single token. `(0.005 0.005 0.005) (0.007 0.007 0.005)`
 * is two groups, not one, so a list of points correctly gains its outer pair.
 */
export function wrapFoamValue(value: string, listWrapped: boolean): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  const tokens = tokenizeFoamRow(trimmed);
  if (tokens.length === 1 && isTuple(tokens[0])) return trimmed;
  if (listWrapped || tokens.length > 1) return `(${trimmed})`;
  return trimmed;
}

/**
 * A concrete example for one argument, preferring what the template documents.
 *
 * The installed templates carry their own examples in the comment beside each
 * entry — `magUInf <magUInf>; // Far field velocity magnitude; e.g., 20 m/s` —
 * so the value offered comes from the OpenFOAM in use rather than from a table
 * written here. Only the value is taken, not the units: `20 m/s` is prose, `20`
 * is what the dictionary accepts.
 */
export function exampleArgValue(arg: FunctionArg, patches: readonly string[] = []): string {
  // An entry that already has a real value in the template is a default, and
  // the default is the best example there is.
  if (!arg.required && arg.placeholder && !/^<.*>$/.test(arg.placeholder)) {
    return arg.listWrapped ? `(${arg.placeholder})` : arg.placeholder;
  }

  const documented = arg.help.match(/e\.g\.,?\s*(\([^)]*\)|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/);
  if (documented) return documented[1];

  switch (arg.kind) {
    case 'point': return '(0 0 0)';
    case 'pointList': return '((0 0 0))';
    case 'number': return '100';
    case 'fieldName': return 'p';
    case 'fieldList': return '(p U)';
    // A patch of THIS case, when the case could be asked. Naming a patch that
    // does not exist is the kind of wrong example that wastes a run.
    case 'patchName': return patches.length ? patches[0] : arg.placeholder;
    case 'patchList': return patches.length ? `(${patches[0]})` : arg.placeholder;
    default:
      // An undocumented placeholder is left visible, so it reads as a hole to
      // fill rather than as a value that was chosen for a reason.
      return arg.placeholder || 'value';
  }
}

/**
 * The whole call, ready to run and ready to edit.
 *
 * This is what the Compute panel puts in front of the user instead of a
 * generated form. A form has to invent one control per argument and gets some
 * of them wrong; a line of text is exactly what OpenFOAM accepts, is what every
 * tutorial writes, and can be corrected by anyone who knows the syntax.
 *
 * `name=` comes first because the tutorials use it and because without it the
 * output lands in a directory named after the whole call with its spaces
 * stripped — `graphUniform(start=(0.010.050.005),nPoints=20,...)` — which is
 * unreadable and cannot be parsed back into its numbers.
 */
export function buildCallTemplate(
  name: string,
  args: readonly FunctionArg[],
  patches: readonly string[] = [],
): string {
  const parts = [`name=${name}`];
  for (const arg of args) {
    if (!arg.required) continue;
    parts.push(`${arg.name}=${exampleArgValue(arg, patches)}`);
  }
  return `${name}(${parts.join(', ')})`;
}

/** The retroactive utility, under either of the names the line has used. */
export const POST_PROCESS_NAMES = ['foamPostProcess', 'postProcess'] as const;

export interface ParsedCommand {
  spec: string;
  time?: string;
  fields?: string[];
  region?: string;
  latestTime?: boolean;
  noZero?: boolean;
}

/**
 * Split a command line into arguments, respecting quotes.
 *
 * `-func "graphUniform(start=(0 0 0))"` is ONE argument containing spaces and
 * brackets; splitting on whitespace would turn it into four and lose the call.
 */
export function tokenizeCommand(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of text.replace(/\s+/g, ' ')) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === ' ') {
      if (started || current) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
  }
  if (started || current) tokens.push(current);
  return tokens.filter((token, index) => token !== '' || index < tokens.length);
}

/**
 * Read the command the user edited into the pieces the runner accepts.
 *
 * The whole line is editable, which is what makes the panel usable — but an
 * editable line must not become an editable shell. Only the flags this utility
 * needs are recognised, each value is checked, and anything else is refused by
 * name so the message says what to remove. `-case` in particular is not
 * accepted: the run is confined to the case that is open.
 */
export function parsePostProcessCommand(text: string, known: readonly string[]): ParsedCommand {
  const tokens = tokenizeCommand(text.trim());
  if (!tokens.length) throw new FunctionSpecError('Type a command to run');

  let index = 0;
  if (!tokens[0].startsWith('-')) {
    if (!(POST_PROCESS_NAMES as readonly string[]).includes(tokens[0])) {
      throw new FunctionSpecError(`A command starts with ${POST_PROCESS_NAMES.join(' or ')}, not ${tokens[0]}`);
    }
    index = 1;
  }

  const parsed: ParsedCommand = { spec: '' };
  const valueOf = (flag: string): string => {
    const value = tokens[index + 1];
    if (value === undefined || (value.startsWith('-') && value.length > 1 && !/^-?\d/.test(value))) {
      throw new FunctionSpecError(`${flag} needs a value`);
    }
    index += 2;
    return value;
  };

  while (index < tokens.length) {
    const flag = tokens[index];
    switch (flag) {
      case '-func': parsed.spec = validateTypedSpec(valueOf(flag), known); break;
      case '-time': {
        const value = valueOf(flag);
        if (!/^[0-9.,:\-+eE ]{1,120}$/.test(value)) throw new FunctionSpecError('The time range is not valid');
        parsed.time = value;
        break;
      }
      case '-fields': {
        const value = valueOf(flag).replace(/^\(|\)$/g, '');
        const fields = value.split(/[\s,]+/).filter(Boolean);
        for (const field of fields) {
          if (!/^[A-Za-z][\w.]{0,63}$/.test(field)) throw new FunctionSpecError(`Not a field name: ${field}`);
        }
        parsed.fields = fields;
        break;
      }
      case '-region': {
        const value = valueOf(flag);
        if (!/^[A-Za-z][\w.]{0,63}$/.test(value)) throw new FunctionSpecError('The region name is not valid');
        parsed.region = value;
        break;
      }
      case '-latestTime': parsed.latestTime = true; index += 1; break;
      case '-noZero': parsed.noZero = true; index += 1; break;
      default:
        throw new FunctionSpecError(
          flag.startsWith('-')
            ? `${flag} is not one of the options this panel runs: -func, -time, -fields, -region, -latestTime, -noZero`
            : `Unexpected "${flag}" — arguments belong inside -func "…"`,
        );
    }
  }

  if (!parsed.spec) throw new FunctionSpecError('The command needs a -func "…" to run');
  return parsed;
}

/** The default command for a chosen function: the call, ready to edit. */
export function buildCommandTemplate(utility: string, spec: string): string {
  return `${utility} -func "${spec}"`;
}

/**
 * The `controlDict` entry that runs the same function during the solve.
 *
 * Offered as text to copy, never written: the app does not edit the user's
 * `controlDict` for them. `#includeFunc` is the form every OpenFOAM 14 tutorial
 * uses, and it takes the same call this panel already runs retroactively.
 */
export function buildFunctionsEntry(spec: string): string {
  return `functions\n{\n    #includeFunc ${spec.trim().replace(/;$/, '')}\n}`;
}

/**
 * Check a specification the user typed, and return it cleaned.
 *
 * Composing from form fields could guarantee the shape; free text cannot, so it
 * is checked here instead: a leading function name that this installation
 * actually offers, balanced parentheses, and nothing outside the character set
 * an OpenFOAM entry needs. A trailing `;` is accepted because tutorials write
 * one and it is not part of the call.
 */
export function validateTypedSpec(text: string, known: readonly string[]): string {
  const spec = text.trim().replace(/;+$/, '').trim();
  if (!spec) throw new FunctionSpecError('Type a function object to run');
  if (spec.length > 1024) throw new FunctionSpecError('Function specification is too long');
  if (!FUNCTION_SPEC_ALLOWED.test(spec)) {
    throw new FunctionSpecError('The specification contains characters that are not allowed');
  }

  const leading = spec.match(/^([A-Za-z][A-Za-z0-9_.]{0,63})\s*(\(|$)/);
  if (!leading) throw new FunctionSpecError('A specification starts with a function object name');
  const name = leading[1];
  if (known.length && !known.includes(name)) {
    throw new FunctionSpecError(`${name} is not available in this OpenFOAM installation`);
  }

  if (leading[2] === '(') {
    if (!spec.endsWith(')')) throw new FunctionSpecError('The arguments are missing their closing bracket');
    let depth = 0;
    for (const char of spec) {
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      if (depth < 0) throw new FunctionSpecError('The brackets are unbalanced');
    }
    if (depth !== 0) throw new FunctionSpecError('The brackets are unbalanced');
  }
  return spec;
}

/**
 * Compose the `-func` argument from a chosen function and its filled-in fields.
 *
 * `known` is the list `foamPostProcess -list` reported for THIS installation:
 * the name is checked against it rather than against anything written here, so
 * a version that gained or lost function objects stays correct, and a name that
 * was never offered cannot be smuggled in.
 */
export function buildFunctionSpec(
  name: string,
  values: Record<string, string>,
  known: readonly string[],
): string {
  if (!FUNCTION_NAME_PATTERN.test(name)) {
    throw new FunctionSpecError(`Invalid function object name: ${name}`);
  }
  if (known.length && !known.includes(name)) {
    throw new FunctionSpecError(`${name} is not available in this OpenFOAM installation`);
  }

  const parts: string[] = [];
  for (const [key, rawValue] of Object.entries(values)) {
    const value = rawValue.trim();
    if (!value) continue;
    if (!FUNCTION_NAME_PATTERN.test(key)) {
      throw new FunctionSpecError(`Invalid argument name: ${key}`);
    }
    if (!FUNCTION_SPEC_ALLOWED.test(value)) {
      throw new FunctionSpecError(`Argument ${key} contains characters that are not allowed`);
    }
    parts.push(`${key}=${value}`);
  }

  const spec = parts.length ? `${name}(${parts.join(', ')})` : name;
  if (spec.length > 1024) throw new FunctionSpecError('Function specification is too long');
  if (!FUNCTION_SPEC_ALLOWED.test(spec)) throw new FunctionSpecError('Function specification is not valid');
  return spec;
}

/**
 * Turn a `postProcessing/` directory name back into something readable.
 *
 * OpenFOAM names the directory after the whole call and strips the spaces out
 * of it, so a graph arrives as
 * `graphUniform(start=(0.010.050.005),end=(0.090.050.005),nPoints=20,fields=(pU))`.
 * The numbers in it are unrecoverable — `(0.010.050.005)` cannot be split back
 * into three — so nothing is reconstructed here: the base name is separated
 * from its arguments for display, and the raw name stays the identity.
 */
export function describeDatasetName(directoryName: string): { base: string; arguments: string } {
  const open = directoryName.indexOf('(');
  if (open === -1 || !directoryName.endsWith(')')) return { base: directoryName, arguments: '' };
  return {
    base: directoryName.slice(0, open),
    arguments: directoryName.slice(open + 1, -1),
  };
}

/**
 * Files under a function's time directory that are not tables.
 *
 * Surfaces and VTK output belong to the ParaView tab, which can already open
 * files from inside the case; listing them here as unreadable charts would be
 * worse than not listing them at all.
 */
const NON_TABULAR_EXTENSIONS = new Set([
  '.vtk', '.vtp', '.vtu', '.vtm', '.vtkhdf', '.obj', '.stl', '.ply', '.case', '.foam', '.png', '.gz',
]);

export function isTabularOutput(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return true; // probes write `p`, `U` with no extension at all
  return !NON_TABULAR_EXTENSIONS.has(fileName.slice(dot).toLowerCase());
}

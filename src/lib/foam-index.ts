/**
 * The installed OpenFOAM's own answer to "what is valid here".
 *
 * WHY THIS EXISTS
 *
 * An LLM's knowledge of OpenFOAM is an average of everything it read, and what
 * it read is dominated by v9/v10 and by the ESI variant. The Foundation line
 * renames things: `atmBoundaryLayerInletEpsilon` on 13 is
 * `atmosphericBoundaryLayerTurbulentEpsilon` on 14, and the two installs on
 * this machine differ by 668 lines of run-time selection entries. No amount of
 * model quality recovers that — it is a property of the binaries on disk.
 *
 * So we ask the binaries. `foamToC` (OpenFOAM 11+) dumps every run-time
 * selection table, and every executable answers `-help`. Together that is the
 * complete, authoritative vocabulary of the installed version, and it costs
 * about eleven seconds to collect:
 *
 *   foamToC -all           0.96 s   249 KB   every selectable type
 *   foamToC -scalarBCs     ~0.9 s    10 KB   curated: scalar boundary conditions
 *   foamToC -vectorBCs     ~0.9 s     6 KB   curated: vector boundary conditions
 *   …plus solvers, functionObjects, fvModels, fvConstraints
 *   -help of 151 binaries  4.6 s    142 KB   every application and its options
 *
 * The index is never sent to the model whole (that would be ~98k tokens). The
 * copilot receives SLICES — the boundary-condition list when the question is
 * about boundary conditions, and nothing when it is not — and generated files
 * are checked against the flat name map before the user can apply them.
 *
 * On OpenFOAM 9/10 `foamToC` does not exist; the index is then limited to the
 * applications, and callers degrade to "unknown" rather than to a wrong answer.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { foamSource, getOpenFOAMVersion, findBashrc, runInWslScriptAsync } from './wsl';

const CACHE_PATH = path.join(os.homedir(), '.wslgui-foam-index.json');

/** Bump when the shape below changes, so old caches are discarded. */
const INDEX_FORMAT = 2;

export interface FoamApplication {
  name: string;
  /** Option flags, without descriptions: `-case`, `-parallel`, … */
  options: string[];
}

export interface FoamIndex {
  format: number;
  /** WM_PROJECT_VERSION as the install reports it, e.g. "14". */
  version: string;
  /** Which install this came from — the cache is invalid if the user switches. */
  bashrc: string;
  builtAt: string;
  /** Whether foamToC was available (false on 9/10: names cannot be validated). */
  hasToC: boolean;

  /** Every selectable name → the tables that offer it. The validation set. */
  names: Record<string, string[]>;

  /** Curated lists, straight from foamToC's own convenience flags. */
  boundaryConditions: { scalar: string[]; vector: string[] };
  solvers: string[];
  functionObjects: string[];
  fvModels: string[];
  fvConstraints: string[];

  applications: FoamApplication[];

  /**
   * The dictionary keys each type accepts, inherited keys included.
   *
   * `foamToC` answers "does this name exist"; this answers "and what goes
   * inside it" — the difference between knowing `nutkWallFunction` is real and
   * knowing it takes Cmu, kappa and E. Extracted from the sources, so it is as
   * good as the extraction: use it to TELL the model what the keys are, never
   * to tell the user a key is wrong (see the comment on parseKeys).
   */
  keysByType: Record<string, string[]>;
}

// ── Cache ───────────────────────────────────────────────────────────────────

let memoryIndex: FoamIndex | null = null;
let building: Promise<FoamIndex | null> | null = null;
let buildInFlight = false;

function loadCache(): FoamIndex | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) as FoamIndex;
    if (raw?.format !== INDEX_FORMAT) return null;
    if (!raw.names || !raw.version) return null;
    return raw;
  } catch {
    return null;
  }
}

function saveCache(index: FoamIndex): void {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(index), 'utf-8');
  } catch { /* best effort: the index is rebuildable */ }
}

/** True when the cached index still describes the install now selected. */
function isFresh(index: FoamIndex | null): index is FoamIndex {
  if (!index) return false;
  let bashrc = '';
  try { bashrc = findBashrc(); } catch { /* WSL down: trust the cache */ }
  return !bashrc || index.bashrc === bashrc;
}

/**
 * The index if it is already available, without touching WSL.
 *
 * The chat route uses this: a message must never block for eleven seconds
 * waiting for a first build. It kicks off the build and answers this turn
 * without the slice.
 */
export function getFoamIndexIfReady(): FoamIndex | null {
  if (!memoryIndex) memoryIndex = loadCache();
  return isFresh(memoryIndex) ? memoryIndex : null;
}

/** Build if needed. Concurrent callers share one build. */
export function ensureFoamIndex(force = false): Promise<FoamIndex | null> {
  if (!force) {
    const ready = getFoamIndexIfReady();
    if (ready) return Promise.resolve(ready);
  }
  if (building) return building;
  buildInFlight = true;
  building = (async () => {
    try {
      const index = await buildFoamIndex();
      memoryIndex = index;
      saveCache(index);
      return index;
    } catch (e) {
      console.error('[foam-index] build failed:', e instanceof Error ? e.message : e);
      return null;
    } finally {
      buildInFlight = false;
      building = null;
    }
  })();
  return building;
}

export function isBuilding(): boolean {
  return buildInFlight;
}

// ── Build ───────────────────────────────────────────────────────────────────

const MARK = '@@FOAMIDX@@';

/** A literal line break, kept as a constant so it never has to be typed
 *  inside a string in this file. */
const NEWLINE = String.fromCharCode(10);

/**
 * Collect everything in a SINGLE WSL call.
 *
 * One call matters: each `wsl.exe` spawn costs a fixed ~0.5-1.5 s, and there
 * are 158 commands to run here. Inside one bash they cost what they actually
 * cost — measured at 11 s in total, against roughly three minutes if each were
 * its own call.
 */
export async function buildFoamIndex(): Promise<FoamIndex> {
  const src = foamSource();
  const script = `#!/bin/bash
${src}
echo "${MARK}version"
echo "$WM_PROJECT_VERSION"
if command -v foamToC > /dev/null 2>&1; then
  echo "${MARK}toc"
  echo "yes"
  cd /tmp || cd /
  echo "${MARK}all";            foamToC -all 2>/dev/null
  echo "${MARK}scalarBCs";      foamToC -scalarBCs 2>/dev/null
  echo "${MARK}vectorBCs";      foamToC -vectorBCs 2>/dev/null
  echo "${MARK}solvers";        foamToC -solvers 2>/dev/null
  echo "${MARK}functionObjects"; foamToC -functionObjects 2>/dev/null
  echo "${MARK}fvModels";       foamToC -fvModels 2>/dev/null
  echo "${MARK}fvConstraints";  foamToC -fvConstraints 2>/dev/null
else
  echo "${MARK}toc"
  echo "no"
fi
echo "${MARK}apps"
BIN=$(ls -d "$FOAM_APPBIN" 2>/dev/null | head -1)
if [ -d "$BIN" ]; then
  for f in "$BIN"/*; do
    [ -x "$f" ] || continue
    echo "${MARK}app $(basename "$f")"
    timeout 5 "$f" -help 2>&1 | sed -n '/^options:/,/^$/p'
  done
fi
echo "${MARK}types"
grep -rn --include=*.H -oE 'TypeName\\("[^"]+"\\)' $FOAM_SRC $FOAM_APP 2>/dev/null
echo "${MARK}classes"
grep -rn --include=*.H -E '^class [A-Za-z_]|^ +public [A-Za-z_]' $FOAM_SRC $FOAM_APP 2>/dev/null
echo "${MARK}keys"
grep -rn --include=*.C --include=*.H -oE '[A-Za-z_][A-Za-z0-9_]*\\.(lookup|lookupOrDefault|readIfPresent|found)(<[^>]*>)?[[:space:]]*\\([[:space:]]*"[A-Za-z_][A-Za-z0-9_]*"' $FOAM_SRC $FOAM_APP 2>/dev/null
echo "${MARK}coeffs"
grep -rn --include=*.C --include=*.H -oE '[A-Za-z_][A-Za-z0-9_]*_\\([[:space:]]*"[A-Za-z][A-Za-z0-9_]*"[[:space:]]*,[[:space:]]*(this->)?(typeDict|coeffDict|dict)' $FOAM_SRC $FOAM_APP 2>/dev/null
echo "${MARK}end"
`;

  // 120s: the measured build is ~8 s, but a cold WSL adds its own start-up.
  const out = await runInWslScriptAsync(Buffer.from(script).toString('base64'), 120000);
  const sections = splitSections(out);
  console.log('[foam-index] raw sections: ' + [...sections].map(([k, v]) => k + '=' + v.length).join(' '));

  const version = (sections.get('version') || '').trim() || getOpenFOAMVersion().trim();
  const hasToC = (sections.get('toc') || '').trim() === 'yes';

  const names: Record<string, string[]> = {};
  if (hasToC) {
    for (const [name, table] of parseToCAll(sections.get('all') || '')) {
      (names[name] ||= []).push(table);
      names[name] = [...new Set(names[name])];
    }
  }

  const scalar = parseToCTable(sections.get('scalarBCs') || '');
  const vector = parseToCTable(sections.get('vectorBCs') || '');
  // The curated lists are also selectable names; -all groups them under table
  // classes whose names nobody would guess, so index them by role as well.
  for (const n of scalar) (names[n] ||= []).push('patchField<scalar>');
  for (const n of vector) (names[n] ||= []).push('patchField<vector>');

  const index: FoamIndex = {
    format: INDEX_FORMAT,
    version,
    bashrc: (() => { try { return findBashrc(); } catch { return ''; } })(),
    builtAt: new Date().toISOString(),
    hasToC,
    names,
    boundaryConditions: { scalar, vector },
    solvers: parseToCTable(sections.get('solvers') || ''),
    functionObjects: parseToCTable(sections.get('functionObjects') || ''),
    fvModels: parseToCTable(sections.get('fvModels') || ''),
    fvConstraints: parseToCTable(sections.get('fvConstraints') || ''),
    applications: parseApps(out),
    keysByType: parseKeys(
      sections.get('types') || '',
      sections.get('classes') || '',
      // The two ways a class reads from a dictionary: explicit lookups, and
      // member initialisers like `Cmu_("Cmu", this->typeDict(type), 0.09)`,
      // which is how every turbulence model declares its coefficients.
      (sections.get('keys') || '') + (sections.get('coeffs') || ''),
    ),
  };
  return index;
}

function splitSections(out: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith(MARK)) {
      if (current) sections.set(current, buffer.join('\n'));
      const rest = line.slice(MARK.length).trim();
      current = rest.split(' ')[0];
      buffer = [];
      // Application blocks repeat the same key; they are parsed from the raw
      // output instead (parseApps), so only the first is kept here.
      if (current === 'app') current = null;
      continue;
    }
    if (current) buffer.push(line);
  }
  if (current) sections.set(current, buffer.join('\n'));
  return sections;
}

/**
 * Parse `foamToC -all`, which is an OpenFOAM-serialised list:
 *
 *     ToC:
 *     316
 *     (
 *     fvPatch (patch
 *     24
 *     (
 *     wall libfiniteVolume.so
 *     …
 *     ))
 *     …
 *     )
 *
 * The header line carries the C++ class and, in brackets, the table name; the
 * entries that follow are `<selectable name> <library>`.
 */
function* parseToCAll(text: string): Generator<[string, string]> {
  let table: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line === '(' || line === ')' || line === 'ToC:' || /^\d+$/.test(line)) continue;

    const header = line.match(/^(\S+)\s+\((\S+)\s*$/);
    if (header) { table = header[2]; continue; }

    // `name lib.so` — possibly with the block's closing `))` attached.
    const entry = line.replace(/\)+$/, '').trim().match(/^(\S+)\s+(\S+\.so)$/);
    if (entry && table) yield [entry[1], table];
  }
}

/** Parse the convenience flags: `    name    library.so` under a heading. */
function parseToCTable(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.startsWith('    ')) continue;
    const m = raw.trim().match(/^(\S+)(\s+\S+\.so)?$/);
    if (m && !m[1].endsWith(':')) out.push(m[1]);
  }
  return [...new Set(out)].sort();
}

/** Every `@@FOAMIDX@@app <name>` block, with the option flags it listed. */
function parseApps(out: string): FoamApplication[] {
  const apps: FoamApplication[] = [];
  let current: FoamApplication | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith(MARK + 'app ')) {
      if (current) apps.push(current);
      current = { name: line.slice((MARK + 'app ').length).trim(), options: [] };
      continue;
    }
    if (line.startsWith(MARK)) { if (current) { apps.push(current); current = null; } continue; }
    if (!current) continue;
    const m = line.match(/^\s{2}(-[A-Za-z][A-Za-z0-9]*)/);
    if (m) current.options.push(m[1]);
  }
  if (current) apps.push(current);
  return apps.filter(a => a.name).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Work out which dictionary keys each selectable type accepts.
 *
 * Three greps' worth of raw material are stitched here rather than in bash,
 * because the answer needs a graph:
 *
 *   TypeName("nutkWallFunction")   is declared in nutkWallFunctionFvPatchScalarField.H
 *   that class                     derives from nutWallFunctionFvPatchScalarField
 *   and it is the PARENT           that reads Cmu, kappa and E
 *
 * A extractor that only looked at the file declaring the type would report that
 * nutkWallFunction takes no parameters at all — confidently, and wrongly. So:
 * map type → class, class → base classes, class → its own keys, then walk up.
 *
 * IMPORTANT — this is a best effort, and is treated as one. Keys can also come
 * from templates, from constructor helpers, and from receivers this grep does
 * not recognise. The result is good enough to TELL the model what a type
 * accepts; it is never used to tell the user that a key is invalid, because a
 * missing key here would be indistinguishable from a wrong one there.
 */
function splitLines(text: string): string[] {
  // A helper rather than an inline literal, so a line break never has to be
  // written inside a string in this file.
  return text.split(String.fromCharCode(10));
}

function parseKeys(typesRaw: string, classesRaw: string, keysRaw: string): Record<string, string[]> {
  // grep -n output is `path:line:match`; paths hold no colons in this tree.
  const split = (line: string) => {
    const first = line.indexOf(':');
    const second = line.indexOf(':', first + 1);
    if (first < 0 || second < 0) return null;
    const lineNo = Number(line.slice(first + 1, second));
    if (!Number.isFinite(lineNo)) return null;
    return { file: line.slice(0, first), line: lineNo, text: line.slice(second + 1) };
  };

  /** file → [{ line, class }], so a TypeName can find its enclosing class. */
  const classDecls = new Map<string, { line: number; name: string }[]>();
  /** class → base classes, template arguments stripped. */
  const bases = new Map<string, string[]>();
  /** class name → the files that declare it, to find its keys. */
  const classFiles = new Map<string, Set<string>>();

  let lastClass: { file: string; line: number; name: string } | null = null;
  for (const raw of classesRaw.split(/\r?\n/)) {
    const p = split(raw);
    if (!p) continue;
    const decl = p.text.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (decl) {
      lastClass = { file: p.file, line: p.line, name: decl[1] };
      if (!classDecls.has(p.file)) classDecls.set(p.file, []);
      classDecls.get(p.file)!.push({ line: p.line, name: decl[1] });
      if (!classFiles.has(decl[1])) classFiles.set(decl[1], new Set());
      classFiles.get(decl[1])!.add(p.file);
      continue;
    }
    const base = p.text.match(/^\s+public\s+([A-Za-z_][A-Za-z0-9_:]*)/);
    // Within four lines of the declaration: `class X`, `:`, `public A,`,
    // `public B`. Further than that and it is a different construct.
    if (base && lastClass && lastClass.file === p.file && p.line - lastClass.line <= 4) {
      const name = base[1].split('::').pop()!;
      if (!bases.has(lastClass.name)) bases.set(lastClass.name, []);
      bases.get(lastClass.name)!.push(name);
    }
  }

  /** file → keys read in it. */
  const keysByFile = new Map<string, Set<string>>();
  for (const raw of keysRaw.split(/\r?\n/)) {
    const p = split(raw);
    if (!p) continue;
    const key = p.text.match(/"([A-Za-z_][A-Za-z0-9_]*)"/);
    if (!key) continue;
    // `found("…")` is a test, not a read, but a type that tests for a key does
    // accept it — both belong in the list.
    if (!keysByFile.has(p.file)) keysByFile.set(p.file, new Set());
    keysByFile.get(p.file)!.add(key[1]);
  }

  /** A class's own keys: whatever its .H and matching .C read. */
  const ownKeys = (cls: string): Set<string> => {
    const out = new Set<string>();
    for (const header of classFiles.get(cls) || []) {
      for (const candidate of [header, header.replace(/\.H$/, '.C')]) {
        for (const k of keysByFile.get(candidate) || []) out.add(k);
      }
    }
    return out;
  };

  const resolved = new Map<string, string[]>();
  const walk = (cls: string, seen: Set<string>): string[] => {
    if (resolved.has(cls)) return resolved.get(cls)!;
    if (seen.has(cls)) return [];          // cycles cannot happen in C++, but be safe
    seen.add(cls);
    const keys = ownKeys(cls);
    for (const base of bases.get(cls) || []) {
      for (const k of walk(base, seen)) keys.add(k);
    }
    const list = [...keys].sort();
    resolved.set(cls, list);
    return list;
  };

  const out: Record<string, string[]> = {};
  for (const raw of typesRaw.split(/\r?\n/)) {
    const p = split(raw);
    if (!p) continue;
    const name = p.text.match(/TypeName\("([^"]+)"\)/);
    if (!name) continue;

    // The class that owns this TypeName is the last one declared above it.
    const decls = classDecls.get(p.file) || [];
    let owner: string | null = null;
    for (const d of decls) {
      if (d.line < p.line && (!owner || d.line > decls.find(x => x.name === owner)!.line)) owner = d.name;
    }
    if (!owner) continue;

    const keys = walk(owner, new Set());
    if (keys.length) out[name[1]] = keys;
  }
  return out;
}

// ── Slices for the prompt ───────────────────────────────────────────────────

export type SliceTopic =
  | 'boundaryConditions' | 'solvers' | 'functionObjects'
  | 'fvModels' | 'applications' | 'turbulence';

/**
 * Which slices a question needs, from the words in it.
 *
 * Deliberately generous on the trigger words and small on the payload: a slice
 * that is included needlessly costs a few hundred tokens, while a slice that is
 * missing costs a wrong answer.
 */
export function topicsFor(text: string): SliceTopic[] {
  const t = text.toLowerCase();
  const topics = new Set<SliceTopic>();
  if (/\bboundar|\bpatch|\bbc\b|condizion|wall function|inlet|outlet|fixedvalue|zerogradient|noslip|type\s+\w+;/.test(t))
    topics.add('boundaryConditions');
  if (/\bsolver|controldict|foamrun|application|simplefoam|pimplefoam|interfoam|steady|transient/.test(t))
    topics.add('solvers');
  if (/\bfunction ?object|postprocess|probe|forces|residual|sample|monitor/.test(t))
    topics.add('functionObjects');
  if (/\bfvmodel|fvoption|source term|fvconstraint|limit|porous/.test(t))
    topics.add('fvModels');
  if (/\bturbulen|\bras\b|\bles\b|kepsilon|komega|spalart|momentumtransport/.test(t))
    topics.add('turbulence');
  if (/\bcommand|\brun\b|\butilit|blockmesh|checkmesh|snappy|decompose|reconstruct|paraview|foamlog/.test(t))
    topics.add('applications');
  return [...topics];
}

/**
 * Types named in a piece of text, so their accepted keys can be attached.
 *
 * Only names of five characters or more, and only as whole words: shorter ones
 * ("value", "wall", "slip") are ordinary English in a question about CFD, and
 * matching them would attach lists nobody asked for.
 */
export function typesMentioned(index: FoamIndex, text: string, limit = 4): string[] {
  const found: string[] = [];
  for (const name of Object.keys(index.keysByType)) {
    if (name.length < 5) continue;
    if (new RegExp(`\\b${name}\\b`).test(text)) found.push(name);
    if (found.length >= limit) break;
  }
  return found;
}

/** Render the requested slices as a compact block for the prompt. */
export function renderSlices(index: FoamIndex, topics: SliceTopic[], question = ''): string {
  const mentioned = question ? typesMentioned(index, question) : [];
  if (!topics.length && !mentioned.length) return '';
  const parts: string[] = [];
  const list = (title: string, names: string[]) =>
    names.length ? `${title} (${names.length}):\n${names.join(' ')}` : '';

  for (const topic of topics) {
    switch (topic) {
      case 'boundaryConditions': {
        parts.push(list('Valid boundary condition types for scalar fields (p, k, epsilon, T, nut…)', index.boundaryConditions.scalar));
        parts.push(list('Valid boundary condition types for vector fields (U…)', index.boundaryConditions.vector));
        break;
      }
      case 'solvers':
        parts.push(list(
          index.hasToC
            ? 'Valid solver modules for `solver` in system/controlDict (run with foamRun)'
            : 'Solvers',
          index.solvers,
        ));
        break;
      case 'functionObjects':
        parts.push(list('Valid functionObject types', index.functionObjects));
        break;
      case 'fvModels':
        parts.push(list('Valid fvModel types', index.fvModels));
        parts.push(list('Valid fvConstraint types', index.fvConstraints));
        break;
      case 'turbulence': {
        const ras = namesInTable(index, 'RAS');
        const les = namesInTable(index, 'LES');
        parts.push(list('Valid RAS model names for constant/momentumTransport', ras));
        parts.push(list('Valid LES model names', les));
        break;
      }
      case 'applications':
        parts.push(list('Executables available in this installation', index.applications.map(a => a.name)));
        break;
    }
  }
  // What goes INSIDE the entries the question named. foamToC answers "does this
  // exist"; this answers "and what do I write in it".
  for (const name of mentioned) {
    const keys = index.keysByType[name];
    if (keys?.length) {
      parts.push(
        `Keys accepted by ${name} (extracted from this version's sources, inherited ones included): ${keys.join(' ')}`,
      );
    }
  }

  const body = parts.filter(Boolean).join('\n\n');
  if (!body) return '';
  return `[Ground truth from the installed OpenFOAM ${index.version} — these lists come from the installation itself (foamToC), NOT from memory. Any name outside them does not exist in this version.]\n${body}`;
}

export function namesInTable(index: FoamIndex, table: string): string[] {
  const out: string[] = [];
  for (const [name, tables] of Object.entries(index.names)) {
    if (tables.some(t => t === table || t.startsWith(table))) out.push(name);
  }
  return out.sort();
}

/** The options a given executable accepts, for a targeted answer. */
export function applicationOptions(index: FoamIndex, name: string): string[] | null {
  return index.applications.find(a => a.name === name)?.options ?? null;
}

// ── Syntax check ────────────────────────────────────────────────────────────

export interface SyntaxProblem {
  path: string;
  /** The parser's own words, e.g. "ill defined primitiveEntry …on line 7". */
  message: string;
  line: number | null;
}

/**
 * Parse proposed files with OpenFOAM's own parser before they are written.
 *
 * The name check answers "does this type exist"; this answers "will this file
 * even load". They are different failures: a missing semicolon or a malformed
 * vector passes every name check and then stops the run on the first read, with
 * an error that points at a line number in a file the user did not write.
 *
 * `foamDictionary` is the parser, run on a copy in /tmp — nothing is written
 * into the case. It exits non-zero and explains itself on stderr:
 *
 *   ill defined primitiveEntry starting at keyword 'type' on line 7
 *
 * Note what it does NOT catch: a missing final brace is tolerated. It is a
 * parser, not a linter, and this check is about the errors it does catch.
 */
export async function checkDictSyntax(
  files: { path: string; content: string }[],
): Promise<SyntaxProblem[]> {
  if (!files.length) return [];

  const src = foamSource();
  const parts = files.map((f, i) => {
    const b64 = Buffer.from(f.content).toString('base64');
    return [
      `echo "${b64}" | base64 -d > "$D/f${i}"`,
      `echo "${MARK}file ${i}"`,
      `foamDictionary "$D/f${i}" > /dev/null 2> "$D/e${i}"; echo "exit=$?"`,
      `cat "$D/e${i}"`,
    ].join(NEWLINE);
  });

  // `cd "$D"` is not tidiness. Every OpenFOAM binary inspects its working
  // directory, and the server's cwd is a Windows path mounted under /mnt/c —
  // which contains a space in this user's home. OpenFOAM's fileName::stripInvalid
  // treats that as invalid and ABORTS (exit 134) before parsing anything, so
  // every file would come back "broken". Anything in this app that runs an
  // OpenFOAM binary has to move to a Linux-side directory first.
  const script = `#!/bin/bash
${src}
D=$(mktemp -d)
cd "$D" || exit 1
${parts.join(NEWLINE)}
cd / && rm -rf "$D"
echo "${MARK}end"
`;

  let out = '';
  try {
    // 60 s for the batch: foamDictionary is ~0.2 s per file once WSL is warm.
    out = await runInWslScriptAsync(Buffer.from(script).toString('base64'), 60000);
  } catch {
    return [];   // the check could not run; never block the user on that
  }

  const problems: SyntaxProblem[] = [];
  const blocks = out.split(MARK + 'file ');
  for (const block of blocks.slice(1)) {
    const nl = block.indexOf(String.fromCharCode(10));
    if (nl < 0) continue;
    const index = Number(block.slice(0, nl).trim());
    const body = block.slice(nl + 1);
    const code = body.match(/exit=(\d+)/);
    if (!code || code[1] === '0') continue;

    const file = files[index];
    if (!file) continue;

    // The parser's own sentence, which is the only part worth showing:
    //   --> FOAM FATAL IO ERROR:
    //   "ill defined primitiveEntry starting at keyword 'type' on line 7 …"
    // Line-based rather than a multi-line regex: the sentence always sits on
    // the line after the FATAL header.
    const lines = body.split(NEWLINE).map(l => l.trim()).filter(Boolean);
    const headerAt = lines.findIndex(l => l.includes('FOAM FATAL'));
    const sentence = headerAt >= 0 ? (lines[headerAt + 1] || '') : '';
    const quoted = sentence.match(/^"?([^"]+)"?$/);
    const atLine = body.match(/at line (\d+)/);
    problems.push({
      path: file.path,
      message: (quoted?.[1] || sentence || 'OpenFOAM could not parse this file').trim(),
      line: atLine ? Number(atLine[1]) : null,
    });
  }
  return problems;
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface NameProblem {
  name: string;
  /** Where it appeared, e.g. "0/U · inlet". */
  where: string;
  suggestions: string[];
}

/**
 * Check an OpenFOAM dictionary against the installation.
 *
 * Three entries carry a selectable name, and each is checked against the right
 * namespace rather than against "does this word exist somewhere":
 *
 *   type   inside boundaryField{}   → the patch-field tables
 *   model  inside RAS{} / LES{}     → the turbulence-model tables
 *   solver at the top of controlDict → the solver-module table
 *
 * The namespace matters. `distributionSizeGroup` exists on OpenFOAM 14 — but as
 * a field source, not as a boundary condition. Checking only for existence
 * would wave it through in a boundaryField, which is precisely where it does
 * not belong.
 *
 * Everything else is left alone on purpose: a dictionary is full of words that
 * are patch names, file names or physical quantities, and flagging those would
 * teach the user to ignore the warnings.
 */
export function validateDictText(index: FoamIndex, text: string, label: string): NameProblem[] {
  const problems: NameProblem[] = [];
  if (!index.hasToC) return problems;

  const bcNames = new Set([...index.boundaryConditions.scalar, ...index.boundaryConditions.vector]);
  const turbulence = new Set([...namesInTable(index, 'RAS'), ...namesInTable(index, 'LES')]);
  const solvers = new Set(index.solvers);

  const stack: string[] = [];
  let pendingName: string | null = null;

  const flag = (name: string, kind: string, pool: Set<string> | null) => {
    const known = pool ? pool.has(name) : Boolean(index.names[name]);
    if (known) return;
    // Suggestions from the right namespace first, then anything close — and
    // never the name itself, which a wider search can return when the name is
    // real but used in the wrong place.
    const all = suggest(index, name, 6).filter(s => s !== name);
    const preferred = pool ? all.filter(s => pool.has(s)) : all;
    problems.push({
      name,
      where: [label, kind, ...stack.slice(-1)].filter(Boolean).join(' · '),
      suggestions: [...new Set([...preferred, ...all])].slice(0, 3),
    });
  };

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;

    if (line === '{') { if (pendingName) stack.push(pendingName); pendingName = null; continue; }
    if (line === '}') { stack.pop(); continue; }
    if (line.endsWith('{')) { stack.push(line.slice(0, -1).trim()); pendingName = null; continue; }

    const entry = line.match(/^(type|model|solver|RASModel|LESModel)\s+([A-Za-z][A-Za-z0-9_]*)\s*;/);
    if (entry) {
      const [, key, name] = entry;
      const inBoundary = stack.includes('boundaryField');
      const inTurbulence = stack.some(b => b === 'RAS' || b === 'LES');

      if (key === 'type' && inBoundary) flag(name, 'boundary condition', bcNames);
      else if (key === 'type' && !inBoundary) flag(name, 'type', null);
      else if ((key === 'model' || key === 'RASModel' || key === 'LESModel') && (inTurbulence || /momentumTransport|turbulenceProperties/.test(label)))
        flag(name, 'turbulence model', turbulence);
      else if (key === 'solver' && stack.length === 0 && /controlDict/.test(label))
        flag(name, 'solver module', solvers);
      // `solver` inside fvSolution names a LINEAR solver (PCG, GAMG…), which
      // lives in tables this index does not curate — left unchecked rather
      // than wrongly flagged.

      pendingName = null;
      continue;
    }

    if (/^[A-Za-z][A-Za-z0-9_.]*$/.test(line)) { pendingName = line; continue; }
    pendingName = null;
  }
  return problems;
}

/**
 * "Did you mean" for an invalid name.
 *
 * Plain edit distance is the wrong primary signal here. OpenFOAM names are
 * camelCase compounds, and the errors that matter are RENAMES between versions,
 * where the distance is large but the words are the same:
 *
 *   atmBoundaryLayerInletVelocity  →  atmosphericBoundaryLayerVelocity
 *
 * That is 10 edits apart, yet obviously the same thing: three of its four words
 * survive. So candidates are scored mostly on shared words, with edit distance
 * as the tiebreak that catches ordinary typos (noSlipTYPO → noSlip).
 */
export function suggest(index: FoamIndex, name: string, limit = 3): string[] {
  const target = tokenise(name);
  if (!target.size) return [];
  const lower = name.toLowerCase();

  const scored: { name: string; score: number }[] = [];
  for (const candidate of Object.keys(index.names)) {
    const tokens = tokenise(candidate);
    let shared = 0;
    for (const t of tokens) if (target.has(t)) shared++;
    const overlap = shared / Math.max(target.size, tokens.size);

    const c = candidate.toLowerCase();
    const distance = Math.abs(c.length - lower.length) > 12
      ? Infinity                                   // too far to be worth measuring
      : editDistance(lower, c);
    const closeness = distance === Infinity
      ? 0
      : 1 - distance / Math.max(lower.length, c.length);

    // Words carry twice the weight of spelling: a rename keeps the words.
    const score = overlap * 2 + closeness;
    // 0.75 keeps "one word in common out of four" out, while admitting both a
    // three-of-four rename and a single-character typo.
    if (score >= 0.75) scored.push({ name: candidate, score });
  }

  scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  return scored.slice(0, limit).map(s => s.name);
}

/** camelCase → lowercase words. `nutkWallFunction` → nutk, wall, function. */
function tokenise(name: string): Set<string> {
  return new Set(
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .map(w => w.toLowerCase())
      .filter(w => w.length > 1),
  );
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

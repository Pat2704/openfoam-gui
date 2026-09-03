/**
 * The command list the Commands tab shows, read from the installation.
 *
 * WHY THIS EXISTS
 *
 * The sidebar used to render a hand-written table of 103 commands, filtered by
 * a hand-written `minVersion`. Checked against the two installations on this
 * machine, 56 of those 103 were not there at all — `foamCalc`, `yPlusRAS`,
 * `patchAverage` and the rest of the pre-v5 post-processing utilities, cfMesh
 * commands that are a separate product, solver-module names that were simply
 * wrong (`compressibleFluid`, `LagrangianDPM`) — while 108 executables that ARE
 * installed were missing from it. A reference that invents half its entries is
 * worse than no reference: the user pastes a name into the terminal and gets
 * "command not found", and has no way to tell which half they are looking at.
 *
 * So the list is read from the installation, the same way `foam-index.ts` reads
 * the type vocabulary:
 *
 *   $FOAM_APPBIN            the 151 executables (149 on 13)
 *   $WM_PROJECT_DIR/bin     the shell utilities — paraFoam, foamCloneCase, …
 *   foamToC -solvers        the solver modules, which are controlDict entries
 *                           rather than executables
 *
 * Descriptions and categories come from the installation too. Each executable
 * has a source file named after it under `applications/`, whose header carries
 * a Description block, and whose PATH is OpenFOAM's own taxonomy —
 * `utilities/mesh/generation`, `utilities/postProcessing`, and so on. Using it
 * means the categories cannot drift from the version being described.
 *
 * The find worth knowing: on 13 and 14 `$WM_PROJECT_DIR/bin` holds a tombstone
 * script for every superseded solver — `simpleFoam` is a script whose whole job
 * is to tell you it "has been superseded and replaced by the more general
 * incompressibleFluid solver module". Those are kept, flagged, and sorted into
 * their own category: a user who types `simpleFoam` is asking exactly the
 * question that script answers.
 *
 * Cost: one WSL call, ~2 s, cached on disk and invalidated when the selected
 * bashrc changes. The static table in `openfoam-data.ts` survives as the
 * fallback for the seconds before this answers, and for a machine where WSL is
 * unreachable.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { foamSource, findBashrc, runInWslScriptAsync } from './wsl';

const CACHE_PATH = path.join(os.homedir(), '.wslgui-foam-commands.json');

/** Bump when the shape below changes, so old caches are discarded. */
const CATALOG_FORMAT = 1;

export type FoamCommandKind = 'application' | 'script' | 'solverModule';

export interface FoamCommand {
  name: string;
  category: string;
  description: string;
  kind: FoamCommandKind;
  /** What clicking it should put in the terminal. */
  insert: string;
  /** The installation's own description says it was superseded by something. */
  superseded?: boolean;
}

export interface FoamCommandCatalog {
  format: number;
  /** WM_PROJECT_VERSION as the install reports it, e.g. "14". */
  version: string;
  /** Which install this came from — the cache is invalid if the user switches. */
  bashrc: string;
  builtAt: string;
  commands: FoamCommand[];
}

// ── Cache ───────────────────────────────────────────────────────────────────

let memoryCatalog: FoamCommandCatalog | null = null;
let building: Promise<FoamCommandCatalog | null> | null = null;

function loadCache(): FoamCommandCatalog | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) as FoamCommandCatalog;
    if (raw?.format !== CATALOG_FORMAT) return null;
    if (!Array.isArray(raw.commands) || !raw.commands.length) return null;
    return raw;
  } catch {
    return null;
  }
}

/** True when the cached catalogue still describes the install now selected. */
function isFresh(c: FoamCommandCatalog | null): c is FoamCommandCatalog {
  if (!c) return false;
  let bashrc = '';
  try { bashrc = findBashrc(); } catch { /* WSL down: trust the cache */ }
  return !bashrc || c.bashrc === bashrc;
}

/** The catalogue if it is already available, without touching WSL. */
export function getCatalogIfReady(): FoamCommandCatalog | null {
  if (!memoryCatalog) memoryCatalog = loadCache();
  return isFresh(memoryCatalog) ? memoryCatalog : null;
}

export function isCatalogBuilding(): boolean {
  return building !== null;
}

/** Build if needed. Concurrent callers share one build. */
export function ensureCatalog(force = false): Promise<FoamCommandCatalog | null> {
  if (!force) {
    const ready = getCatalogIfReady();
    if (ready) return Promise.resolve(ready);
  }
  if (building) return building;

  building = buildCatalog()
    .then(c => {
      memoryCatalog = c;
      try { fs.writeFileSync(CACHE_PATH, JSON.stringify(c), 'utf-8'); } catch { /* rebuildable */ }
      console.log(`[foam-commands] ${c.commands.length} commands from OpenFOAM ${c.version}`);
      return c;
    })
    .catch(e => {
      console.error('[foam-commands] build failed:', e instanceof Error ? e.message : e);
      return null;
    })
    .finally(() => { building = null; });

  return building;
}

// ── Build ───────────────────────────────────────────────────────────────────

const MARK = '@@FOAMCMD@@';

/**
 * Shell scripts in $WM_PROJECT_DIR/bin that are not user-facing commands.
 *
 * Everything else there is offered. The exclusions are the build system's own
 * helpers and the org-mode exporters, which have nothing to do with running a
 * case; `foamEtcFile`, `foamExec` and `foamCleanPath` are environment plumbing
 * that the app already handles for the user.
 */
const SCRIPT_EXCLUDE = new Set([
  'foamCleanPath', 'foamEtcFile', 'foamExec', 'foamTags',
  'org-html', 'org-latex', 'org-pdflatex',
  'tools', 'rules', 'scripts', 'src', 'makefiles', 'platforms',
]);

/**
 * Collect the whole catalogue in a SINGLE WSL call.
 *
 * One call, for the reason given in foam-index.ts: each `wsl.exe` spawn costs a
 * fixed second or so, and this reads a few hundred files.
 */
async function buildCatalog(): Promise<FoamCommandCatalog> {
  const src = foamSource();

  // The awk that lifts the first paragraph of a Description block. Two shapes:
  // a C++ header (indented plain text) and a shell header (`#     ` prefixed).
  // Both stop at the blank line or at the next section keyword, so what comes
  // back is one sentence rather than a page of usage.
  const awkC =
    `awk '/^Description/{f=1;next} f&&NF&&$0!~/^[[:space:]]/{exit} ` +
    `f&&NF{sub(/^[[:space:]]+/,"");sub(/[[:space:]]+$/,"");d=d (d?" ":"") $0;next} ` +
    `f&&!NF&&d{exit} END{print d}'`;
  const awkSh =
    `awk '/^#[[:space:]]*Description/{f=1;next} f&&/^#[[:space:]]*$/{exit} ` +
    `f&&/^#/{sub(/^#[[:space:]]*/,"");d=d (d?" ":"") $0;next} f{exit} END{print d}'`;

  const script = `#!/bin/bash
${src}
cd /tmp || cd /
echo "${MARK}version"
echo "$WM_PROJECT_VERSION"

echo "${MARK}solvers"
if command -v foamToC > /dev/null 2>&1; then foamToC -solvers 2>/dev/null; fi

# Every application source file, indexed by its file name, so each executable
# can be matched to the header that documents it in one pass.
find "$WM_PROJECT_DIR/applications" -name '*.C' -printf '%f\\t%p\\n' 2>/dev/null | sort -u > /tmp/ofstudio-appsrc.txt

echo "${MARK}apps"
BIN=$(ls -d "$FOAM_APPBIN" 2>/dev/null | head -1)
if [ -d "$BIN" ]; then
  for f in "$BIN"/*; do
    [ -x "$f" ] || continue
    n=$(basename "$f")
    p=$(awk -F'\\t' -v n="$n.C" '$1==n {print $2; exit}' /tmp/ofstudio-appsrc.txt)
    if [ -n "$p" ]; then
      d=$(${awkC} "$p")
      echo "$n|\${p#$WM_PROJECT_DIR/applications/}|$d"
    else
      echo "$n||"
    fi
  done
fi

echo "${MARK}scripts"
for f in "$WM_PROJECT_DIR"/bin/*; do
  [ -f "$f" ] || continue
  [ -x "$f" ] || continue
  n=$(basename "$f")
  d=$(${awkSh} "$f")
  echo "$n||$d"
done

echo "${MARK}end"
`;

  // 90s: the measured build is ~2 s, but a cold WSL adds its own start-up.
  const out = await runInWslScriptAsync(Buffer.from(script).toString('base64'), 90000);
  const sections = splitSections(out);

  const version = (sections.get('version') || '').trim();
  const commands: FoamCommand[] = [];

  for (const line of (sections.get('apps') || '').split('\n')) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const { name, source, description } = parsed;
    commands.push({
      name,
      category: categoryFromSource(source),
      description,
      kind: 'application',
      insert: name,
    });
  }

  const seen = new Set(commands.map(c => c.name));
  for (const line of (sections.get('scripts') || '').split('\n')) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const { name, description } = parsed;
    if (seen.has(name) || SCRIPT_EXCLUDE.has(name)) continue;
    seen.add(name);
    const superseded = /superseded|replaced by/i.test(description);
    commands.push({
      name,
      category: superseded ? 'Superseded' : categoryFromScript(name),
      description,
      kind: 'script',
      insert: name,
      ...(superseded ? { superseded: true } : {}),
    });
  }

  // Solver modules are values for `solver` in system/controlDict, not things
  // you can run — so clicking one offers the command that DOES run it. They
  // are in the list because "which solvers do I have" is asked here, and the
  // hand-written answer to it was wrong on both installed versions.
  for (const name of parseToCTable(sections.get('solvers') || '')) {
    if (seen.has(name)) continue;
    seen.add(name);
    commands.push({
      name,
      category: 'Solver Modules',
      description: 'Solver module — set as `solver ' + name + ';` in system/controlDict, then run foamRun',
      kind: 'solverModule',
      insert: `foamRun -solver ${name}`,
    });
  }

  commands.sort((a, b) => a.name.localeCompare(b.name));

  return {
    format: CATALOG_FORMAT,
    version,
    bashrc: (() => { try { return findBashrc(); } catch { return ''; } })(),
    builtAt: new Date().toISOString(),
    commands,
  };
}

function parseLine(line: string): { name: string; source: string; description: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(MARK)) return null;
  const parts = trimmed.split('|');
  if (parts.length < 3) return null;
  const name = parts[0].trim();
  if (!name || /[^A-Za-z0-9_.+-]/.test(name)) return null;
  return { name, source: parts[1].trim(), description: cleanDescription(parts.slice(2).join('|')) };
}

/**
 * Strip the doxygen markers out of a Description line.
 *
 * The headers are written for doxygen, so they carry \c, \b and \n escapes and
 * \<angle\> quoting. Cleaning them here rather than in the shell keeps the
 * escaping in one language instead of three.
 */
function cleanDescription(raw: string): string {
  return raw
    .replace(/\\[cbfnp]\s/g, '')
    .replace(/\\([<>&])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * OpenFOAM's own directory taxonomy, turned into the category names the
 * sidebar groups by.
 *
 * The paths are relative to `applications/`, e.g.
 * `utilities/mesh/generation/blockMesh/blockMesh.C`.
 */
function categoryFromSource(source: string): string {
  const parts = source.split('/');
  if (parts[0] === 'utilities') {
    const group = parts[1] || '';
    const sub = parts[2] || '';
    if (group === 'mesh') {
      if (sub === 'generation') return 'Mesh Generation';
      if (sub === 'conversion') return 'Mesh Conversion';
      if (sub === 'manipulation') return 'Mesh Manipulation';
      if (sub === 'advanced') return 'Mesh Advanced';
      return 'Mesh Utilities';
    }
    if (group === 'preProcessing') return 'Pre-processing';
    if (group === 'postProcessing') return 'Post-processing';
    if (group === 'parallelProcessing') return 'Parallel Processing';
    if (group === 'surface') return 'Surface Utilities';
    if (group === 'thermophysical') return 'Thermophysical';
    if (group === 'deprecated') return 'Deprecated';
    return 'Miscellaneous';
  }
  if (parts[0] === 'solvers') return 'Execution';
  if (parts[0] === 'legacy') return 'Legacy Solvers';
  return 'Miscellaneous';
}

/** Scripts have no source tree to read a category out of, so they are sorted
 *  by what they do — the only hand-maintained mapping left in this file. */
function categoryFromScript(name: string): string {
  if (/^foam(Clone|Clean|Merge|UnMerge|New|Find|Get|Search|Info|Tags)/.test(name)) return 'Case Management';
  if (/^(paraFoam|postProcess|foamLog|foamMonitor|foamCreateVideo|foamSequenceVTKFiles|foamVTKSeries)/.test(name)) return 'Post-processing';
  if (/^(foamJob|foamRunTutorials|mpirunDebug)/.test(name)) return 'Execution';
  return 'Miscellaneous';
}

/** `foamToC -solvers` prints one indented name per line under a heading. */
function parseToCTable(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s+([A-Za-z][A-Za-z0-9_]*)\s/);
    if (m) names.push(m[1]);
  }
  return [...new Set(names)].sort();
}

function splitSections(out: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith(MARK)) {
      if (current) sections.set(current, buffer.join('\n'));
      current = line.slice(MARK.length).trim().split(' ')[0];
      buffer = [];
      continue;
    }
    if (current) buffer.push(line);
  }
  if (current) sections.set(current, buffer.join('\n'));
  return sections;
}

/**
 * One command's entry, for anything that needs to answer "what is this".
 *
 * Used by the copilots' help chain: it is the installation's own description of
 * a command, and it is free — no WSL call, because the catalogue is already
 * built.
 */
export function findCommand(name: string): FoamCommand | null {
  const catalog = getCatalogIfReady();
  if (!catalog) return null;
  return catalog.commands.find(c => c.name === name) || null;
}

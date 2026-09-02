/**
 * Picking the RIGHT tutorial excerpt for a question.
 *
 * foam-examples.ts already finds a use of a type the question names, by grep.
 * That covers "how do I write nutkWallFunction" and nothing else: a question
 * that describes a situation instead of naming a type — "come impongo una
 * portata all'ingresso" — matches no literal string and gets no example.
 *
 * This module ranks the whole tutorial corpus against the question and returns
 * the best two chunks. It is a SELECTOR, not a collector: it looks at ~7.000
 * chunks and hands back at most 1.500 characters, so the prompt cost stays
 * where it is today (measured: 671 characters for the grep path) while the
 * choice gets much better.
 *
 * WHY LEXICAL AND NOT EMBEDDINGS
 *
 * The plan called for local embeddings. In this app they cost a 130 MB model
 * plus onnxruntime's native binaries inside a Next standalone bundle in an asar
 * — against an 87 MB portable exe the user deliberately kept small, and against
 * an app that works with no network today. BM25 needs none of that, and on THIS
 * corpus it is close: OpenFOAM dictionaries are dense with the exact
 * identifiers a CFD question carries (kEpsilon, boundaryField, inlet), which is
 * the case lexical scoring is strongest in. Embeddings would win on pure
 * paraphrase; if the logs show that happening on real questions, that is the
 * moment to pay the 130 MB, with evidence.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getTutorialDirectory, runInWslScriptAsync } from './wsl';

const CACHE_PATH = path.join(os.homedir(), '.wslgui-foam-corpus.json');
const CACHE_FORMAT = 1;
const MARK = '@@FOAMDOC@@';
const NEWLINE = String.fromCharCode(10);

/** Lines per chunk, with an overlap so an entry split across a boundary still
 *  appears whole in one of them. */
const CHUNK_LINES = 24;
// 12, not 6: a boundary entry is typically 4-8 lines, and with a small overlap
// the winning chunk kept starting one line BELOW its own `type` — the excerpt
// showed `volumetricFlowRate constant 0.1;` without saying which type it
// belongs to. Half a chunk of overlap guarantees any normal entry appears
// whole in at least one chunk.
const CHUNK_OVERLAP = 12;

/** What the selector is allowed to put in the prompt. */
const MAX_EXCERPTS = 2;
const MAX_CHARS = 1500;

export interface Chunk {
  /** Path relative to the tutorials root. */
  path: string;
  /** First line number of this chunk in its file, for the citation. */
  line: number;
  text: string;
}

interface Corpus {
  format: number;
  tutorials: string;
  builtAt: string;
  chunks: Chunk[];
}

let corpus: Corpus | null = null;
let building: Promise<Corpus | null> | null = null;
let buildInFlight = false;

/** term → chunk indices, built in memory the first time it is needed. */
let postings: Map<string, number[]> | null = null;
let lengths: Float64Array | null = null;
let avgLength = 0;

// ── Corpus ──────────────────────────────────────────────────────────────────

function loadCache(): Corpus | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) as Corpus;
    if (raw?.format !== CACHE_FORMAT || !Array.isArray(raw.chunks) || !raw.chunks.length) return null;
    return raw;
  } catch {
    return null;
  }
}

export function getCorpusIfReady(): Corpus | null {
  if (!corpus) corpus = loadCache();
  return corpus;
}

export function isCorpusBuilding(): boolean {
  return buildInFlight;
}

export function ensureCorpus(force = false): Promise<Corpus | null> {
  if (!force) {
    const ready = getCorpusIfReady();
    if (ready) return Promise.resolve(ready);
  }
  if (building) return building;
  buildInFlight = true;
  building = (async () => {
    try {
      const built = await buildCorpus();
      corpus = built;
      postings = null;                       // force a rebuild of the index
      try { fs.writeFileSync(CACHE_PATH, JSON.stringify(built), 'utf-8'); } catch { /* rebuildable */ }
      return built;
    } catch (e) {
      console.error('[foam-retrieval] build failed:', e instanceof Error ? e.message : e);
      return null;
    } finally {
      buildInFlight = false;
      building = null;
    }
  })();
  return building;
}

/**
 * Read the tutorial dictionaries in one WSL call and cut them into chunks.
 *
 * 5.494 files and 6,5 MB, measured on OpenFOAM 14. Meshes, logs and binaries
 * are excluded: a polyMesh points file is 40.000 numbers and would drown every
 * real answer in the ranking.
 */
async function buildCorpus(): Promise<Corpus> {
  const tutorials = getTutorialDirectory();
  if (!tutorials || !tutorials.startsWith('/')) throw new Error('no tutorials directory');

  const script = `#!/bin/bash
cd /tmp || cd /
find ${JSON.stringify(tutorials)} -type f \\
  -not -path '*/polyMesh/*' -not -path '*/postProcessing/*' -not -path '*/Lagrangian/*' \\
  -not -name '*.gz' -not -name '*.stl' -not -name '*.obj' -not -name '*.png' \\
  -not -name 'log.*' -not -name 'All*' -not -name '*.sh' -not -name 'README*' \\
  -size -64k 2>/dev/null | while IFS= read -r f; do
  case "$(file -b "$f" 2>/dev/null | head -c 30)" in
    *ELF*|*executable*|*data*|*compressed*) continue ;;
  esac
  printf '${MARK}%s\\n' "$f"
  cat "$f" 2>/dev/null
done
`;

  const out = await runInWslScriptAsync(Buffer.from(script).toString('base64'), 180000);

  const chunks: Chunk[] = [];
  for (const block of out.split(MARK).slice(1)) {
    const nl = block.indexOf(NEWLINE);
    if (nl < 0) continue;
    const full = block.slice(0, nl).trim();
    const rel = full.startsWith(tutorials) ? full.slice(tutorials.length + 1) : full;
    const lines = block.slice(nl + 1).split(NEWLINE);

    for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
      const slice = lines.slice(start, start + CHUNK_LINES);
      const text = slice.join(NEWLINE).trim();
      // Skip the banner-only chunks every OpenFOAM file starts with.
      if (text.length < 40) continue;
      chunks.push({ path: rel, line: start + 1, text: slice.join(NEWLINE) });
      if (start + CHUNK_LINES >= lines.length) break;
    }
  }

  return { format: CACHE_FORMAT, tutorials, builtAt: new Date().toISOString(), chunks };
}

// ── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Words, with camelCase split apart.
 *
 * `nutkWallFunction` also yields `nutk`, `wall` and `function`, which is what
 * lets a question phrased as "wall function for nut" reach it without naming
 * it exactly — the paraphrase gap that would otherwise need embeddings, closed
 * for the compound-identifier case that dominates here.
 */
function tokenise(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && w.length < 40 && !STOP.has(w));
}

/** Words carried by every dictionary, so they separate nothing. */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'foamfile', 'version',
  'format', 'ascii', 'class', 'object', 'location', 'com', 'www', 'org',
  'openfoam', 'foundation', 'website', 'field', 'operation', 'manipulation',
  'come', 'quale', 'devo', 'usare', 'file', 'caso', 'case', 'una', 'per', 'del',
  'della', 'sul', 'sulla', 'nel', 'nella', 'con', 'che', 'how', 'what', 'which',
]);

/**
 * Italian (and plain-English) wording → the words the tutorials actually use.
 *
 * Measured, not assumed: with the corpus indexed, "come impongo una portata
 * volumetrica all'ingresso" returned files about thermal baffles, and "parete
 * con funzione di parete" returned nothing at all — while the same questions
 * written as `flowRateInletVelocity inlet` and `nutkWallFunction wall` returned
 * the right file at the top. The corpus is English and identifiers; the user
 * writes Italian. Nothing in a lexical scorer can bridge that on its own.
 *
 * This is the cheap half of the bridge: a fixed domain glossary, no model, no
 * megabytes. It cannot cover phrasing nobody anticipated — that is what a
 * multilingual embedding model would buy, and the failures logged here are the
 * evidence for deciding whether it is worth its 130 MB.
 */
const GLOSSARY: Record<string, string[]> = {
  portata: ['flowRate', 'volumetricFlowRate', 'massFlowRate'],
  massica: ['massFlowRate'],
  volumetrica: ['volumetricFlowRate'],
  ingresso: ['inlet'],
  entrata: ['inlet'],
  uscita: ['outlet'],
  parete: ['wall', 'noSlip', 'walls'],
  pareti: ['wall', 'walls'],
  funzione: ['wallFunction'],
  viscosita: ['nut', 'nu', 'viscosity'],
  viscosità: ['nut', 'nu', 'viscosity'],
  turbolenta: ['turbulent', 'nut'],
  turbolenza: ['turbulence', 'RAS', 'momentumTransport'],
  stazionario: ['steadyState', 'SIMPLE'],
  stazionaria: ['steadyState', 'SIMPLE'],
  transitorio: ['transient', 'PIMPLE', 'PISO'],
  incomprimibile: ['incompressible', 'incompressibleFluid'],
  comprimibile: ['compressible'],
  pressione: ['pressure'],
  velocita: ['velocity'],
  velocità: ['velocity'],
  temperatura: ['temperature'],
  densita: ['rho', 'density'],
  densità: ['rho', 'density'],
  gravita: ['gravity'],
  gravità: ['gravity'],
  simmetria: ['symmetry', 'symmetryPlane'],
  periodico: ['cyclic'],
  ciclico: ['cyclic'],
  residui: ['residuals', 'residualControl'],
  griglia: ['mesh', 'blockMesh'],
  mesh: ['blockMeshDict', 'mesh'],
  esaedrico: ['hex'],
  esaedrica: ['hex'],
  graduato: ['simpleGrading', 'grading'],
  infittimento: ['simpleGrading', 'grading'],
  blocco: ['hex', 'blocks'],
  contorno: ['boundaryField', 'patch'],
  iniziale: ['internalField'],
  iniziali: ['internalField'],
  schemi: ['fvSchemes', 'divSchemes'],
  solutore: ['solver', 'fvSolution'],
  scrittura: ['writeControl', 'writeInterval'],
  passo: ['deltaT'],
  temporale: ['deltaT', 'controlDict'],
  superficie: ['alpha', 'interfaceCompression'],
  libera: ['alpha', 'VoF'],
  multifase: ['multiphase', 'VoF', 'alpha'],
  particelle: ['cloud', 'lagrangian'],
  combustione: ['combustion', 'reaction'],
  termico: ['heatTransfer', 'thermophysical'],
  termica: ['heatTransfer', 'thermophysical'],
  scambiatore: ['heatExchanger'],
  poroso: ['porous', 'porosity'],
  porosa: ['porous', 'porosity'],
  rotante: ['MRF', 'rotating'],
  rotazione: ['MRF', 'rotating'],
  ventola: ['fan'],
  ugello: ['nozzle'],
  atmosferico: ['atmospheric', 'atmBoundaryLayer'],
  strato: ['boundaryLayer'],
  limite: ['boundaryLayer'],
};

/** Add the corpus's own words for the concepts a question names in Italian. */
function expand(terms: string[]): string[] {
  const out = new Set(terms);
  for (const t of terms) {
    for (const mapped of GLOSSARY[t] || []) {
      for (const w of tokenise(mapped)) out.add(w);
    }
  }
  return [...out];
}

function buildPostings(c: Corpus): void {
  postings = new Map();
  lengths = new Float64Array(c.chunks.length);
  let total = 0;
  for (let i = 0; i < c.chunks.length; i++) {
    const terms = tokenise(c.chunks[i].text);
    lengths[i] = terms.length;
    total += terms.length;
    const seen = new Set<string>();
    for (const t of terms) {
      if (seen.has(t)) continue;      // presence, not frequency: dictionaries repeat
      seen.add(t);
      const list = postings.get(t);
      if (list) list.push(i);
      else postings.set(t, [i]);
    }
  }
  avgLength = total / Math.max(1, c.chunks.length) || 1;
}

export interface Ranked extends Chunk {
  score: number;
}

/**
 * The best chunks for a question, by BM25 over the tutorial corpus.
 *
 * A chunk containing a query term as a WHOLE identifier is boosted: in this
 * corpus an exact `kEpsilon` is a much stronger signal than the sum of `epsilon`
 * appearing in twenty unrelated files.
 */
export function rank(question: string, limit = 8): Ranked[] {
  const c = getCorpusIfReady();
  if (!c) return [];
  if (!postings) buildPostings(c);
  if (!postings || !lengths) return [];

  const terms = expand([...new Set(tokenise(question))]);
  if (!terms.length) return [];

  const k1 = 1.2, b = 0.75;
  const scores = new Map<number, number>();
  const N = c.chunks.length;

  for (const term of terms) {
    const list = postings.get(term);
    if (!list || !list.length) continue;
    // A term in nearly every chunk carries nothing; the idf handles that.
    const idf = Math.log(1 + (N - list.length + 0.5) / (list.length + 0.5));
    for (const i of list) {
      const len = lengths[i] || 1;
      const tf = 1;                                        // presence-based
      const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * len / avgLength));
      scores.set(i, (scores.get(i) || 0) + idf * norm);
    }
  }

  // Whole-identifier bonus, case-insensitive but word-bounded.
  const identifiers = (question.match(/[A-Za-z][A-Za-z0-9_]{4,}/g) || []).slice(0, 6);
  for (const [i, s] of scores) {
    let bonus = 0;
    for (const id of identifiers) {
      if (new RegExp(`\\b${id}\\b`).test(c.chunks[i].text)) bonus += 2.5;
    }
    if (bonus) scores.set(i, s + bonus);
  }

  return [...scores.entries()]
    .sort((a, b2) => b2[1] - a[1])
    .slice(0, limit)
    .map(([i, score]) => ({ ...c.chunks[i], score }));
}

/**
 * Rank many, keep few — the selector proper.
 *
 * At most two excerpts and 1.500 characters, one per file, so two chunks of the
 * same tutorial cannot fill the whole budget between them.
 */
export function selectExcerpts(question: string): Ranked[] {
  const ranked = rank(question, 12);
  if (!ranked.length) return [];

  const out: Ranked[] = [];
  const seenFiles = new Set<string>();
  let budget = MAX_CHARS;

  const c = getCorpusIfReady();

  for (const r of ranked) {
    if (out.length >= MAX_EXCERPTS) break;
    if (seenFiles.has(r.path)) continue;

    // A chunk can start in the middle of an entry, and then the excerpt shows a
    // value without the `type` line that gives it meaning. Glue on the tail of
    // the preceding chunk of the same file when there is one.
    const previous = c?.chunks.find(
      x => x.path === r.path && x.line === r.line - (CHUNK_LINES - CHUNK_OVERLAP),
    );
    const lead = previous
      ? previous.text.split(NEWLINE).slice(-(CHUNK_LINES - CHUNK_OVERLAP)).join(NEWLINE) + NEWLINE
      : '';
    const joined = lead + r.text;
    const text = joined.length > budget ? joined.slice(0, budget) : joined;
    if (text.trim().length < 40) continue;
    seenFiles.add(r.path);
    out.push({ ...r, text });
    budget -= text.length;
    if (budget < 200) break;
  }
  return out;
}

/** The block that goes into the prompt, or '' when nothing scored. */
export function renderExcerpts(excerpts: Ranked[]): string {
  if (!excerpts.length) return '';
  return (
    '[Closest examples in the tutorials shipped with this installation — copy the shape, not the numbers]' +
    NEWLINE +
    excerpts
      .map(e => `=== ${e.path} (line ${e.line}) ===${NEWLINE}${e.text.trim()}`)
      .join(NEWLINE + NEWLINE)
  );
}

export function corpusStats(): { ready: boolean; chunks: number; builtAt?: string } {
  const c = getCorpusIfReady();
  return c ? { ready: true, chunks: c.chunks.length, builtAt: c.builtAt } : { ready: false, chunks: 0 };
}

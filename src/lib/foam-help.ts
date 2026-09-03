/**
 * "What is this thing, and where did you learn it?"
 *
 * WHY THIS EXISTS
 *
 * Both copilots knew the NAMES the installation offers — foam-index.ts reads
 * every run-time selection table, and generated files are checked against it.
 * What neither had was the DETAIL underneath a name: what `-latestTime` does on
 * this build, which flags snappyHexMesh takes, what a utility is actually for.
 * They filled that in from memory, which for OpenFOAM means from v9/v10 and
 * from the ESI fork, and the user could not tell that they had.
 *
 * So a question about a command is answered in three tiers, in this order, and
 * every finding says which tier it came from:
 *
 *   1  THE INDEX      foamToC's tables and the dictionary keys extracted from
 *                     the sources. Free, already in memory.
 *   2  THE BINARY     the command's own `-help`, run in WSL, plus the
 *                     Description block from its source header. Costs one WSL
 *                     call per command, cached for the life of the process.
 *   3  THE WEB        searched only when the two above found nothing, with the
 *                     URL attached. See web-search.ts for what leaves the
 *                     machine and why ESI's docs are ranked down.
 *
 * The tiers are not interchangeable and the labels are not decoration: tier 1
 * and 2 are this installation, on this disk, and are true here by construction.
 * Tier 3 is the internet, which is mostly about other versions of OpenFOAM.
 * renderFindings() states that distinction to the model in the same block as
 * the findings, and both system prompts require the answer to carry it through
 * to the user.
 */

import { getFoamIndexIfReady, ensureFoamIndex, suggest } from './foam-index';
import { getCatalogIfReady, ensureCatalog, findCommand } from './foam-commands';
import { foamSource, runInWslScriptAsync } from './wsl';
import { searchWeb, fetchReadable } from './web-search';

export type HelpTier = 'index' | 'command-help' | 'web';

export interface HelpFinding {
  tier: HelpTier;
  /** Where exactly, in words the user could check for themselves. */
  label: string;
  text: string;
  /** Tier 3 only. */
  url?: string;
}

// ── Tier 2: the command's own -help ─────────────────────────────────────────

/**
 * `-help` output, per command, for the life of the process.
 *
 * A command's help does not change while the app runs — only switching the
 * selected OpenFOAM version can change it, and that reloads the index and the
 * catalogue anyway. The cache is what makes it reasonable to call this from a
 * chat turn: the first question about snappyHexMesh pays ~1 s, the rest are
 * free.
 */
const helpCache = new Map<string, string | null>();

/** A command name we are willing to hand to a shell. */
function isSafeName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.+-]{0,63}$/.test(name);
}

/**
 * Run `<name> -help` in WSL and return what it printed.
 *
 * The `cd /tmp` is not optional: an OpenFOAM binary aborts with
 * `fileName::stripInvalid` when the working directory is a Windows mount whose
 * path contains a space, which this user's home does. Every WSL script in this
 * project that runs an OpenFOAM binary has to start there.
 */
export async function commandHelp(name: string): Promise<string | null> {
  if (!isSafeName(name)) return null;
  if (helpCache.has(name)) return helpCache.get(name) ?? null;

  const script = `#!/bin/bash
${foamSource()}
cd /tmp || cd /
if ! command -v ${name} > /dev/null 2>&1; then echo "@@ABSENT@@"; exit 0; fi
timeout 10 ${name} -help 2>&1 | head -80
`;

  let text: string | null = null;
  try {
    const out = await runInWslScriptAsync(Buffer.from(script).toString('base64'), 30000);
    const trimmed = out.trim();
    if (trimmed && !trimmed.includes('@@ABSENT@@')) text = trimmed;
  } catch {
    text = null;
  }
  helpCache.set(name, text);
  return text;
}

// ── Candidate names in a question ───────────────────────────────────────────

/**
 * The OpenFOAM identifiers a question is about.
 *
 * Deliberately narrow. Anything that looks like an identifier is a candidate —
 * camelCase, or a known command name — but ordinary words are not: "value",
 * "wall" and "run" are English in a CFD question, and looking each of them up
 * would cost a WSL call to learn nothing. The same reasoning as
 * typesMentioned() in foam-index.ts, applied to commands rather than types.
 */
export function commandsMentioned(text: string, limit = 3): string[] {
  const catalog = getCatalogIfReady();
  const known = new Set(catalog ? catalog.commands.map(c => c.name) : []);
  const found: string[] = [];

  for (const raw of text.match(/[A-Za-z][A-Za-z0-9_]{2,}/g) || []) {
    if (found.includes(raw)) continue;
    // A name the installation actually has, or something clearly written as an
    // OpenFOAM identifier (foamRun, snappyHexMesh, blockMeshDict).
    // Note what is NOT here: names ending in Dict. A blockMeshDict is a file,
    // not a command, so -help can say nothing about it and the web tier would
    // fire on one of the commonest words in an OpenFOAM question. The tutorial
    // corpus already answers those, with a real example.
    const looksLikeOne = /[a-z][A-Z]/.test(raw) && !/Dict$/.test(raw);
    if (!known.has(raw) && !looksLikeOne) continue;
    found.push(raw);
    if (found.length >= limit) break;
  }
  return found;
}

// ── The resolver ────────────────────────────────────────────────────────────

export interface ResolveOptions {
  /** Identifiers to explain. When empty, nothing is looked up. */
  names: string[];
  /**
   * Extra words for a web query, if it comes to that — a topic, not the user's
   * sentence. See the note in web-search.ts.
   */
  context?: string;
  /** Off for callers that must not touch the network. */
  allowWeb?: boolean;
  /** Force the web tier even when the local tiers answered. */
  forceWeb?: boolean;
}

/**
 * Answer for each name, from the cheapest sufficient tier.
 *
 * Tier 3 fires only when 1 and 2 came back empty for EVERY name — that is what
 * "the installation does not know this" looks like, and it is the only case
 * where the internet is better than the disk.
 */
export async function resolveHelp(opts: ResolveOptions): Promise<HelpFinding[]> {
  const names = opts.names.filter(isSafeName).slice(0, 3);
  if (!names.length) return [];

  const index = getFoamIndexIfReady();
  if (!index) void ensureFoamIndex();
  if (!getCatalogIfReady()) void ensureCatalog();

  const version = index?.version || '';
  const findings: HelpFinding[] = [];
  const unresolved: string[] = [];

  for (const name of names) {
    let local = false;

    // ── Tier 1: the index and the catalogue ──
    const entry = findCommand(name);
    const tables = index?.names[name];
    const keys = index?.keysByType[name];
    const options = index?.applications.find(a => a.name === name)?.options;

    if (entry) {
      const lines = [
        `${name} — ${entry.kind === 'solverModule' ? 'a solver module' : entry.kind === 'script' ? 'a shell utility' : 'an executable'} in OpenFOAM ${version}, category "${entry.category}"`,
        entry.description,
      ];
      if (entry.superseded) {
        lines.push('This one is a tombstone: it exists only to tell the user it has been superseded.');
      }
      if (options?.length) lines.push(`options: ${options.join(' ')}`);
      findings.push({
        tier: 'index',
        label: `the installed OpenFOAM ${version} (its own command list and source header)`,
        text: lines.filter(Boolean).join('\n'),
      });
      local = true;
    } else if (tables) {
      findings.push({
        tier: 'index',
        label: `foamToC on the installed OpenFOAM ${version}`,
        text: [
          `${name} — a valid type here`,
          `tables: ${tables.join(', ')}`,
          keys?.length ? `accepted keys: ${keys.join(' ')}` : '',
        ].filter(Boolean).join('\n'),
      });
      local = true;
    }

    // ── Tier 2: ask the binary itself ──
    //
    // Runs whenever the name could be a command, INCLUDING when tier 1 already
    // matched: tier 1 knows the flag names, `-help` knows what each one does,
    // and "what does -latestTime do" is exactly the kind of question that was
    // being answered from memory before this existed.
    if (!entry || entry.kind !== 'solverModule') {
      const help = await commandHelp(name);
      if (help) {
        findings.push({
          tier: 'command-help',
          label: `\`${name} -help\`, run just now on the installed OpenFOAM ${version}`,
          text: help,
        });
        local = true;
      }
    }

    if (!local) unresolved.push(name);
  }

  // ── Tier 3: the web, only if the disk had nothing at all ──
  const wantWeb = opts.allowWeb !== false && (opts.forceWeb || (unresolved.length > 0 && unresolved.length === names.length));
  if (wantWeb) {
    const terms = (opts.forceWeb ? names : unresolved).join(' ');
    const query = `OpenFOAM ${version || ''} ${terms} ${opts.context || ''}`.replace(/\s+/g, ' ').trim();
    const results = await searchWeb(query, 3);

    if (!results.length) {
      findings.push({
        tier: 'web',
        label: 'a web search',
        text: `Searched the web for "${query}" and got nothing back (no connection, or no results). Nothing here is from the internet.`,
      });
    } else {
      // One page is read in full; the rest contribute their snippet. Reading
      // three pages would triple the wait for a marginal gain.
      const first = results[0];
      const page = await fetchReadable(first.url, 2000);
      findings.push({
        tier: 'web',
        label: `${first.domain}${first.esi ? ' — ESI/openfoam.com, which documents a DIFFERENT fork from this installation' : ''}`,
        url: first.url,
        text: [
          first.title,
          page || first.snippet,
        ].filter(Boolean).join('\n'),
      });
      for (const r of results.slice(1)) {
        findings.push({
          tier: 'web',
          label: `${r.domain}${r.esi ? ' — ESI/openfoam.com, a DIFFERENT fork from this installation' : ''}`,
          url: r.url,
          text: [r.title, r.snippet].filter(Boolean).join('\n'),
        });
      }
    }

    // Say what the search was for. A name that is nowhere in the installation
    // is usually a name from another version, and the closest local match is
    // more useful than anything a search returns.
    if (index) {
      for (const name of unresolved) {
        const close = suggest(index, name, 3);
        if (close.length) {
          findings.push({
            tier: 'index',
            label: `the installed OpenFOAM ${version}`,
            text: `"${name}" does not exist in this installation. The closest names it does have: ${close.join(', ')}.`,
          });
        }
      }
    }
  }

  return findings;
}

/**
 * The findings as a prompt block, with the rule that makes them worth having.
 *
 * The rule is stated next to the evidence rather than only in the system
 * prompt: a model reading this block should not have to remember an
 * instruction from ten thousand tokens earlier to know it must attribute.
 */
export function renderFindings(findings: HelpFinding[]): string {
  if (!findings.length) return '';

  const lines: string[] = [
    '[Looked up for this question — SAY WHERE EACH ANSWER CAME FROM]',
    'These were gathered in order: the installation first, the command\'s own -help second, the web only if',
    'the first two had nothing. When you use any of it, name the source in your reply — "according to',
    '`snappyHexMesh -help` on your OpenFOAM 14", "from openfoam.org (link)". If you answer from your own',
    'memory instead, say that too, because your recollection of OpenFOAM is dominated by older versions and',
    'by the ESI fork. Anything marked WEB is NOT ground truth for this installation.',
    '',
  ];

  for (const f of findings) {
    const tier = f.tier === 'index' ? 'INSTALLATION' : f.tier === 'command-help' ? 'COMMAND -help' : 'WEB';
    lines.push(`--- ${tier} · ${f.label}${f.url ? ` · ${f.url}` : ''} ---`);
    lines.push(f.text.trim());
    lines.push('');
  }

  return lines.join('\n');
}

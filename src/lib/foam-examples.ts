/**
 * Real uses of a type, taken from the tutorials of the installed version.
 *
 * The index in foam-index.ts answers "does this name exist" and "what keys does
 * it take". It cannot answer "and how is it actually written" — the shape of a
 * real entry, which values are plausible, what usually sits next to it. The
 * 5.505 dictionary files under the installation's tutorials answer exactly
 * that, and they are the right source for it: they ship with this version, so
 * they cannot be out of date the way a remembered example can.
 *
 * This is deliberately grep, not embeddings. A type name is a literal string,
 * so exact matching is not a weaker form of semantic search here — it is the
 * correct tool. Semantic search earns its place for "how do I model a rotating
 * fan", which is a different question and a later phase.
 */

import { getTutorialDirectory, runInWslScriptAsync } from './wsl';

const MARK = '@@FOAMEX@@';
const NEWLINE = String.fromCharCode(10);

export interface FoamExample {
  /** Path relative to the tutorials root, e.g. `incompressibleFluid/cavity/0/U`. */
  path: string;
  /** The lines around the match, trimmed to a readable block. */
  excerpt: string;
}

/**
 * One example per name, at most `limit` names.
 *
 * Picks the SMALLEST file that mentions the name: small dictionaries are the
 * plain ones. The biggest match is usually a 40-patch industrial case whose
 * excerpt teaches nothing.
 */
export async function findExamples(names: string[], limit = 2): Promise<FoamExample[]> {
  const wanted = names.filter(n => /^[A-Za-z][A-Za-z0-9_]{3,}$/.test(n)).slice(0, limit);
  if (!wanted.length) return [];

  let tutorials = '';
  try { tutorials = getTutorialDirectory(); } catch { return []; }
  if (!tutorials || !tutorials.startsWith('/')) return [];

  const blocks = wanted.map(name => [
    `echo "${MARK}name ${name}"`,
    // Smallest file first, and only the dictionary directories: a match inside
    // constant/polyMesh or a log is never a useful example.
    `f=$(grep -rIl --include='*' -e "${name}" "${tutorials}" 2>/dev/null \\`,
    `  | grep -vE '/(polyMesh|postProcessing|processor[0-9]+)/' \\`,
    `  | head -40 | xargs -r ls -S 2>/dev/null | tail -1)`,
    `if [ -n "$f" ]; then`,
    `  echo "${MARK}file $f"`,
    // 6 lines of lead-in and 12 after: enough to show the entry and its block.
    `  grep -n -m1 -e "${name}" "$f" | cut -d: -f1 | while read -r ln; do`,
    `    start=$(( ln > 6 ? ln - 6 : 1 ))`,
    `    sed -n "\${start},$(( ln + 12 ))p" "$f"`,
    `  done`,
    `fi`,
  ].join(NEWLINE));

  const script = `#!/bin/bash
cd /tmp || cd /
${blocks.join(NEWLINE)}
echo "${MARK}end"
`;

  let out = '';
  try {
    // 8 s: a grep over 105 MB of tutorials is about a second warm. If WSL is
    // cold and it takes longer, the answer goes out without examples rather
    // than making the user wait.
    out = await runInWslScriptAsync(Buffer.from(script).toString('base64'), 8000);
  } catch {
    return [];
  }

  const examples: FoamExample[] = [];
  for (const chunk of out.split(MARK + 'name ').slice(1)) {
    const fileMark = chunk.indexOf(MARK + 'file ');
    if (fileMark < 0) continue;
    const afterMark = chunk.slice(fileMark + (MARK + 'file ').length);
    const nl = afterMark.indexOf(NEWLINE);
    if (nl < 0) continue;

    const full = afterMark.slice(0, nl).trim();
    const body = afterMark.slice(nl + 1).split(MARK)[0].replace(/\s+$/, '');
    if (!body.trim()) continue;

    examples.push({
      path: full.startsWith(tutorials) ? full.slice(tutorials.length + 1) : full,
      excerpt: body,
    });
  }
  return examples;
}

/** The block that goes into the prompt, or '' when there is nothing to show. */
export function renderExamples(examples: FoamExample[]): string {
  if (!examples.length) return '';
  return (
    `[Real uses, from the tutorials shipped with this installation — copy the shape, not the numbers]` +
    NEWLINE +
    examples.map(e => `=== ${e.path} ===${NEWLINE}${e.excerpt}`).join(NEWLINE + NEWLINE)
  );
}

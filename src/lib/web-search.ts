/**
 * The last resort: look something up on the web.
 *
 * WHY THIS EXISTS
 *
 * Everything else in this app answers from the installation on disk — foamToC's
 * tables, each binary's own -help, the tutorials that ship with it. That is the
 * right order, and it is where an answer should come from whenever it can. But
 * there is a real gap underneath it: an option that no table registers, a
 * message a solver prints that appears nowhere in the sources, a keyword the
 * user read in a paper. Before this, the copilots filled that gap from memory
 * and the user could not tell that they had.
 *
 * So this is tier three, and it exists on the condition that its answers are
 * always LABELLED. Every finding carries the URL it came from, the callers
 * attach that to the prompt, and both copilots are told to say which tier each
 * statement rests on. An unattributed web answer would be worse than no web
 * answer at all — it would look exactly like ground truth from the install.
 *
 * TWO THINGS THAT ARE DELIBERATE
 *
 * The query is built from OpenFOAM identifiers, never from the user's own
 * sentence. That is partly search quality — `atmosphericBoundaryLayerVelocity`
 * finds more than a paragraph of Italian does — and partly that the user's
 * question is theirs: what leaves this machine is a handful of technical terms.
 *
 * Results from ESI's doc.openfoam.com are RANKED DOWN and flagged. They
 * dominate the search results for almost every OpenFOAM term, and they document
 * a different fork: this app targets the Foundation line (openfoam.org), where
 * v2306's syntax is frequently not valid. Ranking them below openfoam.org,
 * cfd.direct and CFD Online is the difference between a useful answer and a
 * confidently wrong one.
 *
 * No API key, and no dependency: DuckDuckGo's HTML endpoint is a plain GET that
 * returns plain HTML. If it ever stops answering, every caller degrades to
 * "nothing found on the web" and the two local tiers are unaffected.
 */

/** How long any single network call may take. */
const TIMEOUT_MS = 12000;

/** Chrome's UA. The HTML endpoint answers a bare fetch with a challenge page. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  /** The host, for display — the user should see where an answer came from. */
  domain: string;
  /** doc.openfoam.com and openfoam.com: the ESI fork, not this installation. */
  esi: boolean;
}

/**
 * Domains that document the Foundation line this app targets, best first.
 *
 * Anything not listed keeps its search-engine order, after these.
 */
const PREFERRED = [
  'openfoam.org',
  'doc.cfd.direct',
  'cfd.direct',
  'cfd-online.com',
  'github.com',
];

const ESI_DOMAINS = ['openfoam.com', 'doc.openfoam.com'];

function rank(domain: string): number {
  const i = PREFERRED.findIndex(d => domain === d || domain.endsWith('.' + d));
  if (i >= 0) return i;
  if (ESI_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) return 100;
  return 50;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

async function get(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    // Offline, blocked, timed out, DNS — all the same to the caller, which
    // simply reports that the web had nothing.
    return null;
  }
}

/**
 * Search, and return the results in the order this app should trust them.
 *
 * The query should be OpenFOAM identifiers plus a word or two of context —
 * see the note at the top about not sending the user's own sentence.
 */
export async function searchWeb(query: string, limit = 4): Promise<WebResult[]> {
  const q = query.trim().slice(0, 200);
  if (!q) return [];

  const html = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
  if (!html) return [];

  const results: WebResult[] = [];
  const seen = new Set<string>();

  // One result is an anchor with class result__a whose href is a redirect
  // carrying the real URL in uddg=, followed by a result__snippet anchor.
  const blocks = html.split('result__a');
  for (const block of blocks.slice(1)) {
    const hrefMatch = block.match(/href="([^"]+)"/);
    const titleMatch = block.match(/>([\s\S]*?)<\/a>/);
    if (!hrefMatch || !titleMatch) continue;

    let url = decodeEntities(hrefMatch[1]);
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (!/^https?:\/\//i.test(url)) continue;

    let domain: string;
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);

    const snippetMatch = block.match(/result__snippet[^>]*>([\s\S]*?)<\/a>/);
    results.push({
      title: stripTags(titleMatch[1]).slice(0, 200),
      url,
      snippet: snippetMatch ? stripTags(snippetMatch[1]).slice(0, 400) : '',
      domain,
      esi: ESI_DOMAINS.some(d => domain === d || domain.endsWith('.' + d)),
    });
  }

  results.sort((a, b) => rank(a.domain) - rank(b.domain));
  return results.slice(0, limit);
}

/**
 * Fetch one page and reduce it to readable text.
 *
 * Deliberately crude — script and style out, tags out, whitespace collapsed.
 * The point is to give a model a few paragraphs it can quote and attribute, not
 * to reconstruct the page.
 */
export async function fetchReadable(url: string, maxChars = 2500): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const html = await get(url);
  if (!html) return null;

  const text = stripTags(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
  );
  return text ? text.slice(0, maxChars) : null;
}

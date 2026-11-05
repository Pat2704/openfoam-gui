/**
 * Find and replace for the File Editor. Pure, so the matching rules are tested.
 *
 * Three options, as in VS Code: match case, whole word and regular
 * expression. In plain mode the replacement is LITERAL — a `$&` or `$1` typed
 * into it is inserted as typed, never read as String.replace syntax. In regex
 * mode `$1`, `$&` and friends do refer to the match, which is what someone
 * writing a regex expects.
 */

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface SearchMatch {
  start: number;
  end: number;
}

/** Enough for any dictionary; a search past it says so rather than freezing. */
export const MAX_MATCHES = 5000;

const WORD = /[A-Za-z0-9_]/;

function isWordBoundary(text: string, start: number, end: number): boolean {
  return !(start > 0 && WORD.test(text[start - 1])) && !(end < text.length && WORD.test(text[end]));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(query: string, options: SearchOptions): RegExp {
  const source = options.regex ? query : escapeRegExp(query);
  return new RegExp(source, `g${options.caseSensitive ? '' : 'i'}m`);
}

export function findMatches(text: string, query: string, options: SearchOptions): {
  matches: SearchMatch[];
  error?: string;
  truncated: boolean;
} {
  if (!query) return { matches: [], truncated: false };
  let pattern: RegExp;
  try {
    pattern = compile(query, options);
  } catch (error) {
    return { matches: [], truncated: false, error: error instanceof Error ? error.message : 'Invalid regular expression' };
  }
  const matches: SearchMatch[] = [];
  for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
    // A pattern that can match nothing (`^`, `a*`) would never advance.
    if (found[0].length === 0) { pattern.lastIndex++; continue; }
    const start = found.index;
    const end = start + found[0].length;
    if (options.wholeWord && !isWordBoundary(text, start, end)) continue;
    matches.push({ start, end });
    if (matches.length >= MAX_MATCHES) return { matches, truncated: true };
  }
  return { matches, truncated: false };
}

/** The text that replaces one match. */
function replacementFor(text: string, match: SearchMatch, query: string, replacement: string, options: SearchOptions): string {
  if (!options.regex) return replacement;
  // Replaced in place in the WHOLE text, with a sticky expression set at the
  // match, so `^`, `$` and lookbehinds see the same context the search did.
  const sticky = new RegExp(compile(query, options).source, `y${options.caseSensitive ? '' : 'i'}m`);
  sticky.lastIndex = match.start;
  const replaced = text.replace(sticky, replacement);
  return replaced.slice(match.start, replaced.length - (text.length - match.end));
}

export function replaceMatch(text: string, match: SearchMatch, query: string, replacement: string, options: SearchOptions): string {
  return text.slice(0, match.start) + replacementFor(text, match, query, replacement, options) + text.slice(match.end);
}

export function replaceAll(text: string, query: string, replacement: string, options: SearchOptions): { text: string; count: number } {
  const { matches } = findMatches(text, query, options);
  if (!matches.length) return { text, count: 0 };
  let out = '';
  let last = 0;
  for (const match of matches) {
    out += text.slice(last, match.start) + replacementFor(text, match, query, replacement, options);
    last = match.end;
  }
  return { text: out + text.slice(last), count: matches.length };
}

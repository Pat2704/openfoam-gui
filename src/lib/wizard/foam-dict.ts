/**
 * Just enough of OpenFOAM's dictionary syntax to take a tutorial's field file
 * apart and put it back together around a different set of patches.
 *
 * The wizard's tutorial-seeded modules (multiphaseEuler, XiFluid, …) keep the
 * tutorial's physics but mesh their own domain, so every 0/ file needs its
 * boundaryField rewritten for the wizard's patches while everything else —
 * dimensions, internalField, `#include`s, the variables at the top — stays as
 * the tutorial wrote it. This is a tokenizer over braces, strings and comments,
 * not a full parser: entry bodies are kept as text.
 */

export interface DictEntry {
  /** The keyword, a quoted pattern like `"(front|back)"`, or a `#directive`. */
  key: string;
  /** Inside the braces for a dictionary; the value before `;` otherwise; the rest of the line for a directive. */
  body: string;
  kind: 'dict' | 'value' | 'directive';
}

/** Remove line and block comments, leaving strings alone. */
export function stripComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      const stop = end < 0 ? text.length : end + 1;
      out += text.slice(i, stop);
      i = stop - 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return out;
}

/** The entries at the top level of `text` (already comment-free). */
export function entries(text: string): DictEntry[] {
  const out: DictEntry[] = [];
  let i = 0;
  const n = text.length;
  const skipSpace = () => { while (i < n && /\s/.test(text[i])) i++; };

  while (i < n) {
    skipSpace();
    if (i >= n) break;
    if (text[i] === ';') { i++; continue; }

    if (text[i] === '#') {
      const end = text.indexOf('\n', i);
      const line = text.slice(i, end < 0 ? n : end).trim();
      const sp = line.search(/\s/);
      out.push({ key: sp < 0 ? line : line.slice(0, sp), body: sp < 0 ? '' : line.slice(sp + 1).trim(), kind: 'directive' });
      i = end < 0 ? n : end + 1;
      continue;
    }

    // Keyword: a quoted pattern, or a run of non-space, non-brace characters.
    let key = '';
    if (text[i] === '"') {
      const end = text.indexOf('"', i + 1);
      key = text.slice(i, end < 0 ? n : end + 1);
      i = end < 0 ? n : end + 1;
    } else {
      while (i < n && !/[\s{};]/.test(text[i])) key += text[i++];
    }
    skipSpace();
    if (!key) { i++; continue; }

    if (text[i] === '{') {
      const start = i + 1;
      let depth = 0;
      for (; i < n; i++) {
        if (text[i] === '"') { const e = text.indexOf('"', i + 1); i = e < 0 ? n : e; continue; }
        if (text[i] === '{') depth++;
        else if (text[i] === '}') { depth--; if (depth === 0) break; }
      }
      out.push({ key, body: text.slice(start, i).trim(), kind: 'dict' });
      i++;
      continue;
    }

    // A value: up to the `;` that is not inside parentheses, brackets or a string.
    const start = i;
    let depth = 0;
    for (; i < n; i++) {
      const c = text[i];
      if (c === '"') { const e = text.indexOf('"', i + 1); i = e < 0 ? n : e; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ';' && depth <= 0) break;
    }
    out.push({ key, body: text.slice(start, i).trim(), kind: 'value' });
    i++;
  }
  return out;
}

export interface ParsedField {
  cls: string;
  object: string;
  /** Top-level entries other than FoamFile, dimensions, internalField and boundaryField, in order. */
  preamble: DictEntry[];
  dimensions: string;
  internalField: string;
  boundary: DictEntry[];
}

/** A 0/ field file, or null if it has no boundaryField (not a field). */
export function parseFieldFile(text: string): ParsedField | null {
  const top = entries(stripComments(text));
  const foamFile = top.find(e => e.key === 'FoamFile' && e.kind === 'dict');
  const header = foamFile ? Object.fromEntries(entries(foamFile.body).map(e => [e.key, e.body.replace(/^"|"$/g, '')])) : {};
  const boundary = top.find(e => e.key === 'boundaryField' && e.kind === 'dict');
  if (!boundary) return null;
  const internal = top.find(e => e.key === 'internalField');
  return {
    cls: header.class ?? 'volScalarField',
    object: header.object ?? '',
    preamble: top.filter(e => !['FoamFile', 'dimensions', 'internalField', 'boundaryField'].includes(e.key)),
    dimensions: top.find(e => e.key === 'dimensions')?.body ?? '[0 0 0 0 0 0 0]',
    // A zonal (v14) internalField is a dictionary; kept whole.
    internalField: internal ? (internal.kind === 'dict' ? `{\n${internal.body}\n}` : internal.body) : 'uniform 0',
    boundary: entries(boundary.body),
  };
}

/** Render entries back as dictionary text, indented. */
export function renderEntries(list: DictEntry[], indent = ''): string {
  return list.map(e => {
    if (e.kind === 'directive') return `${indent}${e.key}${e.body ? ` ${e.body}` : ''}`;
    if (e.kind === 'value') return `${indent}${e.key.padEnd(16)}${e.body};`;
    const inner = e.body.split('\n').map(l => l.trim()).filter(Boolean).map(l => `${indent}    ${l}`).join('\n');
    return `${indent}${e.key}\n${indent}{\n${inner}\n${indent}}`;
  }).join('\n');
}

/** `type` and `value` of a boundary entry body, and everything else as lines. */
export function splitBoundaryBody(body: string): { type: string; value: string; extra: string } {
  const list = entries(body);
  const type = list.find(e => e.key === 'type')?.body ?? '';
  const value = list.find(e => e.key === 'value')?.body ?? '';
  const extra = renderEntries(list.filter(e => e.key !== 'type' && e.key !== 'value'));
  return { type, value, extra };
}

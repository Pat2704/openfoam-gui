/**
 * What the File Editor draws behind its text: comments, and the indent guides
 * of `{ … }` blocks.
 *
 * The editor stays a plain <textarea> — typing, selection, undo and the
 * dirty-buffer handling are the browser's own — and a layer behind it repeats
 * the text with these marks. This module computes them, line by line, and is
 * pure so the tokenizing rules are tested.
 *
 * The rules are OpenFOAM's: `//` to the end of the line and `/* … *\/` across
 * lines are comments, but not inside a "string" (an `#include "…"` path or a
 * patch regex like "(inlet|outlet)"). A guide belongs to a brace pair and is
 * drawn on the lines strictly between `{` and its `}`, at the indentation of
 * the line that holds the `{` — the column the block's name starts in, so it
 * lines up whatever indent width the file uses.
 */

export interface HighlightSegment {
  text: string;
  comment: boolean;
}

export interface HighlightLine {
  segments: HighlightSegment[];
  /** Columns (in characters, tabs expanded) where a guide passes this line. */
  guides: number[];
}

/** Above this many lines or characters the layer is not drawn at all. */
export const HIGHLIGHT_MAX_LINES = 20000;
export const HIGHLIGHT_MAX_CHARS = 2_000_000;

export function canHighlight(text: string): boolean {
  if (text.length > HIGHLIGHT_MAX_CHARS) return false;
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (++lines > HIGHLIGHT_MAX_LINES) return false;
  }
  return true;
}

/** The column the first non-blank character of a line sits in. */
function indentColumn(line: string, tabSize: number): number {
  let column = 0;
  for (const char of line) {
    if (char === ' ') column++;
    else if (char === '\t') column += tabSize - (column % tabSize);
    else break;
  }
  return column;
}

export function highlightFoam(text: string, tabSize = 4): HighlightLine[] {
  const lines = text.split('\n');
  const out: HighlightLine[] = [];
  let inBlockComment = false;
  // Open braces, innermost last: the column their guide is drawn at.
  const open: { id: number; column: number }[] = [];
  let nextId = 0;

  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const atStart = [...open];
    const closedHere = new Set<number>();
    const segments: HighlightSegment[] = [];
    let current = '';
    let currentIsComment = inBlockComment;
    const flush = (comment: boolean) => {
      if (current && currentIsComment !== comment) {
        segments.push({ text: current, comment: currentIsComment });
        current = '';
      }
      currentIsComment = comment;
    };

    let inString = false;
    const indent = indentColumn(line, tabSize);
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const next = line[i + 1];
      if (inBlockComment) {
        flush(true);
        if (char === '*' && next === '/') { current += '*/'; i++; inBlockComment = false; continue; }
        current += char;
        continue;
      }
      if (inString) {
        flush(false);
        current += char;
        if (char === '\\' && next !== undefined) { current += next; i++; continue; }
        if (char === '"') inString = false;
        continue;
      }
      if (char === '/' && next === '/') {
        flush(true);
        current += line.slice(i);
        break;
      }
      if (char === '/' && next === '*') {
        flush(true);
        current += '/*';
        i++;
        inBlockComment = true;
        continue;
      }
      flush(false);
      current += char;
      if (char === '"') inString = true;
      else if (char === '{') open.push({ id: nextId++, column: indent });
      else if (char === '}') {
        const closed = open.pop();
        if (closed) closedHere.add(closed.id);
      }
    }
    if (current) segments.push({ text: current, comment: currentIsComment });
    out.push({
      segments,
      guides: atStart.filter(brace => !closedHere.has(brace.id)).map(brace => brace.column),
    });
  }
  return out;
}

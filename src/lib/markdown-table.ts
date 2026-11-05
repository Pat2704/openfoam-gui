/**
 * GitHub-style tables in agent answers.
 *
 * The agent panels render a small subset of Markdown by hand (headings, lists,
 * code, bold), and a table came out as raw pipes — which the result and mesh
 * analyses produce all the time. This reads one table block; the panels turn
 * it into a <table>. Pure, so the edge cases are tested.
 */

export type TableAlign = 'left' | 'center' | 'right' | null;

export interface MarkdownTable {
  header: string[];
  align: TableAlign[];
  rows: string[][];
  /** Index of the first line after the table. */
  end: number;
}

/** Split a table row on unescaped pipes; `\|` stays a literal pipe in the cell. */
export function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && text[i + 1] === '|') { current += '|'; i++; continue; }
    if (char === '|') { cells.push(current.trim()); current = ''; continue; }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

const SEPARATOR_CELL = /^:?-+:?$/;

function alignmentOf(cell: string): TableAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/**
 * The table that starts at `lines[start]`, or null. A table is a row with a
 * pipe, then a separator row (`|---|:--:|`) with the same number of cells,
 * then every following non-blank line that has a pipe.
 */
export function readMarkdownTable(lines: readonly string[], start: number): MarkdownTable | null {
  const first = lines[start];
  const second = lines[start + 1];
  if (first === undefined || second === undefined || !first.includes('|') || !second.includes('|')) return null;
  const header = splitTableRow(first);
  const separator = splitTableRow(second);
  if (separator.length !== header.length || !separator.every(cell => SEPARATOR_CELL.test(cell))) return null;
  const rows: string[][] = [];
  let end = start + 2;
  while (end < lines.length && lines[end].trim() !== '' && lines[end].includes('|')) {
    const cells = splitTableRow(lines[end]);
    // Every row as wide as the header: missing cells are empty, extra ones dropped.
    rows.push(header.map((_, k) => cells[k] ?? ''));
    end++;
  }
  return { header, align: separator.map(alignmentOf), rows, end };
}

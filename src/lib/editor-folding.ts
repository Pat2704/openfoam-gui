/**
 * Folding `{ … }` blocks in the File Editor.
 *
 * The editor is a textarea, which cannot hide lines. So when blocks are folded
 * the textarea shows a PROJECTION of the file — the file without the inner
 * lines of every folded block — while the file itself stays whole. An edit
 * made in the projection is mapped back onto the file (`applyVisibleEdit`),
 * and offsets are converted both ways so the caret and the selection survive
 * folding and unfolding. Pure, so all of that is tested.
 *
 * A fold hides the lines strictly between `{` and its `}`, as VS Code does:
 * the brace lines stay visible. Its toggle sits on the line that names the
 * block — the line above a `{` that stands alone, the OpenFOAM layout — or on
 * the `{` line itself.
 */

import type { BraceBlock } from './editor-highlight';

export interface FoldRegion extends BraceBlock {
  /** The line that shows the fold toggle. */
  toggle: number;
}

/** Brace pairs with at least one line between them, and where their toggle goes. */
export function foldRegions(text: string, blocks: readonly BraceBlock[]): FoldRegion[] {
  const lines = text.split('\n');
  const regions: FoldRegion[] = [];
  const toggles = new Set<number>();
  for (const block of blocks) {
    if (block.close <= block.open + 1) continue;
    let toggle = block.open;
    const braceLine = lines[block.open]?.trim() ?? '';
    const previous = lines[block.open - 1]?.trim() ?? '';
    if (braceLine === '{' && previous && !/[;{}]$/.test(previous) && !previous.startsWith('//') && !previous.endsWith('*/')) {
      toggle = block.open - 1;
    }
    // Two blocks cannot share one toggle; the outer one (sorted first) keeps it.
    if (toggles.has(toggle)) toggle = block.open;
    if (toggles.has(toggle)) continue;
    toggles.add(toggle);
    regions.push({ ...block, toggle });
  }
  return regions;
}

export interface Projection {
  /** What the textarea shows. The same string as the file when nothing is folded. */
  visible: string;
  /** For each visible line, the file line it is. */
  lineMap: number[];
  /** Visible line → number of file lines hidden right after it. */
  hiddenAfter: Map<number, number>;
  fullLineStarts: number[];
  visibleLineStarts: number[];
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** The file with the inner lines of the folded regions (by their `open` line) left out. */
export function project(full: string, regions: readonly FoldRegion[], folded: ReadonlySet<number>): Projection {
  const fullLineStarts = lineStarts(full);
  const hidden = new Array<boolean>(fullLineStarts.length).fill(false);
  let any = false;
  for (const region of regions) {
    if (!folded.has(region.open)) continue;
    for (let line = region.open + 1; line < region.close; line++) hidden[line] = true;
    any = true;
  }
  if (!any) {
    return {
      visible: full, lineMap: fullLineStarts.map((_, i) => i), hiddenAfter: new Map(),
      fullLineStarts, visibleLineStarts: fullLineStarts,
    };
  }
  const lines = full.split('\n');
  const kept: string[] = [];
  const lineMap: number[] = [];
  const hiddenAfter = new Map<number, number>();
  for (let line = 0; line < lines.length; line++) {
    if (hidden[line]) {
      const last = lineMap.length - 1;
      hiddenAfter.set(last, (hiddenAfter.get(last) ?? 0) + 1);
      continue;
    }
    kept.push(lines[line]);
    lineMap.push(line);
  }
  const visible = kept.join('\n');
  return { visible, lineMap, hiddenAfter, fullLineStarts, visibleLineStarts: lineStarts(visible) };
}

/** The last index whose value is <= target, in an ascending array. */
function floorIndex(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (values[mid] <= target) low = mid; else high = mid - 1;
  }
  return low;
}

/** The line (0-based) an offset falls on, from a text's line starts. */
export function lineOfOffset(lineStartOffsets: readonly number[], offset: number): number {
  return floorIndex(lineStartOffsets, offset);
}

export function visibleToFull(projection: Projection, offset: number): number {
  const line = floorIndex(projection.visibleLineStarts, offset);
  return projection.fullLineStarts[projection.lineMap[line]] + (offset - projection.visibleLineStarts[line]);
}

/** A position inside a folded region goes to the end of the line before it. */
export function fullToVisible(projection: Projection, offset: number): number {
  const fullLine = floorIndex(projection.fullLineStarts, offset);
  const visibleLine = floorIndex(projection.lineMap, fullLine);
  if (projection.lineMap[visibleLine] === fullLine) {
    return projection.visibleLineStarts[visibleLine] + (offset - projection.fullLineStarts[fullLine]);
  }
  const next = projection.visibleLineStarts[visibleLine + 1];
  return next === undefined ? projection.visible.length : next - 1;
}

/**
 * Carry an edit of the projection over to the file. The edit is the span
 * between the common start and the common end of the old and new visible
 * text; it replaces the matching span of the file — so deleting a selection
 * that holds a folded block deletes the block, as in VS Code.
 *
 * Returns the new file text, where the caret goes in it (after the inserted
 * text), and how many lines the edit added from which file line on, for
 * moving the folds below it.
 */
export function applyVisibleEdit(full: string, projection: Projection, nextVisible: string, caret?: number): {
  text: string;
  caret: number;
  fromLine: number;
  lineDelta: number;
  /** The `{` line of a fold the edit opened a line inside, which must unfold. */
  reveal?: number;
} {
  const before = projection.visible;
  let start = 0;
  const shortest = Math.min(before.length, nextVisible.length);
  while (start < shortest && before[start] === nextVisible[start]) start++;
  let tail = 0;
  while (tail < shortest - start && before[before.length - 1 - tail] === nextVisible[nextVisible.length - 1 - tail]) tail++;
  // Text alone cannot say where a repeated character went: a line break typed
  // after "{" in "{\n}" reads the same as one typed before "}". The caret can —
  // the edit ends where it is — and that decides which side of a fold it lands.
  if (caret !== undefined && caret >= 0 && caret <= nextVisible.length) {
    const tailAtCaret = nextVisible.length - caret;
    if (tailAtCaret <= before.length && before.endsWith(nextVisible.slice(caret))) {
      tail = tailAtCaret;
      start = Math.min(start, caret, before.length - tail);
    }
  }
  const inserted = nextVisible.slice(start, nextVisible.length - tail);
  let fullStart = visibleToFull(projection, start);
  const fullEnd = visibleToFull(projection, before.length - tail);
  let joinedFold: number | undefined;
  // The line break after a folded `{` line stands for every hidden line. A
  // deletion that STARTS there — Backspace at the start of the `}` line,
  // Delete at the end of the `{` line — removes only the last break, after the
  // hidden lines, so their content is kept. Typing there still goes right
  // after the `{`, where the caret is.
  if (fullEnd > fullStart) {
    const visibleLine = floorIndex(projection.visibleLineStarts, start);
    const lineEnd = (projection.visibleLineStarts[visibleLine + 1] ?? before.length + 1) - 1;
    if (start === lineEnd && projection.hiddenAfter.has(visibleLine)) {
      fullStart = projection.fullLineStarts[projection.lineMap[visibleLine + 1]] - 1;
      // The last hidden line now runs into the `}` line: show the block.
      joinedFold = projection.lineMap[visibleLine];
    }
  }
  const removed = full.slice(fullStart, fullEnd);
  const count = (text: string) => text.split('\n').length - 1;
  // A line break typed on the `{` or the `}` line of a fold can make a line
  // inside the block, where the fold would hide it. As in VS Code, that fold
  // opens instead (`reveal` is its `{` line).
  let reveal = joinedFold;
  if (inserted.includes('\n')) {
    const visibleLine = floorIndex(projection.visibleLineStarts, start);
    if (projection.hiddenAfter.has(visibleLine)) reveal = projection.lineMap[visibleLine];
    else if (projection.hiddenAfter.has(visibleLine - 1)) reveal = projection.lineMap[visibleLine - 1];
  }
  return {
    text: full.slice(0, fullStart) + inserted + full.slice(fullEnd),
    caret: fullStart + inserted.length,
    fromLine: floorIndex(projection.fullLineStarts, fullStart),
    lineDelta: count(inserted) - count(removed),
    reveal,
  };
}

/**
 * The folds after an edit: those below it move by the lines it added or
 * removed, and any that no longer open a foldable block are dropped.
 */
export function shiftFolds(
  folded: ReadonlySet<number>,
  fromLine: number,
  lineDelta: number,
  regions?: readonly FoldRegion[],
  previousRegions?: readonly FoldRegion[],
): Set<number> {
  const shift = (line: number) => (line > fromLine ? line + lineDelta : line);
  // With the regions from before the edit, a fold must keep its OWN block:
  // deleting its `}` pairs the `{` with a brace further down, and that is a
  // different block, which must not come up folded.
  const closeBefore = previousRegions ? new Map(previousRegions.map(region => [region.open, region.close])) : null;
  const closeAfter = regions ? new Map(regions.map(region => [region.open, region.close])) : null;
  const next = new Set<number>();
  for (const line of folded) {
    const moved = shift(line);
    if (closeAfter && !closeAfter.has(moved)) continue;
    const before = closeBefore?.get(line);
    if (closeAfter && before !== undefined && closeAfter.get(moved) !== shift(before)) continue;
    next.add(moved);
  }
  return next;
}

/** The folded regions that hide a file line, so a search hit there can be revealed. */
export function foldsHiding(line: number, regions: readonly FoldRegion[], folded: ReadonlySet<number>): number[] {
  return regions.filter(region => folded.has(region.open) && line > region.open && line < region.close).map(region => region.open);
}

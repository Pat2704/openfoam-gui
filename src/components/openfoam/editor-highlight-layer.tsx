'use client';

/**
 * The layer the File Editor draws OVER its textarea: the same text, with
 * comments and numbers in their own colours, the indent guides of `{ … }`
 * blocks, search hits, and the fold arrow beside every foldable `{`.
 *
 * The textarea keeps the text transparent and its caret visible, so what the
 * user sees is this layer while every keystroke, selection and undo is still
 * the browser's own. The layer lets every click through (pointer-events:
 * none) except on the fold arrows, which is why it sits above the textarea
 * rather than behind it. For the two to line up they lay text out identically
 * — same font, padding, line height, tab size and wrapping width — and the
 * editor moves this layer with the textarea's scroll offsets. Nothing drawn
 * here may take horizontal room the textarea does not have: the arrows sit in
 * zero-width boxes so they cannot move a wrap.
 */

import React, { memo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { markSegments, type HighlightLine, type LineMark } from '@/lib/editor-highlight';

/** The theme's own colours, used until the user picks others. */
const DEFAULT_COMMENT_CLASS = 'text-[#008000] dark:text-[#6A9955]';
const DEFAULT_NUMBER_CLASS = 'text-[#098658] dark:text-[#B5CEA8]';

/** One visible line: its highlight, the hits on it and its fold, if any. */
export interface LayerRow {
  line: HighlightLine;
  marks: LineMark[];
  /** File lines hidden right after this one by a fold. */
  hidden: number;
  /** The foldable block whose `{` is on this line: its `{` line and column. */
  fold?: { open: number; char: number; folded: boolean };
}

function sameRow(a: LayerRow, b: LayerRow): boolean {
  if (a.hidden !== b.hidden || a.marks.length !== b.marks.length) return false;
  if (a.fold?.open !== b.fold?.open || a.fold?.char !== b.fold?.char || a.fold?.folded !== b.fold?.folded) return false;
  for (let i = 0; i < a.marks.length; i++) {
    const x = a.marks[i];
    const y = b.marks[i];
    if (x.start !== y.start || x.end !== y.end || x.current !== y.current) return false;
  }
  const p = a.line;
  const q = b.line;
  if (p === q) return true;
  if (p.guides.length !== q.guides.length || p.segments.length !== q.segments.length) return false;
  for (let i = 0; i < p.guides.length; i++) if (p.guides[i] !== q.guides[i]) return false;
  for (let i = 0; i < p.segments.length; i++) {
    const x = p.segments[i];
    const y = q.segments[i];
    if (x.text !== y.text || x.comment !== y.comment || x.number !== y.number) return false;
  }
  return true;
}

const MARK_CLASS = ['', 'rounded-sm bg-amber-300/40 dark:bg-amber-400/25', 'rounded-sm bg-amber-400/80 dark:bg-amber-500/60'];

interface LineProps {
  row: LayerRow;
  commentColor: string;
  numberColor: string;
  guides: boolean;
  onToggleFold: (open: number) => void;
}

/** The arrow after a foldable `{`; folded, it also says how much it hides. */
function FoldControl({ row, onToggleFold }: { row: LayerRow; onToggleFold: (open: number) => void }) {
  const fold = row.fold!;
  return (
    // A zero-width, line-high box: the control cannot move a wrap, and it is
    // placed against this line rather than against its baseline.
    <span className="relative inline-block h-5 w-0 align-top">
      <button
        type="button"
        tabIndex={-1}
        // Keep the caret, and the focus, in the textarea underneath.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onToggleFold(fold.open)}
        className={`pointer-events-auto absolute left-0.5 top-0.5 flex h-4 items-center gap-0.5 whitespace-nowrap rounded font-sans text-[10px] leading-4 transition-opacity ${
          fold.folded
            ? 'border border-foreground/15 bg-muted px-0.5 text-muted-foreground hover:text-foreground'
            : 'text-muted-foreground opacity-40 hover:opacity-100 hover:bg-muted'
        }`}
        title={fold.folded ? 'Unfold this block' : 'Fold this block'}
        aria-label={`${fold.folded ? 'Unfold' : 'Fold'} the block at line ${fold.open + 1}`}
        aria-expanded={!fold.folded}
      >
        {fold.folded ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        {fold.folded && <span className="pr-0.5">⋯ {row.hidden} {row.hidden === 1 ? 'line' : 'lines'}</span>}
      </button>
    </span>
  );
}

/**
 * One line. Memoised on its content, so typing re-renders the line being
 * edited rather than all of them — what keeps a 10 000-line dictionary
 * responsive.
 */
const Line = memo(function Line({ row, commentColor, numberColor, guides, onToggleFold }: LineProps) {
  const cut = row.fold ? row.fold.char + 1 : -1;
  const pieces: React.ReactNode[] = [];
  let offset = 0;
  let placed = false;
  for (const [k, segment] of markSegments(row.line.segments, row.marks, cut > 0 ? [cut] : []).entries()) {
    const style = segment.comment ? commentColor : segment.number ? numberColor : '';
    const themeClass = segment.comment ? DEFAULT_COMMENT_CLASS : segment.number ? DEFAULT_NUMBER_CLASS : '';
    const className = [style ? '' : themeClass, MARK_CLASS[segment.mark]].filter(Boolean).join(' ');
    pieces.push(className || style
      ? <span key={k} className={className || undefined} style={style ? { color: style } : undefined}>{segment.text}</span>
      : <React.Fragment key={k}>{segment.text}</React.Fragment>);
    offset += segment.text.length;
    if (!placed && row.fold && offset === cut) {
      pieces.push(<FoldControl key="fold" row={row} onToggleFold={onToggleFold} />);
      placed = true;
    }
  }
  return (
    // min-h-5 matches leading-5: an empty line still takes its row.
    <div className="relative min-h-5">
      {guides && row.line.guides.map((column, k) => (
        <span
          key={k}
          aria-hidden="true"
          className="absolute top-0 bottom-0 border-l border-foreground/15"
          style={{ left: `${column}ch` }}
        />
      ))}
      {pieces}
    </div>
  );
}, (prev, next) => prev.commentColor === next.commentColor && prev.numberColor === next.numberColor
  && prev.guides === next.guides && prev.onToggleFold === next.onToggleFold && sameRow(prev.row, next.row));

export const EditorHighlightLayer = React.forwardRef<HTMLDivElement, {
  rows: LayerRow[];
  /** #rrggbb colours, or '' for the theme defaults. */
  commentColor: string;
  numberColor: string;
  guides: boolean;
  wordWrap: boolean;
  /** The textarea's clientWidth, which wrapped lines must share. */
  width: number | null;
  /** Must be stable across renders: every line is memoised on it. */
  onToggleFold: (open: number) => void;
}>(function EditorHighlightLayer({ rows, commentColor, numberColor, guides, wordWrap, width, onToggleFold }, ref) {
  return (
    // aria-hidden: this repeats the textarea's text, which is what a screen
    // reader should read. The arrows are a pointer shortcut; Fold all and
    // Unfold all in the toolbar are the keyboard's way to the same thing.
    <div
      ref={ref}
      aria-hidden="true"
      className="p-3 font-mono text-xs leading-5 text-foreground will-change-transform"
      style={{
        tabSize: 4,
        whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
        overflowWrap: wordWrap ? 'break-word' : 'normal',
        width: wordWrap && width ? `${width}px` : 'max-content',
        minWidth: '100%',
      }}
    >
      {rows.map((row, i) => (
        <Line key={i} row={row} commentColor={commentColor} numberColor={numberColor} guides={guides} onToggleFold={onToggleFold} />
      ))}
    </div>
  );
});

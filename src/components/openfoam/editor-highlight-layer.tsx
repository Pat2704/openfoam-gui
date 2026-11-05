'use client';

/**
 * The layer the File Editor draws BEHIND its textarea: the same text, with
 * comments in their own colour, the indent guides of `{ … }` blocks, search
 * hits, and a marker where a folded block hides lines.
 *
 * The textarea on top keeps the text transparent and its caret visible, so
 * what the user sees is this layer while every keystroke, selection and undo
 * is still the browser's own. For that to line up the two must lay text out
 * identically — same font, padding, line height, tab size and wrapping width —
 * and the editor moves this layer with the textarea's scroll offsets. Nothing
 * drawn here may take horizontal room the textarea does not have: the fold
 * marker sits in a zero-width box so it cannot move a wrap.
 */

import React, { memo } from 'react';
import { markSegments, type HighlightLine, type LineMark } from '@/lib/editor-highlight';

/** The theme's own comment colour, used until the user picks one. */
const DEFAULT_COMMENT_CLASS = 'text-[#008000] dark:text-[#6A9955]';

/** One visible line: its highlight, the hits on it and the lines folded after it. */
export interface LayerRow {
  line: HighlightLine;
  marks: LineMark[];
  /** File lines hidden right after this one by a fold. */
  hidden: number;
}

function sameRow(a: LayerRow, b: LayerRow): boolean {
  if (a.hidden !== b.hidden || a.marks.length !== b.marks.length) return false;
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
    if (p.segments[i].text !== q.segments[i].text || p.segments[i].comment !== q.segments[i].comment) return false;
  }
  return true;
}

const MARK_CLASS = ['', 'rounded-sm bg-amber-300/40 dark:bg-amber-400/25', 'rounded-sm bg-amber-400/80 dark:bg-amber-500/60'];

/**
 * One line. Memoised on its content, so typing re-renders the line being
 * edited rather than all of them — what keeps a 10 000-line dictionary
 * responsive.
 */
const Line = memo(function Line({ row, commentColor, guides }: { row: LayerRow; commentColor: string; guides: boolean }) {
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
      {markSegments(row.line.segments, row.marks).map((segment, k) => {
        const comment = segment.comment
          ? { className: commentColor ? undefined : DEFAULT_COMMENT_CLASS, style: commentColor ? { color: commentColor } : undefined }
          : { className: undefined, style: undefined };
        if (!segment.comment && !segment.mark) return <React.Fragment key={k}>{segment.text}</React.Fragment>;
        return (
          <span key={k} className={[comment.className, MARK_CLASS[segment.mark]].filter(Boolean).join(' ') || undefined} style={comment.style}>
            {segment.text}
          </span>
        );
      })}
      {row.hidden > 0 && (
        // A zero-width, line-high box: the marker cannot move a wrap, and it
        // is positioned against this line rather than against its baseline.
        <span className="relative inline-block h-5 w-0 align-top">
          <span className="absolute left-2 top-0.5 whitespace-nowrap rounded border border-foreground/15 bg-muted px-1 text-[10px] leading-4 text-muted-foreground">
            ⋯ {row.hidden} {row.hidden === 1 ? 'line' : 'lines'}
          </span>
        </span>
      )}
    </div>
  );
}, (prev, next) => prev.commentColor === next.commentColor && prev.guides === next.guides && sameRow(prev.row, next.row));

export const EditorHighlightLayer = React.forwardRef<HTMLDivElement, {
  rows: LayerRow[];
  /** A #rrggbb colour, or '' for the theme default. */
  commentColor: string;
  guides: boolean;
  wordWrap: boolean;
  /** The textarea's clientWidth, which wrapped lines must share. */
  width: number | null;
}>(function EditorHighlightLayer({ rows, commentColor, guides, wordWrap, width }, ref) {
  return (
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
      {rows.map((row, i) => <Line key={i} row={row} commentColor={commentColor} guides={guides} />)}
    </div>
  );
});

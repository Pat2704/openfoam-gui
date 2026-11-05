'use client';

/**
 * The layer the File Editor draws BEHIND its textarea: the same text, with
 * comments in their own colour and the indent guides of `{ … }` blocks.
 *
 * The textarea on top keeps the text transparent and its caret visible, so
 * what the user sees is this layer while every keystroke, selection and undo
 * is still the browser's own. For that to line up the two must lay text out
 * identically — same font, padding, line height, tab size and wrapping width —
 * and the editor moves this layer with the textarea's scroll offsets.
 */

import React, { memo, useMemo } from 'react';
import { highlightFoam, type HighlightLine } from '@/lib/editor-highlight';

/** The theme's own comment colour, used until the user picks one. */
const DEFAULT_COMMENT_CLASS = 'text-[#008000] dark:text-[#6A9955]';

function sameLine(a: HighlightLine, b: HighlightLine): boolean {
  if (a.guides.length !== b.guides.length || a.segments.length !== b.segments.length) return false;
  for (let i = 0; i < a.guides.length; i++) if (a.guides[i] !== b.guides[i]) return false;
  for (let i = 0; i < a.segments.length; i++) {
    if (a.segments[i].text !== b.segments[i].text || a.segments[i].comment !== b.segments[i].comment) return false;
  }
  return true;
}

/**
 * One line. Memoised on its content, so typing re-renders the line being
 * edited rather than all of them — what keeps a 10 000-line dictionary
 * responsive.
 */
const Line = memo(function Line({ line, commentColor, guides }: { line: HighlightLine; commentColor: string; guides: boolean }) {
  return (
    // min-h-5 matches leading-5: an empty line still takes its row.
    <div className="relative min-h-5">
      {guides && line.guides.map((column, k) => (
        <span
          key={k}
          aria-hidden="true"
          className="absolute top-0 bottom-0 border-l border-foreground/15"
          style={{ left: `${column}ch` }}
        />
      ))}
      {line.segments.map((segment, k) => segment.comment ? (
        <span key={k} className={commentColor ? undefined : DEFAULT_COMMENT_CLASS} style={commentColor ? { color: commentColor } : undefined}>
          {segment.text}
        </span>
      ) : (
        <React.Fragment key={k}>{segment.text}</React.Fragment>
      ))}
    </div>
  );
}, (prev, next) => prev.commentColor === next.commentColor && prev.guides === next.guides && sameLine(prev.line, next.line));

export const EditorHighlightLayer = React.forwardRef<HTMLDivElement, {
  text: string;
  /** A #rrggbb colour, or '' for the theme default. */
  commentColor: string;
  guides: boolean;
  wordWrap: boolean;
  /** The textarea's clientWidth, which wrapped lines must share. */
  width: number | null;
}>(function EditorHighlightLayer({ text, commentColor, guides, wordWrap, width }, ref) {
  const lines = useMemo(() => highlightFoam(text), [text]);
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
      {lines.map((line, i) => <Line key={i} line={line} commentColor={commentColor} guides={guides} />)}
    </div>
  );
});

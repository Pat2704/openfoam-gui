'use client';

/**
 * Save a chart as a picture, with the picture on screen before it is written.
 *
 * THE PREVIEW IS THE FILE, LITERALLY
 *
 * The first version rendered a chart at output size, showed it, and serialized
 * its `<svg>` on export. That was not the same picture, and the difference was
 * invisible until the file was opened: recharts draws `<Legend>` as an HTML
 * `<div>` positioned OVER the svg, so cloning the svg node dropped the legend
 * entirely, and the axis titles were drawn by a separate overlay too. The
 * export lost exactly the parts a figure needs.
 *
 * So the markup is built once and used for both. A hidden container renders the
 * chart, `buildSvg` turns it into a standalone document — background, fonts,
 * title, axis titles and a legend drawn as real SVG — and the preview displays
 * that document. Whatever is missing from the preview is missing from the file,
 * which is the only way to keep the promise this dialog makes.
 *
 * SVG is the default because a line chart stays sharp at any size and keeps its
 * text selectable. PNG is rasterised from the same document, so the two cannot
 * disagree.
 */

import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import { Download, Image as ImageIcon, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export interface ExportSeries {
  /** Index into each row. */
  index: number;
  name: string;
  color: string;
}

export interface ChartExportSource {
  columns: string[];
  rows: (number | null)[][];
  series: ExportSeries[];
  xLabel: string;
  yLabel: string;
  logScale: boolean;
  /** The window the chart on screen was zoomed to, when it was. */
  xDomain?: [number, number];
  yDomain?: [number, number];
  /** The shape the user dragged the chart into, width / height. */
  aspect?: number;
  /** Suggested file name without an extension. */
  fileName: string;
  /** Suggested chart title. */
  title: string;
}

interface ExportOptions {
  format: 'svg' | 'png';
  width: number;
  height: number;
  pixelRatio: number;
  background: 'transparent' | 'white' | 'dark' | 'custom';
  customColor: string;
  foreground: string;
  title: string;
  xLabel: string;
  yLabel: string;
  showTitle: boolean;
  showGrid: boolean;
  showLegend: boolean;
  showAxisLabels: boolean;
  lineWidth: number;
  fontSize: number;
  logScale: boolean;
}

const SIZE_PRESETS: { label: string; width: number; height: number }[] = [
  { label: 'Report figure — 1600 × 900', width: 1600, height: 900 },
  { label: 'Square — 1200 × 1200', width: 1200, height: 1200 },
  { label: 'Slide — 1920 × 1080', width: 1920, height: 1080 },
  { label: 'Two-column paper — 1000 × 750', width: 1000, height: 750 },
];

const FONT_STACK = `system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

/** The paper colour, and the ink that has to stay readable on it. */
function resolveColors(options: ExportOptions): { background: string | null; foreground: string; grid: string } {
  switch (options.background) {
    case 'transparent':
      // Nothing is painted, so the ink has to work on whatever it lands on.
      // Dark grey reads on white paper and on a light slide alike.
      return { background: null, foreground: '#1f2937', grid: '#9ca3af' };
    case 'white':
      return { background: '#ffffff', foreground: '#1f2937', grid: '#d1d5db' };
    case 'dark':
      return { background: '#111827', foreground: '#e5e7eb', grid: '#374151' };
    case 'custom':
      return { background: options.customColor, foreground: options.foreground, grid: `${options.foreground}55` };
  }
}

function formatTick(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e4 || magnitude < 1e-2) return value.toExponential(1);
  return String(Number(value.toPrecision(3)));
}

/** Text measurement, so the legend can be laid out before it is drawn. */
let measuringContext: CanvasRenderingContext2D | null = null;
function measureText(text: string, fontSize: number): number {
  if (!measuringContext) measuringContext = document.createElement('canvas').getContext('2d');
  if (!measuringContext) return text.length * fontSize * 0.55;
  measuringContext.font = `${fontSize}px ${FONT_STACK}`;
  return measuringContext.measureText(text).width;
}

interface LegendItem { name: string; color: string; x: number; width: number; row: number }

/**
 * Lay the legend out into rows that fit the page.
 *
 * Drawn rather than delegated because recharts' own legend is HTML and would
 * not survive into the file. Measuring each label means a residual plot with
 * five short names takes one row and a probes file with long coordinate names
 * wraps instead of running off the edge.
 */
function layoutLegend(series: readonly ExportSeries[], fontSize: number, maxWidth: number): { items: LegendItem[]; rows: number } {
  const swatch = fontSize * 1.8;
  const gap = fontSize * 0.5;
  const between = fontSize * 1.5;
  const items: LegendItem[] = [];
  let x = 0;
  let row = 0;
  for (const entry of series) {
    const width = swatch + gap + measureText(entry.name, fontSize);
    if (x > 0 && x + width > maxWidth) {
      row += 1;
      x = 0;
    }
    items.push({ name: entry.name, color: entry.color, x, width, row });
    x += width + between;
  }
  return { items, rows: series.length ? row + 1 : 0 };
}

function svgEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default function ChartExportDialog({
  open,
  onOpenChange,
  source,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: ChartExportSource | null;
}) {
  const [options, setOptions] = useState<ExportOptions>({
    format: 'svg',
    width: 1600,
    height: 900,
    pixelRatio: 2,
    background: 'white',
    customColor: '#f8fafc',
    foreground: '#1f2937',
    title: '',
    xLabel: '',
    yLabel: '',
    showTitle: true,
    showGrid: true,
    showLegend: true,
    showAxisLabels: true,
    lineWidth: 2,
    fontSize: 16,
    logScale: false,
  });
  const [busy, setBusy] = useState(false);
  const [markup, setMarkup] = useState('');
  /**
   * The offscreen node the chart is drawn into, held in STATE rather than in a
   * ref.
   *
   * Radix mounts the dialog's content in a later commit than the one where
   * `open` turns true, so a plain ref was still null when the effect below
   * first ran: it returned early, never attached its observer, and the preview
   * stayed blank until some other change re-ran it. A callback ref re-renders
   * when the node actually appears, which is the signal that was missing.
   */
  const [holder, setHolder] = useState<HTMLDivElement | null>(null);

  const set = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) =>
    setOptions(current => ({ ...current, [key]: value }));

  // Titles and the log axis follow the chart the user was looking at, until
  // they change them here. Keyed on the source so reopening on another dataset
  // does not carry the previous one's labels.
  const [syncedFor, setSyncedFor] = useState<string | null>(null);
  /**
   * The window and the shape of the figure, both draggable in the preview.
   *
   * They start from the chart the user was looking at: having zoomed in on the
   * interesting decade and pulled the plot into the shape they wanted, opening
   * this dialog should not throw that away and offer the whole dataset again.
   */
  const [viewport, setViewport] = useState<{ x: [number, number]; y: [number, number] } | null>(null);
  if (open && source && syncedFor !== source.fileName) {
    setSyncedFor(source.fileName);
    setViewport(source.xDomain && source.yDomain ? { x: source.xDomain, y: source.yDomain } : null);
    setOptions(current => {
      const height = source.aspect
        ? Math.max(400, Math.min(2400, Math.round(current.width / source.aspect)))
        : current.height;
      return {
        ...current,
        title: source.title,
        xLabel: source.xLabel,
        yLabel: source.yLabel,
        logScale: source.logScale,
        height,
      };
    });
  }
  if (!open && syncedFor !== null) setSyncedFor(null);

  const colors = resolveColors(options);

  // A log axis cannot draw a value at or below zero, but one such sample is no
  // reason to refuse the axis for the whole figure — those points become gaps,
  // exactly as they do on the chart this dialog was opened from.
  const logUsable = useMemo(() => {
    if (!source) return false;
    return source.rows.some(row => source.series.some(series => {
      const value = row[series.index];
      return typeof value === 'number' && Number.isFinite(value) && value > 0;
    }));
  }, [source]);
  const logScale = options.logScale && logUsable;

  const chartRows = useMemo(() => {
    if (!source) return [];
    return source.rows.map(row => {
      const point: Record<string, number | undefined> = { x: row[0] ?? undefined };
      for (const series of source.series) {
        const value = row[series.index];
        const drawable = value !== null && Number.isFinite(value) && (!logScale || value > 0);
        point[`c${series.index}`] = drawable ? value : undefined;
      }
      return point;
    });
  }, [source, logScale]);


  // ── The space the drawn furniture needs, reserved before the chart is laid
  //    out so that curves never run under the title or the legend.
  const titleHeight = options.showTitle && options.title.trim() ? options.fontSize * 2.4 : 0;
  const legend = useMemo(
    () => (options.showLegend && source
      ? layoutLegend(source.series, options.fontSize, options.width - options.fontSize * 6)
      : { items: [], rows: 0 }),
    [options.showLegend, options.fontSize, options.width, source],
  );
  const legendHeight = legend.rows * options.fontSize * 1.7;
  const topMargin = Math.round(options.fontSize + titleHeight + legendHeight);

  const chart = source && (
    <ComposedChart
      width={options.width}
      height={options.height}
      data={chartRows}
      margin={{
        top: topMargin,
        right: options.fontSize * 2,
        bottom: options.showAxisLabels && options.xLabel.trim() ? options.fontSize * 2.6 : options.fontSize,
        left: options.showAxisLabels && options.yLabel.trim() ? options.fontSize * 1.8 : 0,
      }}
    >
      {options.showGrid && <CartesianGrid strokeDasharray="4 4" stroke={colors.grid} />}
      <XAxis
        dataKey="x"
        type="number"
        scale="linear"
        domain={viewport ? viewport.x : ['dataMin', 'dataMax']}
        allowDataOverflow={Boolean(viewport)}
        stroke={colors.foreground}
        tick={{ fontSize: options.fontSize, fill: colors.foreground }}
        tickFormatter={formatTick}
        tickCount={8}
        // minTickGap, not tickCount, is what thins labels on a numeric axis;
        // scaled with the font so a bigger export does not crowd again.
        minTickGap={options.fontSize * 3.5}
      />
      <YAxis
        scale={logScale ? 'log' : 'linear'}
        type="number"
        domain={viewport ? viewport.y : ['auto', 'auto']}
        allowDataOverflow={Boolean(viewport)}
        stroke={colors.foreground}
        tick={{ fontSize: options.fontSize, fill: colors.foreground }}
        tickFormatter={formatTick}
        width={options.fontSize * 5}
      />
      {source.series.map(series => (
        <Line
          key={series.index}
          type="monotone"
          dataKey={`c${series.index}`}
          name={series.name}
          stroke={series.color}
          strokeWidth={options.lineWidth}
          dot={false}
          connectNulls
          isAnimationActive={false}
        />
      ))}
    </ComposedChart>
  );

  /**
   * Turn the rendered chart into a standalone SVG document.
   *
   * Everything the file needs that the page supplied implicitly has to be put
   * in explicitly: the font stack as a `<style>` rule, the background as a real
   * `rect` (a CSS background is not part of the drawing and is lost the moment
   * the file is placed in a document), and the title, axis titles and legend as
   * SVG text, because those are the pieces recharts either draws in HTML or
   * inherits from the page.
   */
  const buildSvg = React.useCallback((): string => {
    const original = holder?.querySelector('svg');
    if (!original || !source) return '';
    const clone = original.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    clone.setAttribute('width', String(options.width));
    clone.setAttribute('height', String(options.height));
    clone.setAttribute('viewBox', `0 0 ${options.width} ${options.height}`);

    const pieces: string[] = [];
    pieces.push(`<style>text{font-family:${FONT_STACK};}</style>`);
    if (colors.background) {
      pieces.push(`<rect x="0" y="0" width="${options.width}" height="${options.height}" fill="${colors.background}"/>`);
    }

    const inner = clone.innerHTML;
    const after: string[] = [];

    if (titleHeight) {
      after.push(
        `<text x="${options.width / 2}" y="${Math.round(options.fontSize * 1.8)}" text-anchor="middle"` +
        ` font-size="${Math.round(options.fontSize * 1.35)}" font-weight="600" fill="${colors.foreground}">` +
        `${svgEscape(options.title.trim())}</text>`,
      );
    }

    if (legend.items.length) {
      // Centred as a block under the title, one row per wrapped line.
      const rowWidths = new Map<number, number>();
      for (const item of legend.items) rowWidths.set(item.row, item.x + item.width);
      const swatch = options.fontSize * 1.8;
      for (const item of legend.items) {
        const rowWidth = rowWidths.get(item.row) ?? 0;
        const originX = (options.width - rowWidth) / 2 + item.x;
        const originY = titleHeight + options.fontSize * 0.4 + item.row * options.fontSize * 1.7;
        const middle = originY + options.fontSize * 0.6;
        after.push(
          `<line x1="${originX.toFixed(1)}" y1="${middle.toFixed(1)}" x2="${(originX + swatch).toFixed(1)}" y2="${middle.toFixed(1)}"` +
          ` stroke="${item.color}" stroke-width="${options.lineWidth}" stroke-linecap="round"/>`,
          `<text x="${(originX + swatch + options.fontSize * 0.5).toFixed(1)}" y="${(middle + options.fontSize * 0.36).toFixed(1)}"` +
          ` font-size="${options.fontSize}" fill="${colors.foreground}">${svgEscape(item.name)}</text>`,
        );
      }
    }

    if (options.showAxisLabels && options.xLabel.trim()) {
      after.push(
        `<text x="${options.width / 2}" y="${options.height - Math.round(options.fontSize * 0.5)}" text-anchor="middle"` +
        ` font-size="${options.fontSize}" fill="${colors.foreground}">${svgEscape(options.xLabel.trim())}</text>`,
      );
    }
    if (options.showAxisLabels && options.yLabel.trim()) {
      const y = topMargin + (options.height - topMargin) / 2;
      after.push(
        `<text x="${Math.round(options.fontSize * 1.2)}" y="${y.toFixed(1)}" text-anchor="middle"` +
        ` font-size="${options.fontSize}" fill="${colors.foreground}"` +
        ` transform="rotate(-90 ${Math.round(options.fontSize * 1.2)} ${y.toFixed(1)})">${svgEscape(options.yLabel.trim())}</text>`,
      );
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"` +
      ` width="${options.width}" height="${options.height}" viewBox="0 0 ${options.width} ${options.height}">` +
      `${pieces.join('')}${inner}${after.join('')}</svg>`;
  }, [holder, source, options, colors.background, colors.foreground, titleHeight, legend.items, topMargin]);

  /**
   * Rebuild the document, and keep rebuilding it while recharts is still
   * drawing.
   *
   * A single read after the commit was not enough: recharts does not always
   * have its `<svg>` in the DOM by then, `buildSvg` came back empty, and
   * nothing re-ran the effect afterwards — so the preview stayed blank until
   * any click changed an option and happened to rebuild it. Watching the
   * hidden holder answers for whatever recharts does and whenever it does it.
   *
   * There is no feedback loop: the observer watches the holder, and the markup
   * it produces is rendered into a different element. Rebuilds are coalesced
   * onto a frame because a chart of a few thousand points serialises to about
   * half a megabyte and recharts mutates its subtree several times in a row.
   */
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const rebuild = () => {
      const next = buildSvg();
      // Never replace a good document with an empty one: an intermediate state
      // where the svg has gone missing would blank the preview.
      if (next) setMarkup(current => (current === next ? current : next));
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; rebuild(); });
    };

    rebuild();
    if (!holder) return;
    const observer = new MutationObserver(schedule);
    // characterData included: recharts reuses its tick <text> nodes and only
    // rewrites their content, so a change of axis window mutated nothing the
    // observer was watching — the preview, and therefore the file, kept the
    // previous framing.
    observer.observe(holder, { childList: true, subtree: true, attributes: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [open, holder, buildSvg, chartRows, logScale, source, viewport]);

  const download = (blob: Blob, extension: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${source?.fileName || 'chart'}.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoked later, not immediately: Chromium reads the blob after the click
    // returns, and revoking synchronously cancels the download.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const save = async () => {
    if (!markup) {
      toast.error('The chart is not ready to export yet');
      return;
    }
    setBusy(true);
    try {
      if (options.format === 'svg') {
        download(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }), 'svg');
        toast.success('Chart saved as SVG');
        return;
      }

      // A data: URL rather than a blob: URL. Drawing a blob-backed SVG into a
      // canvas taints it in some engines, and a tainted canvas refuses toBlob —
      // the export would fail at the last step with a security error.
      const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
      const image = new window.Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('The chart could not be rasterised'));
        image.src = encoded;
      });

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(options.width * options.pixelRatio);
      canvas.height = Math.round(options.height * options.pixelRatio);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This machine has no 2D canvas');
      if (colors.background) {
        context.fillStyle = colors.background;
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('The image could not be encoded');
      download(blob, 'png');
      toast.success(`Chart saved as PNG, ${canvas.width} × ${canvas.height}`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'The chart could not be saved');
    } finally {
      setBusy(false);
    }
  };

  const PREVIEW_WIDTH = 620;
  const PREVIEW_HEIGHT = 430;
  const scale = Math.min(PREVIEW_WIDTH / options.width, PREVIEW_HEIGHT / options.height, 1);

  /**
   * Pan, zoom and resize, done ON the preview.
   *
   * The preview is the document that will be written, so a gesture here is not
   * a way of inspecting the figure — it IS the edit. Dragging moves the window
   * over the data, the wheel scales it around the pointer, and the corner
   * handle changes the output size, which is what gives the saved figure its
   * shape. All three work in output pixels and divide by `scale`, so the
   * picture follows the pointer at whatever zoom the preview happens to be at.
   */
  const previewRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const resizeRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  const plotArea = React.useCallback(() => {
    const box = previewRef.current?.getBoundingClientRect();
    if (!box || !source) return null;
    // Mirrors the margins the chart above is built with, in output units.
    const left = (options.showAxisLabels && options.yLabel.trim() ? options.fontSize * 1.8 : 0) + options.fontSize * 5;
    const right = options.fontSize * 2;
    const bottom = (options.showAxisLabels && options.xLabel.trim() ? options.fontSize * 2.6 : options.fontSize) + 30;
    const width = options.width - left - right;
    const height = options.height - topMargin - bottom;
    if (width < 40 || height < 40) return null;
    return {
      left: box.left + left * scale,
      top: box.top + topMargin * scale,
      width: width * scale,
      height: height * scale,
      bottom: box.top + (topMargin + height) * scale,
    };
  }, [source, options, topMargin, scale]);

  /** The window a gesture starts from: the explicit one, or what the data spans. */
  const currentWindow = React.useCallback((): { x: [number, number]; y: [number, number] } | null => {
    if (viewport) return viewport;
    if (!source) return null;
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const row of source.rows) {
      const x = row[0];
      if (typeof x === 'number' && Number.isFinite(x)) {
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
      }
      for (const series of source.series) {
        const value = row[series.index];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        if (logScale && value <= 0) continue;
        if (value < yMin) yMin = value;
        if (value > yMax) yMax = value;
      }
    }
    if (!Number.isFinite(xMin) || !Number.isFinite(yMin)) return null;
    if (xMax === xMin) { xMin -= 0.5; xMax += 0.5; }
    if (yMax === yMin) { if (logScale) { yMin /= 2; yMax *= 2; } else { yMin -= 0.5; yMax += 0.5; } }
    return { x: [xMin, xMax], y: [yMin, yMax] };
  }, [viewport, source, logScale]);

  const scaleRange = (range: [number, number], factor: number, anchor: number, logarithmic: boolean): [number, number] => {
    if (logarithmic) {
      const low = Math.log10(range[0]);
      const high = Math.log10(range[1]);
      const pivot = low + (high - low) * anchor;
      const nextLow = pivot - (pivot - low) * factor;
      const nextHigh = pivot + (high - pivot) * factor;
      if (nextHigh - nextLow < 0.05 || nextHigh - nextLow > 40) return range;
      return [Math.pow(10, nextLow), Math.pow(10, nextHigh)];
    }
    const pivot = range[0] + (range[1] - range[0]) * anchor;
    const low = pivot - (pivot - range[0]) * factor;
    const high = pivot + (range[1] - pivot) * factor;
    if (!Number.isFinite(low) || !Number.isFinite(high) || high - low <= 0) return range;
    return [low, high];
  };

  const previewWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const area = plotArea();
    const window = currentWindow();
    if (!area || !window) return;
    event.preventDefault();
    const anchorX = Math.min(1, Math.max(0, (event.clientX - area.left) / area.width));
    const anchorY = Math.min(1, Math.max(0, (area.bottom - event.clientY) / area.height));
    const factor = event.deltaY > 0 ? 1.15 : 1 / 1.15;
    setViewport({
      x: event.altKey ? window.x : scaleRange(window.x, factor, anchorX, false),
      y: event.shiftKey ? window.y : scaleRange(window.y, factor, anchorY, logScale),
    });
  };

  const previewPan = (event: React.PointerEvent<HTMLDivElement>) => {
    const origin = panRef.current;
    const area = plotArea();
    const window = currentWindow();
    if (!origin || !area || !window) return;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    if (!dx && !dy) return;
    panRef.current = { x: event.clientX, y: event.clientY };
    const shiftX = -(dx / area.width) * (window.x[1] - window.x[0]);
    let nextY: [number, number];
    if (logScale) {
      const low = Math.log10(window.y[0]);
      const high = Math.log10(window.y[1]);
      const shift = (dy / area.height) * (high - low);
      nextY = [Math.pow(10, low + shift), Math.pow(10, high + shift)];
    } else {
      const shift = (dy / area.height) * (window.y[1] - window.y[0]);
      nextY = [window.y[0] + shift, window.y[1] + shift];
    }
    setViewport({ x: [window.x[0] + shiftX, window.x[1] + shiftX], y: nextY });
  };

  const previewResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const origin = resizeRef.current;
    if (!origin) return;
    setOptions(current => ({
      ...current,
      width: Math.max(400, Math.min(4000, Math.round(origin.width + (event.clientX - origin.x) / scale))),
      height: Math.max(300, Math.min(3000, Math.round(origin.height + (event.clientY - origin.y) / scale))),
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[86vh] sm:max-w-5xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="flex-shrink-0 border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <ImageIcon className="h-4 w-4 text-brand" />
            Save the chart
            <span className="text-[11px] font-normal text-muted-foreground">
              the preview below is the file itself, at {options.width} × {options.height}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-[1fr_290px] overflow-hidden">
          <div className="flex min-h-0 flex-col items-center justify-center overflow-auto bg-[repeating-conic-gradient(var(--muted)_0%_25%,transparent_0%_50%)] bg-[length:20px_20px] p-4">
            <div
              className="relative shadow-lg ring-1 ring-border"
              style={{ width: options.width * scale, height: options.height * scale }}
            >
              {/* The exported document, scaled. Not a second rendering of it. */}
              <div
                ref={previewRef}
                className="touch-none select-none"
                style={{
                  width: options.width, height: options.height,
                  transform: `scale(${scale})`, transformOrigin: 'top left',
                  cursor: 'grab',
                }}
                onWheel={previewWheel}
                onPointerDown={event => {
                  if (event.button !== 0) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  panRef.current = { x: event.clientX, y: event.clientY };
                }}
                onPointerMove={previewPan}
                onPointerUp={() => { panRef.current = null; }}
                onPointerCancel={() => { panRef.current = null; }}
                onDoubleClick={() => setViewport(null)}
                dangerouslySetInnerHTML={{ __html: markup }}
              />
              <div
                role="separator"
                aria-label="Resize the exported figure"
                title="Drag to change the size of the file"
                className="absolute -bottom-1.5 -right-1.5 h-5 w-5 cursor-nwse-resize rounded-sm border-b-2 border-r-2 border-border bg-background/70 hover:border-brand"
                onPointerDown={event => {
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  resizeRef.current = { x: event.clientX, y: event.clientY, width: options.width, height: options.height };
                }}
                onPointerMove={previewResize}
                onPointerUp={() => { resizeRef.current = null; }}
                onPointerCancel={() => { resizeRef.current = null; }}
              />
            </div>
            <p className="mt-3 text-[10px] text-muted-foreground">
              Drag the figure to pan · wheel to zoom (Shift: X only, Alt: Y only) · double-click to fit · drag the corner to resize
            </p>
          </div>

          <div className="flex min-h-0 flex-col border-l">
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-4 p-3">
                <div>
                  <Label className="text-[11px]">Size</Label>
                  <Select
                    value={`${options.width}x${options.height}`}
                    onValueChange={value => {
                      const [width, height] = value.split('x').map(Number);
                      setOptions(current => ({ ...current, width, height }));
                    }}
                  >
                    <SelectTrigger size="sm" className="mt-1 w-full text-xs"><SelectValue placeholder="Custom" /></SelectTrigger>
                    <SelectContent>
                      {SIZE_PRESETS.map(preset => (
                        <SelectItem key={preset.label} value={`${preset.width}x${preset.height}`} className="text-xs">
                          {preset.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="mt-1.5 grid grid-cols-2 gap-2">
                    <div>
                      <Label htmlFor="ex-w" className="text-[10px] text-muted-foreground">width</Label>
                      <Input
                        id="ex-w" type="number" min={200} max={8000}
                        className="mt-0.5 h-7 font-mono text-xs"
                        value={options.width}
                        onChange={event => set('width', Math.max(200, Math.min(8000, Number(event.target.value) || 200)))}
                      />
                    </div>
                    <div>
                      <Label htmlFor="ex-h" className="text-[10px] text-muted-foreground">height</Label>
                      <Input
                        id="ex-h" type="number" min={200} max={8000}
                        className="mt-0.5 h-7 font-mono text-xs"
                        value={options.height}
                        onChange={event => set('height', Math.max(200, Math.min(8000, Number(event.target.value) || 200)))}
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <Label className="text-[11px]">Background</Label>
                  <div className="mt-1 grid grid-cols-4 gap-1">
                    {(['transparent', 'white', 'dark', 'custom'] as const).map(value => (
                      <Button
                        key={value}
                        size="sm"
                        variant={options.background === value ? 'default' : 'outline'}
                        className="h-7 px-1 text-[9px] capitalize"
                        onClick={() => set('background', value)}
                      >
                        {value}
                      </Button>
                    ))}
                  </div>
                  {options.background === 'custom' && (
                    <div className="mt-1.5 grid grid-cols-2 gap-2">
                      <div>
                        <Label htmlFor="ex-bg" className="text-[10px] text-muted-foreground">paper</Label>
                        <Input id="ex-bg" type="color" className="mt-0.5 h-7 p-1" value={options.customColor} onChange={event => set('customColor', event.target.value)} />
                      </div>
                      <div>
                        <Label htmlFor="ex-fg" className="text-[10px] text-muted-foreground">axes and text</Label>
                        <Input id="ex-fg" type="color" className="mt-0.5 h-7 p-1" value={options.foreground} onChange={event => set('foreground', event.target.value)} />
                      </div>
                    </div>
                  )}
                  {options.background === 'transparent' && (
                    <p className="mt-1 text-[9px] leading-snug text-muted-foreground">
                      PNG keeps the alpha channel. Axes and labels are drawn dark so they stay
                      readable on a light page.
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <div>
                    <Label htmlFor="ex-title" className="text-[11px]">Title</Label>
                    <Input id="ex-title" className="mt-1 h-7 text-xs" value={options.title} onChange={event => set('title', event.target.value)} placeholder="no title" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label htmlFor="ex-x" className="text-[10px] text-muted-foreground">x axis</Label>
                      <Input id="ex-x" className="mt-0.5 h-7 text-xs" value={options.xLabel} onChange={event => set('xLabel', event.target.value)} placeholder="no label" />
                    </div>
                    <div>
                      <Label htmlFor="ex-y" className="text-[10px] text-muted-foreground">y axis</Label>
                      <Input id="ex-y" className="mt-0.5 h-7 text-xs" value={options.yLabel} onChange={event => set('yLabel', event.target.value)} placeholder="no label" />
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  {([
                    ['showTitle', 'Show the title'],
                    ['showGrid', 'Grid lines'],
                    ['showLegend', 'Legend'],
                    ['showAxisLabels', 'Axis labels'],
                  ] as const).map(([key, label]) => (
                    <div key={key} className="flex items-center gap-2">
                      <Checkbox id={`ex-${key}`} checked={options[key]} onCheckedChange={value => set(key, value === true)} />
                      <Label htmlFor={`ex-${key}`} className="cursor-pointer text-[11px]">{label}</Label>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <Checkbox id="ex-log" checked={logScale} disabled={!logUsable} onCheckedChange={value => set('logScale', value === true)} />
                    <Label
                      htmlFor="ex-log"
                      className={`text-[11px] ${logUsable ? 'cursor-pointer' : 'text-muted-foreground'}`}
                      title={logUsable ? undefined : 'A log axis needs every plotted value to be positive'}
                    >
                      Logarithmic Y axis
                    </Label>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="ex-font" className="text-[10px] text-muted-foreground">font size</Label>
                    <Input
                      id="ex-font" type="number" min={8} max={48}
                      className="mt-0.5 h-7 font-mono text-xs"
                      value={options.fontSize}
                      onChange={event => set('fontSize', Math.max(8, Math.min(48, Number(event.target.value) || 8)))}
                    />
                  </div>
                  <div>
                    <Label htmlFor="ex-line" className="text-[10px] text-muted-foreground">line width</Label>
                    <Input
                      id="ex-line" type="number" min={1} max={10} step={0.5}
                      className="mt-0.5 h-7 font-mono text-xs"
                      value={options.lineWidth}
                      onChange={event => set('lineWidth', Math.max(1, Math.min(10, Number(event.target.value) || 1)))}
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-[11px]">Format</Label>
                  <div className="mt-1 grid grid-cols-2 gap-1">
                    <Button size="sm" variant={options.format === 'svg' ? 'default' : 'outline'} className="h-7 text-[10px]" onClick={() => set('format', 'svg')}>SVG</Button>
                    <Button size="sm" variant={options.format === 'png' ? 'default' : 'outline'} className="h-7 text-[10px]" onClick={() => set('format', 'png')}>PNG</Button>
                  </div>
                  {options.format === 'svg' ? (
                    <p className="mt-1 text-[9px] leading-snug text-muted-foreground">
                      Vector: stays sharp at any size, and the text stays selectable.
                    </p>
                  ) : (
                    <div className="mt-1.5">
                      <Label className="text-[10px] text-muted-foreground">pixel ratio</Label>
                      <div className="mt-0.5 grid grid-cols-3 gap-1">
                        {[1, 2, 3].map(ratio => (
                          <Button key={ratio} size="sm" variant={options.pixelRatio === ratio ? 'default' : 'outline'} className="h-7 text-[10px]" onClick={() => set('pixelRatio', ratio)}>
                            {ratio}×
                          </Button>
                        ))}
                      </div>
                      <p className="mt-1 font-mono text-[9px] text-muted-foreground">
                        {Math.round(options.width * options.pixelRatio)} × {Math.round(options.height * options.pixelRatio)} px
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </ScrollArea>

            <div className="flex flex-shrink-0 items-center gap-2 border-t px-3 py-2.5">
              <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button size="sm" className="ml-auto h-8 gap-1.5 text-xs" disabled={!source || busy || !markup} onClick={() => void save()}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                Save {options.format.toUpperCase()}
              </Button>
            </div>
          </div>
        </div>

        {/* The chart is rendered here, out of sight, purely so that its SVG can
            be read. Kept in the layout (not display:none) because recharts needs
            a real box to draw into. */}
        <div aria-hidden className="pointer-events-none fixed left-[-99999px] top-0 opacity-0">
          <div ref={setHolder} style={{ width: options.width, height: options.height }}>{chart}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

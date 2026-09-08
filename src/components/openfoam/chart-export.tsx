'use client';

/**
 * Save a chart as a picture, with the picture on screen before it is written.
 *
 * WHY IT IS A DIALOG AND NOT A BUTTON
 *
 * A chart sized for a panel in the app is the wrong chart for a report: the
 * fonts are tiny, the legend is somewhere else, and the background is whatever
 * theme happened to be on. Exporting the on-screen SVG directly produces
 * exactly that, which is why this renders a SEPARATE chart at the requested
 * output size and shows it: what the preview draws is what the file contains,
 * scaled down to fit the dialog and nothing else.
 *
 * SVG is the honest format for a line chart — it stays sharp at any size and
 * drops into a paper without resampling — so it is the default. PNG is produced
 * by rasterising that same SVG at a chosen pixel ratio, so the two cannot
 * disagree about what the chart looks like.
 */

import React, { useMemo, useRef, useState } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Legend,
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
  /** Column names; the first is the independent variable. */
  columns: string[];
  rows: (number | null)[][];
  series: ExportSeries[];
  xLabel: string;
  yLabel: string;
  logScale: boolean;
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
    showTitle: true,
    showGrid: true,
    showLegend: true,
    showAxisLabels: true,
    lineWidth: 2,
    fontSize: 16,
    logScale: false,
  });
  const [busy, setBusy] = useState(false);
  const holderRef = useRef<HTMLDivElement>(null);

  const set = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) =>
    setOptions(current => ({ ...current, [key]: value }));

  // The title and the log axis follow the chart the user was looking at, until
  // they change them here. Keyed on the source so reopening on another dataset
  // does not carry the previous one's title.
  const [syncedFor, setSyncedFor] = useState<string | null>(null);
  if (open && source && syncedFor !== source.fileName) {
    setSyncedFor(source.fileName);
    setOptions(current => ({ ...current, title: source.title, logScale: source.logScale }));
  }
  if (!open && syncedFor !== null) setSyncedFor(null);

  const colors = resolveColors(options);

  const chartRows = useMemo(() => {
    if (!source) return [];
    return source.rows.map(row => {
      const point: Record<string, number | undefined> = { x: row[0] ?? undefined };
      for (const series of source.series) {
        const value = row[series.index];
        point[`c${series.index}`] = value === null || !Number.isFinite(value) ? undefined : value;
      }
      return point;
    });
  }, [source]);

  // A log axis cannot draw a value at or below zero. Residual plots are the
  // main reason this control exists, and they are all positive; anything else
  // silently falls back rather than exporting an empty frame.
  const logUsable = useMemo(() => {
    if (!source) return false;
    return source.rows.every(row => source.series.every(series => {
      const value = row[series.index];
      return value === null || !Number.isFinite(value) || value > 0;
    }));
  }, [source]);
  const logScale = options.logScale && logUsable;

  /** The chart, at output size. The preview scales this down; the export takes it as it is. */
  const chart = source && (
    <ComposedChart
      width={options.width}
      height={options.height}
      data={chartRows}
      margin={{
        top: options.showTitle && options.title ? options.fontSize * 3 : options.fontSize,
        right: options.fontSize * 2,
        bottom: options.showAxisLabels ? options.fontSize * 3 : options.fontSize * 1.5,
        left: options.fontSize,
      }}
    >
      {options.showGrid && <CartesianGrid strokeDasharray="4 4" stroke={colors.grid} />}
      <XAxis
        dataKey="x"
        type="number"
        scale="linear"
        domain={['dataMin', 'dataMax']}
        stroke={colors.foreground}
        tick={{ fontSize: options.fontSize, fill: colors.foreground }}
        tickFormatter={formatTick}
        tickCount={8}
        // See the note in post-process.tsx: minTickGap, not tickCount, is what
        // stops a long series printing overlapping labels. Scaled with the font
        // so a bigger export does not crowd again.
        minTickGap={options.fontSize * 3.5}
        label={options.showAxisLabels
          ? { value: source.xLabel, position: 'insideBottom', offset: -options.fontSize * 1.4, fontSize: options.fontSize, fill: colors.foreground }
          : undefined}
      />
      <YAxis
        scale={logScale ? 'log' : 'linear'}
        domain={['auto', 'auto']}
        stroke={colors.foreground}
        tick={{ fontSize: options.fontSize, fill: colors.foreground }}
        tickFormatter={formatTick}
        width={options.fontSize * 5}
        label={options.showAxisLabels
          ? { value: source.yLabel, angle: -90, position: 'insideLeft', fontSize: options.fontSize, fill: colors.foreground }
          : undefined}
      />
      {options.showLegend && (
        <Legend
          verticalAlign="top"
          align="right"
          iconSize={options.fontSize}
          wrapperStyle={{ fontSize: options.fontSize, color: colors.foreground }}
        />
      )}
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
   * The chart as a standalone SVG document.
   *
   * Recharts draws into an `<svg>` that inherits the page's font and, for a
   * transparent export, nothing else. A file has to carry its own: the font
   * stack goes in as a `<style>` rule, and the background as a rect BEHIND
   * everything rather than as a CSS property, because a CSS background is not
   * part of the drawing and would be lost the moment the file is placed in a
   * document.
   */
  const buildSvg = (): string | null => {
    const original = holderRef.current?.querySelector('svg');
    if (!original) return null;
    const clone = original.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    clone.setAttribute('width', String(options.width));
    clone.setAttribute('height', String(options.height));
    clone.setAttribute('viewBox', `0 0 ${options.width} ${options.height}`);

    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `text{font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}`;
    clone.insertBefore(style, clone.firstChild);

    if (colors.background) {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', '0');
      rect.setAttribute('y', '0');
      rect.setAttribute('width', String(options.width));
      rect.setAttribute('height', String(options.height));
      rect.setAttribute('fill', colors.background);
      clone.insertBefore(rect, style.nextSibling);
    }

    if (options.showTitle && options.title.trim()) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', String(options.width / 2));
      text.setAttribute('y', String(options.fontSize * 1.9));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', String(Math.round(options.fontSize * 1.35)));
      text.setAttribute('font-weight', '600');
      text.setAttribute('fill', colors.foreground);
      text.textContent = options.title.trim();
      clone.appendChild(text);
    }

    return new XMLSerializer().serializeToString(clone);
  };

  const download = (blob: Blob, extension: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${source?.fileName || 'chart'}.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoked on the next tick, not immediately: Chromium reads the blob after
    // the click returns, and revoking synchronously cancels the download.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const save = async () => {
    const markup = buildSvg();
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
      const source64 = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
      const image = new window.Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('The chart could not be rasterised'));
        image.src = source64;
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

  // The preview box is fixed; the chart is scaled to fit inside it so that the
  // proportions on screen are the proportions of the file.
  const PREVIEW_WIDTH = 620;
  const PREVIEW_HEIGHT = 420;
  const scale = Math.min(PREVIEW_WIDTH / options.width, PREVIEW_HEIGHT / options.height, 1);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[86vh] sm:max-w-5xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="flex-shrink-0 border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <ImageIcon className="h-4 w-4 text-brand" />
            Save the chart
            <span className="text-[11px] font-normal text-muted-foreground">
              the preview is the file, at {options.width} × {options.height}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-[1fr_290px] overflow-hidden">
          {/* ── Preview ── */}
          <div className="flex min-h-0 items-center justify-center overflow-auto bg-[repeating-conic-gradient(var(--muted)_0%_25%,transparent_0%_50%)] bg-[length:20px_20px] p-4">
            <div
              className="shadow-lg ring-1 ring-border"
              style={{ width: options.width * scale, height: options.height * scale }}
            >
              {/* The chart is rendered at FULL output size and scaled down for
                  display, so the export takes the very node being previewed
                  rather than a second one built to different rules. */}
              <div
                ref={holderRef}
                style={{
                  width: options.width,
                  height: options.height,
                  transform: `scale(${scale})`,
                  transformOrigin: 'top left',
                  background: colors.background ?? 'transparent',
                  position: 'relative',
                }}
              >
                {options.showTitle && options.title.trim() && (
                  <div
                    style={{
                      position: 'absolute',
                      top: options.fontSize * 0.8,
                      width: '100%',
                      textAlign: 'center',
                      fontSize: Math.round(options.fontSize * 1.35),
                      fontWeight: 600,
                      color: colors.foreground,
                      pointerEvents: 'none',
                    }}
                  >
                    {options.title.trim()}
                  </div>
                )}
                {chart}
              </div>
            </div>
          </div>

          {/* ── Options ── */}
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
                        <Input
                          id="ex-bg" type="color" className="mt-0.5 h-7 p-1"
                          value={options.customColor}
                          onChange={event => set('customColor', event.target.value)}
                        />
                      </div>
                      <div>
                        <Label htmlFor="ex-fg" className="text-[10px] text-muted-foreground">axes and text</Label>
                        <Input
                          id="ex-fg" type="color" className="mt-0.5 h-7 p-1"
                          value={options.foreground}
                          onChange={event => set('foreground', event.target.value)}
                        />
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

                <div>
                  <Label htmlFor="ex-title" className="text-[11px]">Title</Label>
                  <Input
                    id="ex-title"
                    className="mt-1 h-7 text-xs"
                    value={options.title}
                    onChange={event => set('title', event.target.value)}
                    placeholder="no title"
                  />
                </div>

                <div className="space-y-1.5">
                  {([
                    ['showTitle', 'Show the title'],
                    ['showGrid', 'Grid lines'],
                    ['showLegend', 'Legend'],
                    ['showAxisLabels', 'Axis labels'],
                  ] as const).map(([key, label]) => (
                    <div key={key} className="flex items-center gap-2">
                      <Checkbox
                        id={`ex-${key}`}
                        checked={options[key]}
                        onCheckedChange={value => set(key, value === true)}
                      />
                      <Label htmlFor={`ex-${key}`} className="cursor-pointer text-[11px]">{label}</Label>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="ex-log"
                      checked={logScale}
                      disabled={!logUsable}
                      onCheckedChange={value => set('logScale', value === true)}
                    />
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
                    <Button
                      size="sm"
                      variant={options.format === 'svg' ? 'default' : 'outline'}
                      className="h-7 text-[10px]"
                      onClick={() => set('format', 'svg')}
                    >
                      SVG
                    </Button>
                    <Button
                      size="sm"
                      variant={options.format === 'png' ? 'default' : 'outline'}
                      className="h-7 text-[10px]"
                      onClick={() => set('format', 'png')}
                    >
                      PNG
                    </Button>
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
                          <Button
                            key={ratio}
                            size="sm"
                            variant={options.pixelRatio === ratio ? 'default' : 'outline'}
                            className="h-7 text-[10px]"
                            onClick={() => set('pixelRatio', ratio)}
                          >
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
              <Button size="sm" className="ml-auto h-8 gap-1.5 text-xs" disabled={!source || busy} onClick={() => void save()}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                Save {options.format.toUpperCase()}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

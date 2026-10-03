'use client';

/**
 * The Video tab of the ParaView workbench: a timeline of views and an export.
 *
 * The user sets up a view in the viewport as usual, then adds it "until" a
 * saved time step; changes the view and adds the next one, as many times as
 * wanted. Each entry keeps the captured view (and a thumbnail of the viewport
 * at that moment), can be shown again in the viewport, replaced with the
 * current view, or removed. The pace and the output are chosen below, with the
 * resulting frame count and duration computed by the same code the server uses
 * (src/lib/paraview-video.ts) before anything is rendered.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle, Camera, Download, Eye, Film, FolderDown, Loader2, Plus, RefreshCw, Trash2, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { confirmDialog } from '@/components/ui/confirm-host';
import type { ParaViewVideoEstimate, ParaViewVideoJob, ParaViewWorkbenchState } from '@/lib/paraview';
import {
  SECONDS_PER_STEP_RANGE, VIDEO_FPS, VIDEO_RESOLUTIONS, VIDEO_SECONDS_PER_SIM_SECOND_RANGE,
  buildVideoPlan, formatVideoDuration, sortedTimes,
  type ParaViewViewSnapshot, type VideoColorRange, type VideoFormat, type VideoRequest, type VideoResolution,
  type VideoTransition,
} from '@/lib/paraview-video';

interface TimelineEntry {
  key: number;
  until: number;
  transition: VideoTransition;
  view: ParaViewViewSnapshot;
  thumbnail: string | null;
}

type SnapshotNode = { label?: string; visible?: boolean; color?: { name?: string } };

async function errorText(response: Response): Promise<string> {
  try {
    const data = await response.json() as { error?: string };
    return data.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

function describeView(view: ParaViewViewSnapshot): string {
  const nodes = (view.nodes && typeof view.nodes === 'object' ? view.nodes : {}) as Record<string, SnapshotNode>;
  const shown = Object.values(nodes).filter(node => node.visible);
  if (!shown.length) return 'Nothing visible';
  return shown.map(node => `${node.label || 'item'}${node.color?.name ? `: ${node.color.name}` : ''}`).join(' · ');
}

function megabytes(bytes: number | null): string {
  return bytes === null ? '' : `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
}

export default function ParaViewVideoPanel({ workbench, imageUrl, locked, onApplyView, onExportingChange, onFinished }: {
  workbench: ParaViewWorkbenchState;
  /** The viewport's current picture, copied as the entry's thumbnail. */
  imageUrl: string;
  /** Another workbench command is in flight. */
  locked: boolean;
  onApplyView: (view: ParaViewViewSnapshot) => Promise<void>;
  onExportingChange: (exporting: boolean) => void;
  /** The export ended: the worker restored the view, so the workbench re-syncs. */
  onFinished: () => void;
}) {
  const times = useMemo(() => sortedTimes(workbench.times), [workbench.times]);
  const formats = workbench.videoFormats ?? [];
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [start, setStart] = useState<number>(times[0] ?? 0);
  const [mode, setMode] = useState<'perStep' | 'realTime'>('perStep');
  const [secondsPerStep, setSecondsPerStep] = useState(0.25);
  const [factor, setFactor] = useState(1);
  const [interpolate, setInterpolate] = useState(false);
  const [fps, setFps] = useState(30);
  const [resolution, setResolution] = useState<VideoResolution>('1080p');
  const [format, setFormat] = useState<VideoFormat>(formats[0] ?? 'mp4');
  const [colorRange, setColorRange] = useState<VideoColorRange>('captured');
  const [capturing, setCapturing] = useState(false);
  /** Rendering a few frames to estimate the export. */
  const [estimating, setEstimating] = useState(false);
  const [renderEstimate, setRenderEstimate] = useState<number | null>(null);
  const [job, setJob] = useState<ParaViewVideoJob | null>(null);
  const [now, setNow] = useState(Date.now());
  const nextKey = useRef(1);
  const thumbnails = useRef(new Set<string>());

  useEffect(() => () => { for (const url of thumbnails.current) URL.revokeObjectURL(url); }, []);
  useEffect(() => { if (formats.length && !formats.includes(format)) setFormat(formats[0]); }, [formats, format]);
  useEffect(() => { if (!times.some(time => time === start) && times.length) setStart(times[0]); }, [times, start]);

  const running = job?.status === 'running';
  const jobRef = useRef<ParaViewVideoJob | null>(null);
  const showJob = useCallback((next: ParaViewVideoJob | null) => {
    jobRef.current = next;
    setJob(next);
  }, []);
  useEffect(() => { onExportingChange(running); }, [running, onExportingChange]);

  // Follow a running export — also one started before this panel was mounted.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const response = await fetch('/api/paraview?action=video_status', { cache: 'no-store' });
        if (!response.ok) throw new Error(await errorText(response));
        const data = await response.json() as { job: ParaViewVideoJob | null };
        if (cancelled) return;
        const next = data.job && data.job.caseName === workbench.caseName ? data.job : null;
        const previous = jobRef.current;
        if (previous?.status === 'running' && next && next.status !== 'running') {
          if (next.status === 'done') toast.success(`Video ready: ${next.fileName}`);
          else if (next.status === 'failed') toast.error(next.error || 'The video export failed.');
          else toast.info('Video export cancelled.');
          onFinished();
        }
        showJob(next);
        setNow(Date.now());
        if (next?.status === 'running') timer = setTimeout(() => void poll(), 500);
      } catch {
        if (!cancelled) timer = setTimeout(() => void poll(), 2_000);
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [running, workbench.caseName, onFinished, showJob]);

  const captureView = useCallback(async (): Promise<{ view: ParaViewViewSnapshot; thumbnail: string | null } | null> => {
    setCapturing(true);
    try {
      const response = await fetch('/api/paraview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'command', command: 'capture_view', data: {} }),
      });
      if (!response.ok) throw new Error(await errorText(response));
      const data = await response.json() as { view?: ParaViewViewSnapshot };
      if (!data.view) throw new Error('ParaView did not return the view.');
      let thumbnail: string | null = null;
      if (imageUrl) {
        try {
          thumbnail = URL.createObjectURL(await (await fetch(imageUrl)).blob());
          thumbnails.current.add(thumbnail);
        } catch { /* a missing thumbnail is not a reason to lose the view */ }
      }
      return { view: data.view, thumbnail };
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not capture the view.');
      return null;
    } finally {
      setCapturing(false);
    }
  }, [imageUrl]);

  const releaseThumbnail = (url: string | null) => {
    if (!url) return;
    URL.revokeObjectURL(url);
    thumbnails.current.delete(url);
  };

  const lastUntil = entries.length ? entries[entries.length - 1].until : start;
  const canAdd = times.some(time => time > lastUntil);

  const addView = async () => {
    const captured = await captureView();
    if (!captured) return;
    // "This view until the step on screen", when that is still ahead;
    // otherwise to the end of the results.
    const later = times.filter(time => time > lastUntil);
    const until = later.includes(workbench.time) ? workbench.time : later[later.length - 1];
    if (until === undefined) return;
    setEntries(current => [...current, {
      key: nextKey.current++, until, transition: 'cut', view: captured.view, thumbnail: captured.thumbnail,
    }]);
  };

  const replaceView = async (key: number) => {
    const captured = await captureView();
    if (!captured) return;
    setEntries(current => current.map(entry => {
      if (entry.key !== key) return entry;
      releaseThumbnail(entry.thumbnail);
      return { ...entry, view: captured.view, thumbnail: captured.thumbnail };
    }));
  };

  const removeView = (key: number) => {
    setEntries(current => current.filter(entry => {
      if (entry.key === key) releaseThumbnail(entry.thumbnail);
      return entry.key !== key;
    }));
  };

  const update = (key: number, changes: Partial<TimelineEntry>) => {
    setEntries(current => current.map(entry => (entry.key === key ? { ...entry, ...changes } : entry)));
  };

  const request: VideoRequest = {
    start,
    segments: entries.map(entry => ({ until: entry.until, transition: entry.transition, view: entry.view })),
    timing: mode === 'perStep' ? { mode, secondsPerStep } : { mode, videoSecondsPerSimSecond: factor },
    interpolate,
    fps,
    resolution,
    format,
    colorRange,
  };
  let estimate: { frames: number; seconds: number } | null = null;
  let estimateError = '';
  try {
    const plan = buildVideoPlan(times, request);
    estimate = { frames: plan.frames.length, seconds: plan.seconds };
  } catch (cause) {
    estimateError = cause instanceof Error ? cause.message : String(cause);
  }

  const pipelineIds = new Set(workbench.pipeline.map(node => node.id));
  const stale = (view: ParaViewViewSnapshot) => Object.keys((view.nodes || {}) as object).some(id => !pipelineIds.has(id));

  const exportVideo = async () => {
    setEstimating(true);
    try {
      // A few frames are rendered first: long or slow exports are confirmed
      // with the measured time instead of being refused.
      const measured = await fetch('/api/paraview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'video_estimate', request }),
      });
      if (!measured.ok) throw new Error(await errorText(measured));
      const { estimate } = await measured.json() as { estimate: ParaViewVideoEstimate };
      setRenderEstimate(estimate.renderSeconds);
      setEstimating(false);
      if (estimate.confirm && !(await confirmDialog(estimate.confirm, { title: 'Long video export', confirmLabel: 'Export' }))) return;
      const response = await fetch('/api/paraview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'video_export', request }),
      });
      if (!response.ok) throw new Error(await errorText(response));
      const data = await response.json() as { job: ParaViewVideoJob };
      showJob(data.job);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'The video export could not start.');
    } finally {
      setEstimating(false);
    }
  };

  const cancelExport = async () => {
    await fetch('/api/paraview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'video_cancel' }),
    }).catch(() => undefined);
  };

  const saveInCase = async () => {
    try {
      const response = await fetch('/api/paraview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'video_save_case' }),
      });
      if (!response.ok) throw new Error(await errorText(response));
      const data = await response.json() as { job: ParaViewVideoJob };
      showJob(data.job);
      toast.success(`Saved in the case: ${data.job.savedInCase}`);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'The video could not be saved in the case.');
    }
  };

  if (!workbench.reader.hasTimeSteps || times.length < 2) {
    return (
      <div className="space-y-2 p-3 text-xs">
        <p className="flex items-center gap-1.5 font-semibold"><Film className="h-3.5 w-3.5" /> Video</p>
        <p className="text-muted-foreground">A video needs at least two saved time steps. Run the solver (or Refresh after it has written results) first.</p>
      </div>
    );
  }
  if (!formats.length) {
    return (
      <div className="space-y-2 p-3 text-xs">
        <p className="flex items-center gap-1.5 font-semibold"><Film className="h-3.5 w-3.5" /> Video</p>
        <p className="text-muted-foreground">This ParaView {workbench.version} build has no movie writer (MP4 or OGV), so videos cannot be exported from it.</p>
      </div>
    );
  }

  const disabled = running || locked || capturing || estimating;
  const progress = job && job.total ? Math.min(100, Math.round((job.frame / job.total) * 100)) : 0;
  const elapsed = job ? Math.max(0, ((job.finishedAt ?? now) - job.startedAt) / 1000) : 0;
  // Remaining time from the export's own pace once frames are coming, from the
  // measurement before that.
  const remaining = job && running
    ? job.frame > 0 ? (elapsed / job.frame) * (job.total - job.frame) : renderEstimate
    : null;

  return (
    <div className="space-y-4 p-3 text-xs">
      <div>
        <p className="flex items-center gap-1.5 font-semibold"><Film className="h-3.5 w-3.5" /> Video timeline</p>
        <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
          Set up the view in the viewport, then add it until a time step. Change the view and add the next one as many times as you like.
        </p>
      </div>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-[10px]">Start at</Label>
          <Select value={String(start)} onValueChange={value => setStart(Number(value))} disabled={disabled}>
            <SelectTrigger size="sm" className="h-7 flex-1 font-mono text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{times.filter(time => entries.length === 0 || time < entries[0].until).map(time => <SelectItem key={time} value={String(time)} className="font-mono text-xs">{time}</SelectItem>)}</SelectContent>
          </Select>
        </div>

        {entries.map((entry, index) => {
          const from = index === 0 ? start : entries[index - 1].until;
          const nextUntil = entries[index + 1]?.until;
          const choices = times.filter(time => time > from && (nextUntil === undefined || time < nextUntil));
          return (
            <div key={entry.key} className="rounded-md border bg-background/60 p-2">
              <div className="flex gap-2">
                <div className="h-12 w-20 flex-shrink-0 overflow-hidden rounded bg-[#252931]">
                  {entry.thumbnail
                    ? <img src={entry.thumbnail} alt={`View ${index + 1}`} className="h-full w-full object-cover" />
                    : <Camera className="m-auto mt-3.5 h-5 w-5 text-white/40" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">View {index + 1}</Badge>
                    <span className="truncate text-[10px] text-muted-foreground" title={describeView(entry.view)}>{describeView(entry.view)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1">
                    <span className="font-mono text-[10px] text-muted-foreground">{from} →</span>
                    <Select value={String(entry.until)} onValueChange={value => update(entry.key, { until: Number(value) })} disabled={disabled}>
                      <SelectTrigger size="sm" className="h-6 flex-1 font-mono text-[10px]" aria-label={`View ${index + 1} lasts until`}><SelectValue /></SelectTrigger>
                      <SelectContent>{choices.map(time => <SelectItem key={time} value={String(time)} className="font-mono text-xs">{time}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
              {stale(entry.view) && (
                <p className="mt-1.5 flex items-start gap-1 text-[10px] text-amber-600"><AlertTriangle className="mt-px h-3 w-3 flex-shrink-0" /> Some pipeline items in this view no longer exist; they are ignored.</p>
              )}
              <div className="mt-1.5 flex items-center gap-1">
                {index > 0 && (
                  <Select value={entry.transition} onValueChange={value => update(entry.key, { transition: value as VideoTransition })} disabled={disabled}>
                    <SelectTrigger size="sm" className="h-6 w-[118px] text-[10px]" aria-label={`Transition into view ${index + 1}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cut" className="text-xs">Cut</SelectItem>
                      <SelectItem value="smooth" className="text-xs">Smooth camera</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                <div className="ml-auto flex gap-0.5">
                  <Button size="icon" variant="ghost" className="h-6 w-6" disabled={disabled} onClick={() => void onApplyView(entry.view)} title="Show this view in the viewport" aria-label={`Show view ${index + 1}`}><Eye className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-6 w-6" disabled={disabled} onClick={() => void replaceView(entry.key)} title="Replace with the current view" aria-label={`Replace view ${index + 1} with the current view`}><RefreshCw className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-6 w-6 text-red-500" disabled={disabled} onClick={() => removeView(entry.key)} title="Remove this view" aria-label={`Remove view ${index + 1}`}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
            </div>
          );
        })}

        <Button size="sm" variant="outline" className="h-8 w-full text-xs" disabled={disabled || !canAdd} onClick={() => void addView()}>
          {capturing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          {entries.length ? 'Add the current view' : 'Use the current view'}
          {canAdd && <span className="font-mono text-[10px] text-muted-foreground">until {times.filter(time => time > lastUntil).includes(workbench.time) ? workbench.time : times[times.length - 1]}</span>}
        </Button>
        {!canAdd && entries.length > 0 && <p className="text-[10px] text-muted-foreground">The timeline already reaches the last saved time step.</p>}
      </section>

      <section className="space-y-2 border-t pt-3">
        <p className="font-semibold">Speed</p>
        <label className="flex cursor-pointer items-start gap-2">
          <input type="radio" name="pv-video-pace" className="mt-0.5 accent-primary" checked={mode === 'perStep'} disabled={disabled} onChange={() => setMode('perStep')} />
          <span className="min-w-0 flex-1">
            <span className="block">Each saved time step lasts</span>
            <span className="mt-1 flex items-center gap-1">
              <Input type="number" min={SECONDS_PER_STEP_RANGE[0]} max={SECONDS_PER_STEP_RANGE[1]} step="0.05" className="h-6 w-20 font-mono text-xs" value={secondsPerStep} disabled={disabled || mode !== 'perStep'} onChange={event => setSecondsPerStep(Number(event.target.value))} />
              <span className="text-[10px] text-muted-foreground">s of video (slow motion, any spacing)</span>
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2">
          <input type="radio" name="pv-video-pace" className="mt-0.5 accent-primary" checked={mode === 'realTime'} disabled={disabled} onChange={() => setMode('realTime')} />
          <span className="min-w-0 flex-1">
            <span className="block">Follow simulation time: 1 simulated second =</span>
            <span className="mt-1 flex items-center gap-1">
              <Input type="number" min={VIDEO_SECONDS_PER_SIM_SECOND_RANGE[0]} max={VIDEO_SECONDS_PER_SIM_SECOND_RANGE[1]} step="any" className="h-6 w-20 font-mono text-xs" value={factor} disabled={disabled || mode !== 'realTime'} onChange={event => setFactor(Number(event.target.value))} />
              <span className="text-[10px] text-muted-foreground">s of video (1 real time, more is slower)</span>
            </span>
          </span>
        </label>
        <div className="flex items-start gap-2 pt-1">
          <Checkbox id="pv-video-interpolate" checked={interpolate} disabled={disabled} onCheckedChange={value => setInterpolate(value === true)} className="mt-0.5" />
          <Label htmlFor="pv-video-interpolate" className="block text-xs font-normal leading-snug">
            Smooth between saved steps
            <span className="block text-[10px] text-muted-foreground">Fields in between are interpolated in time: fluid, but an estimate. Off, each frame shows the last saved step.</span>
          </Label>
        </div>
      </section>

      <section className="space-y-2 border-t pt-3">
        <p className="font-semibold">Output</p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-[10px]">Resolution</Label>
            <Select value={resolution} onValueChange={value => setResolution(value as VideoResolution)} disabled={disabled}>
              <SelectTrigger size="sm" className="mt-1 h-7 w-full text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(VIDEO_RESOLUTIONS) as VideoResolution[]).map(key => <SelectItem key={key} value={key} className="text-xs">{VIDEO_RESOLUTIONS[key].label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[10px]">Frames per second</Label>
            <Select value={String(fps)} onValueChange={value => setFps(Number(value))} disabled={disabled}>
              <SelectTrigger size="sm" className="mt-1 h-7 w-full text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{VIDEO_FPS.map(value => <SelectItem key={value} value={String(value)} className="text-xs">{value}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[10px]">Format</Label>
            <Select value={format} onValueChange={value => setFormat(value as VideoFormat)} disabled={disabled}>
              <SelectTrigger size="sm" className="mt-1 h-7 w-full text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{formats.map(value => <SelectItem key={value} value={value} className="text-xs">{value === 'mp4' ? 'MP4 (H.264)' : 'OGV (Theora)'}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[10px]">Colour range</Label>
            <Select value={colorRange} onValueChange={value => setColorRange(value as VideoColorRange)} disabled={disabled}>
              <SelectTrigger size="sm" className="mt-1 h-7 w-full text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="captured" className="text-xs">Fixed, as in each view</SelectItem>
                <SelectItem value="perFrame" className="text-xs">Rescale every frame</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="rounded-md border bg-muted/30 px-2 py-1.5 text-[10px]">
          {estimate
            ? <span><span className="font-medium text-foreground">{formatVideoDuration(estimate.seconds)}</span> · {estimate.frames.toLocaleString()} frames</span>
            : <span className="text-muted-foreground">{estimateError}</span>}
        </div>

        {running ? (
          <div className="space-y-1.5 rounded-md border border-primary/40 bg-primary/5 p-2">
            <div className="flex items-center justify-between text-[10px]">
              <span className="flex items-center gap-1 font-medium"><Loader2 className="h-3 w-3 animate-spin" /> Frame {job.frame.toLocaleString()} of {job.total.toLocaleString()}</span>
              <span className="font-mono text-muted-foreground">{formatVideoDuration(elapsed)}</span>
            </div>
            {remaining !== null && <p className="text-[10px] text-muted-foreground">About {formatVideoDuration(remaining)} left</p>}
            <div className="h-1.5 overflow-hidden rounded bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} /></div>
            <Button size="sm" variant="outline" className="h-7 w-full text-xs" onClick={() => void cancelExport()}><X className="h-3.5 w-3.5" /> Cancel export</Button>
          </div>
        ) : (
          <Button size="sm" className="h-8 w-full text-xs" disabled={disabled || !estimate} onClick={() => void exportVideo()}>
            {estimating
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Measuring a few frames…</>
              : <><Film className="h-3.5 w-3.5" /> Export video</>}
          </Button>
        )}

        {job?.status === 'done' && (
          <div className="space-y-1.5 rounded-md border border-emerald-400/50 bg-emerald-50 p-2 dark:bg-emerald-950/20">
            <p className="break-all text-[10px]"><span className="font-medium">{job.fileName}</span> · {megabytes(job.bytes)} · {formatVideoDuration(job.seconds)}</p>
            <div className="flex gap-1">
              <Button asChild size="sm" variant="outline" className="h-7 flex-1 text-[11px]">
                <a href="/api/paraview?action=video_download" download={job.fileName}><Download className="h-3.5 w-3.5" /> Save as…</a>
              </Button>
              <Button size="sm" variant="outline" className="h-7 flex-1 text-[11px]" onClick={() => void saveInCase()} title="Copy into postProcessing/videos in the case">
                <FolderDown className="h-3.5 w-3.5" /> Save in case
              </Button>
            </div>
            {job.savedInCase && <p className="break-all font-mono text-[9px] text-muted-foreground">{job.savedInCase}</p>}
            <p className="text-[9px] text-muted-foreground">Kept until the next export or until ParaView stops.</p>
          </div>
        )}
        {job?.status === 'failed' && <p className="flex items-start gap-1 text-[10px] text-red-600"><AlertTriangle className="mt-px h-3 w-3 flex-shrink-0" /> {job.error}</p>}
      </section>
    </div>
  );
}

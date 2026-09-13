/**
 * Video export from the ParaView workbench: which frame shows which simulation
 * time, through which view.
 *
 * The user builds a timeline of views: "this view up to time A, then this one
 * up to time B…". Each view is a snapshot the worker captured (camera, what is
 * visible, how it is coloured). The video's pace is one of two things:
 *
 *   perStep    every saved time step lasts the same number of seconds, so the
 *              video is a slow-motion walk through the results whatever their
 *              spacing (and the only meaningful pace for steady runs, whose
 *              "time" is an iteration count);
 *   realTime   the video follows simulation time, scaled: one simulated second
 *              lasts N seconds of video (N = 1 real time, N > 1 slow motion).
 *
 * Between two saved steps a frame either holds the last saved step (what was
 * computed, nothing more) or asks ParaView for fields interpolated in time
 * (smooth, but an estimate).
 *
 * This module is pure — the API validates requests with it and the workbench
 * shows the same estimate before anything is rendered. The worker only renders
 * the frames it is handed.
 */

export type VideoFormat = 'mp4' | 'ogv';
export type VideoResolution = '480p' | '720p' | '1080p' | '2160p';
export type VideoTransition = 'cut' | 'smooth';
export type VideoColorRange = 'captured' | 'perFrame';

export type VideoTiming =
  | { mode: 'perStep'; secondsPerStep: number }
  | { mode: 'realTime'; videoSecondsPerSimSecond: number };

/** A view as the worker captured it. Opaque here; the worker validates it again. */
export type ParaViewViewSnapshot = Record<string, unknown>;

export interface VideoSegment {
  /** Simulation time this view lasts until (a saved time step). */
  until: number;
  /** How the camera reaches this view from the previous one. */
  transition: VideoTransition;
  view: ParaViewViewSnapshot;
}

export interface VideoRequest {
  /** First simulation time in the video (a saved time step). */
  start: number;
  segments: VideoSegment[];
  timing: VideoTiming;
  interpolate: boolean;
  fps: number;
  resolution: VideoResolution;
  format: VideoFormat;
  colorRange: VideoColorRange;
}

/** One frame: the simulation time shown, the segment's view, and how far a smooth camera move has got (1 = there). */
export interface VideoFrame {
  time: number;
  segment: number;
  blend: number;
}

export interface VideoPlan {
  frames: VideoFrame[];
  /** Video duration in seconds. */
  seconds: number;
  /** Whether frames between saved steps are interpolated. */
  interpolate: boolean;
  /** Saved time steps the video reads. */
  steps: number;
  width: number;
  height: number;
}

export const VIDEO_FPS = [12, 24, 25, 30, 60] as const;
export const VIDEO_RESOLUTIONS: Record<VideoResolution, { width: number; height: number; label: string }> = {
  '480p': { width: 854, height: 480, label: '854 × 480' },
  '720p': { width: 1280, height: 720, label: '1280 × 720 (HD)' },
  '1080p': { width: 1920, height: 1080, label: '1920 × 1080 (Full HD)' },
  '2160p': { width: 3840, height: 2160, label: '3840 × 2160 (4K)' },
};
/**
 * The hard ceiling: an hour of video. It is only there against an obvious
 * mistake (a factor of 1000 instead of 1 asks for hundreds of thousands of
 * frames); long but intended exports are confirmed instead
 * (videoConfirmation), with a render time measured on the case itself.
 */
export const MAX_VIDEO_SECONDS = 3_600;
/** The most frames any request can carry: an hour at the highest frame rate. */
export const MAX_VIDEO_FRAMES = MAX_VIDEO_SECONDS * 60 + 1;
/** Above these the workbench asks before exporting. */
export const CONFIRM_VIDEO_SECONDS = 600;
export const CONFIRM_RENDER_SECONDS = 1_800;
export const MAX_VIDEO_SEGMENTS = 30;
export const SECONDS_PER_STEP_RANGE = [0.02, 10] as const;
export const VIDEO_SECONDS_PER_SIM_SECOND_RANGE = [1e-6, 1e6] as const;
/** A smooth camera move takes this long, or the whole segment if it is shorter. */
export const SMOOTH_TRANSITION_SECONDS = 1;

/** Saved times, sorted and de-duplicated. */
export function sortedTimes(times: number[]): number[] {
  return [...new Set(times.filter(Number.isFinite))].sort((a, b) => a - b);
}

function tolerance(times: number[]): number {
  const span = times.length > 1 ? times[times.length - 1] - times[0] : Math.abs(times[0] ?? 1);
  return Math.max(Math.abs(span), 1) * 1e-9;
}

/** The saved time equal to `value`, or null when there is none. */
function savedTime(times: number[], value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const tol = tolerance(times);
  return times.find(time => Math.abs(time - value) <= tol) ?? null;
}

/** The last saved time at or before `value`. */
function heldTime(times: number[], value: number): number {
  const tol = tolerance(times);
  let held = times[0];
  for (const time of times) {
    if (time <= value + tol) held = time;
    else break;
  }
  return held;
}

function describeRange([lo, hi]: readonly [number, number]): string {
  return `${lo} to ${hi}`;
}

/**
 * The frames of a video, or an error in words the user can act on.
 * Throws on anything the workbench should not have allowed.
 */
export function buildVideoPlan(rawTimes: number[], request: VideoRequest): VideoPlan {
  const times = sortedTimes(rawTimes);
  if (times.length < 2) throw new Error('The case needs at least two saved time steps to make a video.');

  if (!VIDEO_FPS.includes(request.fps as typeof VIDEO_FPS[number])) {
    throw new Error(`Frame rate must be one of ${VIDEO_FPS.join(', ')}.`);
  }
  const size = VIDEO_RESOLUTIONS[request.resolution];
  if (!size) throw new Error('Unsupported video resolution.');
  if (request.format !== 'mp4' && request.format !== 'ogv') throw new Error('Unsupported video format.');
  if (request.colorRange !== 'captured' && request.colorRange !== 'perFrame') throw new Error('Unsupported colour-range mode.');

  const start = savedTime(times, request.start);
  if (start === null) throw new Error('The video must start at a saved time step.');
  const segments = Array.isArray(request.segments) ? request.segments : [];
  if (segments.length === 0) throw new Error('Add at least one view to the timeline.');
  if (segments.length > MAX_VIDEO_SEGMENTS) throw new Error(`A video can have at most ${MAX_VIDEO_SEGMENTS} views.`);

  const untils: number[] = [];
  segments.forEach((segment, index) => {
    const until = savedTime(times, segment.until);
    if (until === null) throw new Error(`View ${index + 1} must end at a saved time step.`);
    const previous = index === 0 ? start : untils[index - 1];
    if (until <= previous) {
      throw new Error(index === 0
        ? `View 1 must end after the start time (${start}).`
        : `View ${index + 1} must end after view ${index} (${previous}).`);
    }
    if (segment.transition !== 'cut' && segment.transition !== 'smooth') throw new Error(`View ${index + 1} has an unknown transition.`);
    if (!segment.view || typeof segment.view !== 'object' || Array.isArray(segment.view)) throw new Error(`View ${index + 1} has no captured view.`);
    untils.push(until);
  });
  const end = untils[untils.length - 1];
  const stepTimes = times.filter(time => time >= start && time <= end);
  const fps = request.fps;

  const limit = Math.round(MAX_VIDEO_SECONDS * fps) + 1;
  const frameTimes: number[] = [];
  const push = (time: number) => {
    if (frameTimes.length >= limit) return;
    frameTimes.push(time);
  };
  const timing = request.timing;
  let expected: number;
  if (timing?.mode === 'perStep') {
    const [lo, hi] = SECONDS_PER_STEP_RANGE;
    if (!(timing.secondsPerStep >= lo && timing.secondsPerStep <= hi)) {
      throw new Error(`Seconds per time step must be between ${describeRange(SECONDS_PER_STEP_RANGE)}.`);
    }
    const perStep = Math.max(1, Math.round(timing.secondsPerStep * fps));
    expected = perStep * stepTimes.length;
    if (expected <= limit) {
      for (let i = 0; i < stepTimes.length; i += 1) {
        const from = stepTimes[i];
        const to = stepTimes[i + 1];
        for (let k = 0; k < perStep; k += 1) {
          // The last step has nothing to move towards: it is held.
          push(request.interpolate && to !== undefined ? from + (to - from) * (k / perStep) : from);
        }
      }
    }
  } else if (timing?.mode === 'realTime') {
    const [lo, hi] = VIDEO_SECONDS_PER_SIM_SECOND_RANGE;
    const factor = timing.videoSecondsPerSimSecond;
    if (!(factor >= lo && factor <= hi)) {
      throw new Error(`Video seconds per simulated second must be between ${describeRange(VIDEO_SECONDS_PER_SIM_SECOND_RANGE)}.`);
    }
    const duration = (end - start) * factor;
    expected = Math.max(2, Math.round(duration * fps) + 1);
    if (expected <= limit) {
      for (let j = 0; j < expected; j += 1) {
        const time = j === expected - 1 ? end : start + (end - start) * (j / (expected - 1));
        push(request.interpolate ? time : heldTime(times, time));
      }
    }
  } else {
    throw new Error('Choose how fast the video runs.');
  }
  if (expected > limit) {
    throw new Error(`This video would last ${formatVideoDuration(expected / fps)} (${expected.toLocaleString('en-US')} frames); the limit is one hour of video. Make it faster or shorten the timeline.`);
  }

  // Each frame belongs to the first view whose end it has not passed.
  const tol = tolerance(times);
  const frames: VideoFrame[] = frameTimes.map(time => ({
    time,
    segment: Math.max(0, untils.findIndex(until => time <= until + tol)),
    blend: 1,
  }));

  // A smooth transition moves the camera over the first second of its view.
  const transitionFrames = Math.max(1, Math.round(SMOOTH_TRANSITION_SECONDS * fps));
  for (let s = 1; s < segments.length; s += 1) {
    if (segments[s].transition !== 'smooth') continue;
    const indices = frames.flatMap((frame, index) => (frame.segment === s ? [index] : []));
    const count = Math.min(transitionFrames, indices.length);
    for (let k = 0; k < count; k += 1) frames[indices[k]].blend = (k + 1) / count;
  }

  // Held frames read only the steps they show; interpolation reads every step in range.
  const steps = request.interpolate ? stepTimes.length : new Set(frames.map(frame => frame.time)).size;
  return { frames, seconds: frames.length / fps, interpolate: request.interpolate, steps, width: size.width, height: size.height };
}

/** "2 min 05 s" or "8.4 s". */
export function formatVideoDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours} h ${String(minutes).padStart(2, '0')} min` : `${minutes} min ${rest} s`;
}

/** A download name the browser and Windows both accept. */
export function videoFileName(caseName: string, format: VideoFormat, date = new Date()): string {
  const safe = caseName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'case';
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${safe}-paraview-${stamp}.${format}`;
}

/**
 * Frames worth rendering to measure how long the export will take, in threes
 * spread over the video: a frame far from the last one (it has to read saved
 * steps from the case), the same frame again (render and encode only), and the
 * frame that follows it in the video (a new time within data already read —
 * interpolation, or nothing new when steps are held).
 *
 * Timing each frame whole and estimating per frame over-counted badly: in the
 * export a saved step is read once and every frame between it and the next
 * reuses it, which is what the three costs separate.
 */
export function benchmarkFrames(plan: VideoPlan, samples = 3): VideoFrame[] {
  const count = plan.frames.length;
  if (count === 0) return [];
  const indices = [...new Set(Array.from({ length: samples }, (_, k) => Math.round(((count - 1) * (k + 1)) / (samples + 1))))];
  return indices.flatMap(index => [plan.frames[index], plan.frames[index], plan.frames[Math.min(index + 1, count - 1)]]);
}

/** Frames of the plan that show a time not shown by the frame before. */
export function newTimeFrames(plan: VideoPlan): number {
  return plan.frames.filter((frame, index) => index === 0 || frame.time !== plan.frames[index - 1].time).length;
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * The whole export's render time from the benchmark's per-frame durations
 * (in the order benchmarkFrames gave the frames): every frame renders and
 * encodes, every change of time pays the step on top, every saved step read
 * pays its reading once. Null when the durations are not usable.
 */
export function estimateRenderSeconds(plan: VideoPlan, durations: number[]): number | null {
  const triples: [number, number, number][] = [];
  for (let i = 0; i + 2 < durations.length; i += 3) triples.push([durations[i], durations[i + 1], durations[i + 2]]);
  if (!triples.length || !triples.flat().every(value => Number.isFinite(value) && value >= 0)) return null;
  // The first frame also pays one-off costs (applying the view, setting up
  // interpolation): left out when there are other samples.
  const used = triples.length > 1 ? triples.slice(1) : triples;
  const frame = mean(used.map(([, repeat]) => repeat));
  const step = Math.max(0, mean(used.map(([, repeat, next]) => next - repeat)));
  // A far jump reads both steps around an interpolated time, one otherwise.
  const read = Math.max(0, mean(used.map(([far, repeat]) => far - repeat)) / (plan.interpolate ? 2 : 1));
  return plan.frames.length * frame + newTimeFrames(plan) * step + plan.steps * read;
}

/** Whether to ask before exporting, and what to say. */
export function videoConfirmation(seconds: number, frames: number, renderSeconds: number | null): string | null {
  const long = seconds > CONFIRM_VIDEO_SECONDS;
  const slow = renderSeconds !== null && renderSeconds > CONFIRM_RENDER_SECONDS;
  if (!long && !slow) return null;
  const render = renderSeconds === null
    ? 'The render time could not be measured.'
    : `Rendering should take about ${formatVideoDuration(renderSeconds)} (measured on a few frames of this case).`;
  return `This video lasts ${formatVideoDuration(seconds)} (${frames.toLocaleString('en-US')} frames). ${render} The ParaView workbench stays locked while it renders; the export can be cancelled at any time.`;
}

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
export const MAX_VIDEO_FRAMES = 18_000;
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
  const steps = times.filter(time => time >= start && time <= end);
  const fps = request.fps;

  const frameTimes: number[] = [];
  const push = (time: number) => {
    if (frameTimes.length >= MAX_VIDEO_FRAMES) return;
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
    expected = perStep * steps.length;
    if (expected <= MAX_VIDEO_FRAMES) {
      for (let i = 0; i < steps.length; i += 1) {
        const from = steps[i];
        const to = steps[i + 1];
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
    if (expected <= MAX_VIDEO_FRAMES) {
      for (let j = 0; j < expected; j += 1) {
        const time = j === expected - 1 ? end : start + (end - start) * (j / (expected - 1));
        push(request.interpolate ? time : heldTime(times, time));
      }
    }
  } else {
    throw new Error('Choose how fast the video runs.');
  }
  if (expected > MAX_VIDEO_FRAMES) {
    throw new Error(`This video would need ${expected.toLocaleString('en-US')} frames; the limit is ${MAX_VIDEO_FRAMES.toLocaleString('en-US')}. Lower the frame rate or make the video faster.`);
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

  return { frames, seconds: frames.length / fps, width: size.width, height: size.height };
}

/** "2 min 05 s" or "8.4 s". */
export function formatVideoDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${String(Math.round(seconds - minutes * 60)).padStart(2, '0')} s`;
}

/** A download name the browser and Windows both accept. */
export function videoFileName(caseName: string, format: VideoFormat, date = new Date()): string {
  const safe = caseName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'case';
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${safe}-paraview-${stamp}.${format}`;
}

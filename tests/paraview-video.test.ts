/**
 * Video export from the ParaView workbench: which frame shows which time,
 * through which view, and at what pace.
 *
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VIDEO_FRAMES,
  buildVideoPlan,
  formatVideoDuration,
  videoFileName,
  type VideoRequest,
} from '../src/lib/paraview-video.ts';

// Saved every 0.5 s up to 2 s, then a late write at 5 s (irregular spacing).
const TIMES = [0.5, 1, 1.5, 2, 5];
const VIEW = { camera: {}, nodes: {} };

const request = (over: Partial<VideoRequest> = {}): VideoRequest => ({
  start: 0.5,
  segments: [{ until: 5, transition: 'cut', view: VIEW }],
  timing: { mode: 'perStep', secondsPerStep: 0.5 },
  interpolate: false,
  fps: 24,
  resolution: '720p',
  format: 'mp4',
  colorRange: 'captured',
  ...over,
});

describe('pace: one duration per saved time step', () => {
  test('every step lasts the same, whatever the spacing between them', () => {
    const plan = buildVideoPlan(TIMES, request());
    assert.equal(plan.frames.length, 12 * TIMES.length);
    assert.equal(plan.seconds, 2.5);
    assert.deepEqual([plan.width, plan.height], [1280, 720]);
    // Held: only saved times appear.
    assert.ok(plan.frames.every(frame => TIMES.includes(frame.time)));
    assert.equal(plan.frames.filter(frame => frame.time === 2).length, 12);
  });

  test('interpolation moves between steps and holds the last one', () => {
    const plan = buildVideoPlan(TIMES, request({ interpolate: true, timing: { mode: 'perStep', secondsPerStep: 0.25 } }));
    const times = plan.frames.map(frame => frame.time);
    assert.deepEqual(times.slice(0, 6), [0.5, 0.5 + 0.5 / 6, 0.5 + 1 / 6, 0.75, 0.5 + 2 / 6, 0.5 + 2.5 / 6]);
    assert.deepEqual(times.slice(-6), [5, 5, 5, 5, 5, 5]);
    assert.ok(times.every((time, i) => i === 0 || time >= times[i - 1]));
  });
});

describe('pace: following simulation time', () => {
  test('one simulated second lasts N video seconds', () => {
    const plan = buildVideoPlan(TIMES, request({ timing: { mode: 'realTime', videoSecondsPerSimSecond: 2 } }));
    // 4.5 simulated seconds × 2 × 24 fps, plus the closing frame.
    assert.equal(plan.frames.length, 217);
    assert.equal(plan.frames[0].time, 0.5);
    assert.equal(plan.frames.at(-1)!.time, 5);
  });

  test('without interpolation a frame shows the last saved step, so the gap before 5 s is a long hold', () => {
    const plan = buildVideoPlan(TIMES, request({ timing: { mode: 'realTime', videoSecondsPerSimSecond: 1 } }));
    assert.ok(plan.frames.every(frame => TIMES.includes(frame.time)));
    const held = plan.frames.filter(frame => frame.time === 2).length;
    assert.ok(held >= 70 && held <= 73, `2 s is on screen for about 3 s (${held} frames)`);
  });

  test('with interpolation the time advances evenly', () => {
    const plan = buildVideoPlan(TIMES, request({ interpolate: true, timing: { mode: 'realTime', videoSecondsPerSimSecond: 1 } }));
    const step = plan.frames[1].time - plan.frames[0].time;
    assert.ok(Math.abs(step - 1 / 24) < 1e-9);
  });
});

describe('the timeline of views', () => {
  const two = (transition: 'cut' | 'smooth') => request({
    segments: [
      { until: 1.5, transition: 'cut', view: VIEW },
      { until: 5, transition, view: VIEW },
    ],
    interpolate: true,
  });

  test('a frame belongs to the first view whose end it has not passed', () => {
    const plan = buildVideoPlan(TIMES, two('cut'));
    for (const frame of plan.frames) assert.equal(frame.segment, frame.time <= 1.5 ? 0 : 1);
    assert.ok(plan.frames.every(frame => frame.blend === 1));
  });

  test('a smooth transition moves the camera over the first second of the view', () => {
    const plan = buildVideoPlan(TIMES, two('smooth'));
    const second = plan.frames.filter(frame => frame.segment === 1);
    assert.deepEqual(second.slice(0, 3).map(frame => frame.blend), [1 / 24, 2 / 24, 3 / 24]);
    assert.equal(second[23].blend, 1);
    assert.ok(second.slice(24).every(frame => frame.blend === 1));
  });

  test('views must end at saved steps, in order, after the start', () => {
    assert.throws(() => buildVideoPlan(TIMES, request({ segments: [{ until: 1.2, transition: 'cut', view: VIEW }] })), /saved time step/);
    assert.throws(() => buildVideoPlan(TIMES, request({ start: 2, segments: [{ until: 1, transition: 'cut', view: VIEW }] })), /after the start/);
    assert.throws(() => buildVideoPlan(TIMES, request({
      segments: [{ until: 2, transition: 'cut', view: VIEW }, { until: 2, transition: 'cut', view: VIEW }],
    })), /View 2 must end after view 1/);
    assert.throws(() => buildVideoPlan(TIMES, request({ segments: [] })), /at least one view/);
  });
});

describe('limits', () => {
  test('unsupported settings are refused in words', () => {
    assert.throws(() => buildVideoPlan(TIMES, request({ fps: 23 })), /Frame rate/);
    assert.throws(() => buildVideoPlan(TIMES, request({ timing: { mode: 'perStep', secondsPerStep: 0 } })), /Seconds per time step/);
    assert.throws(() => buildVideoPlan([1], request({ start: 1 })), /two saved time steps/);
  });

  test('a video over the frame limit says how many frames it would need', () => {
    assert.throws(
      () => buildVideoPlan(TIMES, request({ timing: { mode: 'realTime', videoSecondsPerSimSecond: 1000 }, fps: 60 })),
      new RegExp(`270,001 frames; the limit is ${MAX_VIDEO_FRAMES.toLocaleString('en-US')}`),
    );
  });

  test('names and durations', () => {
    assert.equal(videoFileName('my case', 'mp4', new Date(2026, 8, 12, 9, 5, 3)), 'my_case-paraview-20260912-090503.mp4');
    assert.equal(formatVideoDuration(8.44), '8.4 s');
    assert.equal(formatVideoDuration(125), '2 min 05 s');
  });
});

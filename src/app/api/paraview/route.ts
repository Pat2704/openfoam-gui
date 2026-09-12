import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-response';
import { createReadStream, promises as fs } from 'fs';
import { Readable } from 'stream';
import {
  abortParaViewStartup,
  cancelParaViewVideoExport,
  getParaViewVideoFile,
  getParaViewVideoJob,
  saveParaViewVideoInCase,
  startParaViewVideoExport,
  findParaView,
  getParaViewSession,
  getParaViewStartup,
  getParaViewWarmup,
  readParaViewRender,
  sendParaViewCameraCommand,
  sendParaViewCommand,
  startParaViewSession,
  stopParaViewSession,
  warmParaView,
} from '@/lib/paraview';
import type { VideoRequest } from '@/lib/paraview-video';
import { createParaFoamMarker } from '@/lib/wsl';
import { boundedInteger, validateCaseName, validateRelativePath } from '@/lib/wsl-input';

export const runtime = 'nodejs';

let lifecycleQueue: Promise<void> = Promise.resolve();

function enqueueLifecycle<T>(job: () => Promise<T>): Promise<T> {
  const result = lifecycleQueue.then(job, job);
  lifecycleQueue = result.then(() => undefined, () => undefined);
  return result;
}

function requestedPath(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 2_000 || /[\0\r\n]/.test(value)) {
    throw new Error('Invalid ParaView path.');
  }
  return value.trim();
}

function renderResponse(image: Buffer): NextResponse {
  return new NextResponse(new Uint8Array(image), {
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(image.length),
      'Cache-Control': 'no-store',
    },
  });
}

// Discovery lives here because the Dashboard and packaged server share it.
// The workbench itself uses POST commands against one persistent pvpython.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || 'status';
  try {
    if (action === 'status') {
      const status = await findParaView(
        requestedPath(url.searchParams.get('path')),
        url.searchParams.get('refresh') === '1',
      );
      return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (action === 'session') {
      // The workbench polls this while it waits, so the answer carries the
      // startup phase as well as the finished session.
      return NextResponse.json(
        { session: getParaViewSession(), startup: getParaViewStartup(), warmup: getParaViewWarmup() },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (action === 'render') {
      const width = boundedInteger(url.searchParams.get('width'), 1000, 320, 1920);
      const height = boundedInteger(url.searchParams.get('height'), 700, 240, 1200);
      const quality = boundedInteger(url.searchParams.get('quality'), 92, 35, 95);
      return renderResponse(await readParaViewRender(width, height, quality));
    }
    if (action === 'video_status') {
      return NextResponse.json({ job: getParaViewVideoJob() }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (action === 'video_download') {
      const video = getParaViewVideoFile();
      if (!video) return NextResponse.json({ error: 'There is no finished video to download.' }, { status: 404 });
      const stat = await fs.stat(video.file);
      const stream = Readable.toWeb(createReadStream(video.file)) as ReadableStream;
      return new NextResponse(stream, {
        headers: {
          'Content-Type': video.format === 'mp4' ? 'video/mp4' : 'video/ogg',
          'Content-Length': String(stat.size),
          'Content-Disposition': `attachment; filename="${video.fileName}"`,
          'Cache-Control': 'no-store',
        },
      });
    }
    return NextResponse.json({ error: 'Unknown ParaView action.' }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}

/** The shape of a video request; values are validated by buildVideoPlan and again by the worker. */
function videoRequest(value: unknown): VideoRequest {
  const body = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const timing = body.timing && typeof body.timing === 'object' ? body.timing as Record<string, unknown> : {};
  const segments = Array.isArray(body.segments) ? body.segments.slice(0, 31) : [];
  if (JSON.stringify(segments).length > 2_000_000) throw new Error('The video timeline is too large.');
  return {
    start: Number(body.start),
    segments: segments.map(item => {
      const segment = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return {
        until: Number(segment.until),
        transition: String(segment.transition) as VideoRequest['segments'][number]['transition'],
        view: segment.view && typeof segment.view === 'object' && !Array.isArray(segment.view) ? segment.view as Record<string, unknown> : {},
      };
    }),
    timing: timing.mode === 'realTime'
      ? { mode: 'realTime', videoSecondsPerSimSecond: Number(timing.videoSecondsPerSimSecond) }
      : { mode: 'perStep', secondsPerStep: Number(timing.secondsPerStep) },
    interpolate: body.interpolate === true,
    fps: Number(body.fps),
    resolution: String(body.resolution) as VideoRequest['resolution'],
    format: String(body.format) as VideoRequest['format'],
    colorRange: String(body.colorRange) as VideoRequest['colorRange'],
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const action = body.action;

    if (action === 'start') {
      const caseName = validateCaseName(typeof body.case === 'string' ? body.case : '');
      const path = requestedPath(body.path);
      // startParaViewSession serialises and joins starts itself, so a second
      // request for the same case attaches to the one already loading instead
      // of queueing behind it and then starting over.
      const marker = createParaFoamMarker(caseName);
      const state = await startParaViewSession(caseName, marker.windowsPath, path);
      return NextResponse.json({ state });
    }

    if (action === 'warmup') {
      // Loads ParaView once in the background so the workbench later starts on
      // a warm cache. Returns at once: the answer is the warm-up's state, which
      // the Dashboard then follows through `action=session`.
      return NextResponse.json({ warmup: await warmParaView(requestedPath(body.path)) });
    }

    if (action === 'stop') {
      // Cancelling must not wait for the start it cancels.
      await abortParaViewStartup();
      // The abort above also invalidates queued starts. Do not invalidate a
      // fresh start a second time when this queued cleanup gets its turn.
      await enqueueLifecycle(() => stopParaViewSession(false));
      return NextResponse.json({ ok: true });
    }

    if (action === 'command') {
      const command = String(body.command || '');
      const allowed = new Set([
        'state', 'select', 'set_visibility', 'add_filter', 'delete', 'update', 'update_reader',
        'update_view', 'set_manipulator', 'list_case_files', 'open_case_file', 'time', 'refresh',
        'capture_view', 'apply_view',
      ]);
      if (!allowed.has(command)) {
        return NextResponse.json({ error: 'Unsupported ParaView command.' }, { status: 400 });
      }
      let data = body.data && typeof body.data === 'object' && !Array.isArray(body.data)
        ? body.data as Record<string, unknown>
        : {};
      if (command === 'open_case_file') {
        data = { path: validateRelativePath(typeof data.path === 'string' ? data.path : '', 'File path') };
      }
      const result = await sendParaViewCommand(command, data);
      return NextResponse.json(result);
    }

    if (action === 'video_export') {
      return NextResponse.json({ job: await startParaViewVideoExport(videoRequest(body.request)) });
    }
    if (action === 'video_cancel') {
      return NextResponse.json({ job: await cancelParaViewVideoExport() });
    }
    if (action === 'video_save_case') {
      return NextResponse.json({ job: await saveParaViewVideoInCase() });
    }

    if (action === 'camera') {
      const cameraAction = String(body.cameraAction || 'camera');
      if (!['camera', 'reset_camera', 'standard_view', 'manipulate'].includes(cameraAction)) {
        return NextResponse.json({ error: 'Unsupported camera command.' }, { status: 400 });
      }
      const mode = String(body.mode || 'rotate');
      if (cameraAction === 'camera' && !['rotate', 'pan', 'zoom'].includes(mode)) {
        return NextResponse.json({ error: 'Unsupported camera interaction.' }, { status: 400 });
      }
      if (cameraAction === 'manipulate' && !['translate', 'rotate', 'scale', 'point1', 'point2'].includes(mode)) {
        return NextResponse.json({ error: 'Unsupported 3D manipulator interaction.' }, { status: 400 });
      }
      const view = String(body.view || 'Iso');
      if (cameraAction === 'standard_view' && !['+X', '-X', '+Y', '-Y', '+Z', '-Z', 'Iso'].includes(view)) {
        return NextResponse.json({ error: 'Unsupported standard view.' }, { status: 400 });
      }
      const image = await sendParaViewCameraCommand({
        action: cameraAction,
        mode,
        dx: boundedInteger(body.dx, 0, -2_000, 2_000),
        dy: boundedInteger(body.dy, 0, -2_000, 2_000),
        width: boundedInteger(body.width, 1000, 320, 1920),
        height: boundedInteger(body.height, 700, 240, 1200),
        quality: boundedInteger(body.quality, 92, 35, 95),
        view,
      });
      return renderResponse(image);
    }

    return NextResponse.json({ error: 'Unknown ParaView action.' }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-response';
import {
  findParaView,
  getParaViewSession,
  readParaViewRender,
  sendParaViewCameraCommand,
  sendParaViewCommand,
  startParaViewSession,
  stopParaViewSession,
} from '@/lib/paraview';
import { createParaFoamMarker } from '@/lib/wsl';
import { boundedInteger, validateCaseName } from '@/lib/wsl-input';

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
      return NextResponse.json({ session: getParaViewSession() }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (action === 'render') {
      const width = boundedInteger(url.searchParams.get('width'), 1000, 320, 1920);
      const height = boundedInteger(url.searchParams.get('height'), 700, 240, 1200);
      const quality = boundedInteger(url.searchParams.get('quality'), 92, 35, 95);
      return renderResponse(await readParaViewRender(width, height, quality));
    }
    return NextResponse.json({ error: 'Unknown ParaView action.' }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const action = body.action;

    if (action === 'start') {
      const caseName = validateCaseName(typeof body.case === 'string' ? body.case : '');
      const path = requestedPath(body.path);
      return await enqueueLifecycle(async () => {
        const marker = createParaFoamMarker(caseName);
        const state = await startParaViewSession(caseName, marker.windowsPath, path);
        return NextResponse.json({ state });
      });
    }

    if (action === 'stop') {
      await enqueueLifecycle(stopParaViewSession);
      return NextResponse.json({ ok: true });
    }

    if (action === 'command') {
      const command = String(body.command || '');
      const allowed = new Set([
        'state', 'select', 'set_visibility', 'add_filter', 'delete', 'update', 'update_reader',
        'update_view', 'time', 'refresh',
      ]);
      if (!allowed.has(command)) {
        return NextResponse.json({ error: 'Unsupported ParaView command.' }, { status: 400 });
      }
      const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data)
        ? body.data as Record<string, unknown>
        : {};
      const result = await sendParaViewCommand(command, data);
      return NextResponse.json(result);
    }

    if (action === 'camera') {
      const cameraAction = String(body.cameraAction || 'camera');
      if (!['camera', 'reset_camera', 'standard_view'].includes(cameraAction)) {
        return NextResponse.json({ error: 'Unsupported camera command.' }, { status: 400 });
      }
      const mode = String(body.mode || 'rotate');
      if (cameraAction === 'camera' && !['rotate', 'pan', 'zoom'].includes(mode)) {
        return NextResponse.json({ error: 'Unsupported camera interaction.' }, { status: 400 });
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

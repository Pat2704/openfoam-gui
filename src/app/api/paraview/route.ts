import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { apiError } from '@/lib/api-response';
import { findParaView, exportParaViewSurface } from '@/lib/paraview';
import { encodeMeshPayload, parseAsciiStl } from '@/lib/stl';
import { createParaFoamMarker } from '@/lib/wsl';
import { validateCaseName } from '@/lib/wsl-input';

export const runtime = 'nodejs';

// ParaView startup and OpenFOAMReader can both be memory-heavy. Serialising
// jobs prevents repeated clicks or two open windows from starting competing
// pvpython processes. A failed job cannot poison the next one.
let queue: Promise<void> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const result = queue.then(job, job);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

function customPath(req: NextRequest): string {
  const value = new URL(req.url).searchParams.get('path')?.trim() || '';
  if (value.length > 2_000 || /[\0\r\n]/.test(value)) throw new Error('Invalid ParaView path.');
  return value;
}

// GET /api/paraview?action=status[&path=C:\...] — installation discovery
// GET /api/paraview?case=NAME[&path=C:\...]      — ParaView-powered surface
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  let requestedPath: string;
  try {
    requestedPath = customPath(req);
  } catch (error) {
    return apiError(error);
  }

  if (url.searchParams.get('action') === 'status') {
    try {
      const refresh = url.searchParams.get('refresh') === '1';
      const status = await findParaView(requestedPath, refresh);
      return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      return apiError(error);
    }
  }

  let caseName: string;
  try {
    caseName = validateCaseName(url.searchParams.get('case') || '');
  } catch (error) {
    return apiError(error);
  }

  try {
    return await enqueue(async () => {
      const installation = await findParaView(requestedPath);
      if (!installation.found || !installation.pvpythonPath) {
        return NextResponse.json({ error: installation.error || 'ParaView was not found.' }, { status: 424 });
      }

      // This is deliberately paraFoam -touch, not a marker file synthesized by
      // the Windows side: the selected OpenFOAM environment remains the source
      // of truth for the case ParaView is asked to load.
      const marker = createParaFoamMarker(caseName);
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openfoam-studio-paraview-'));
      const outputPath = path.join(tempDir, 'surface.stl');
      try {
        await exportParaViewSurface(installation.pvpythonPath, marker.windowsPath, outputPath);
        const parsed = parseAsciiStl(await fs.readFile(outputPath, 'utf-8'));
        if (parsed.triangles === 0) {
          return NextResponse.json({ error: 'ParaView loaded the case but extracted an empty surface.' }, { status: 422 });
        }
        // VTK's STL writer emits one generic solid after merging the composite
        // OpenFOAM dataset. Give the UI a meaningful, stable label.
        parsed.patches = [{ name: 'ParaView surface', start: 0, count: parsed.positions.length / 3 }];
        const payload = encodeMeshPayload(parsed);
        return new NextResponse(new Uint8Array(payload), {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(payload.length),
            'Cache-Control': 'no-store',
            'X-ParaView-Version': installation.version || 'unknown',
            'X-ParaView-Marker': path.basename(marker.windowsPath),
            'X-Mesh-Triangles': String(parsed.triangles),
          },
        });
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  } catch (error) {
    return apiError(error);
  }
}

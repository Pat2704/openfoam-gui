import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { readCaseBinaryFile, writeCaseBinaryFile } from '@/lib/wsl';
import { apiError } from '@/lib/api-response';
import { validateCaseName, WslInputError } from '@/lib/wsl-input';
import { GEOMETRY_FILE_PATTERN, GEOMETRY_MAX_BYTES, geometryUploadProblem } from '@/lib/geometry';

// The binary channel for snappyHexMesh geometry. Every other case write takes
// JSON text; an STL can be binary and a tutorial geometry is a .gz, so this
// route takes the raw bytes. It writes only into constant/geometry, under a
// name the wizard derives from the surface (GEOMETRY_FILE_PATTERN).
//
// POST /api/cases/[name]/geometry?file=motorBike.obj.gz   (body: the file)
//   → { success, path, bytes, sha256 }
// GET  /api/cases/[name]/geometry?file=motorBike.obj.gz
//   → application/octet-stream (the wizard re-reads it to check insidePoint)

function geometryPath(req: NextRequest): { file: string; path: string } {
  const file = new URL(req.url).searchParams.get('file') || '';
  if (!GEOMETRY_FILE_PATTERN.test(file)) {
    throw new WslInputError('Invalid geometry file name: a word followed by .stl, .stlb or .obj, optionally .gz');
  }
  return { file, path: `constant/geometry/${file}` };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const caseName = validateCaseName((await params).name);
    const { file, path } = geometryPath(req);

    const declared = Number(req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > GEOMETRY_MAX_BYTES) {
      return NextResponse.json(
        { error: `The file is ${(declared / 1048576).toFixed(1)} MB; the limit is ${GEOMETRY_MAX_BYTES / 1048576} MB. Compress it with gzip.` },
        { status: 413 },
      );
    }

    const data = Buffer.from(await req.arrayBuffer());
    // proxy.ts runs on every /api route, and Next buffers a proxied body only up
    // to experimental.proxyClientMaxBodySize — beyond it the route receives the
    // FIRST N BYTES and no error at all. next.config.ts sets that limit above
    // GEOMETRY_MAX_BYTES; this comparison is what catches it if they ever drift.
    if (Number.isFinite(declared) && declared > 0 && data.length !== declared) {
      return NextResponse.json(
        { error: `The upload arrived incomplete (${data.length} of ${declared} bytes); nothing was written.` },
        { status: 400 },
      );
    }

    const problem = geometryUploadProblem(file, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (problem) return NextResponse.json({ error: problem }, { status: data.length > GEOMETRY_MAX_BYTES ? 413 : 400 });

    const sha256 = createHash('sha256').update(data).digest('hex');
    const onDisk = await writeCaseBinaryFile(caseName, path, data);
    if (onDisk !== sha256) throw new Error(`${path} on disk does not match the upload`);
    return NextResponse.json({ success: true, path, bytes: data.length, sha256 });
  } catch (error: unknown) {
    return apiError(error);
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const caseName = validateCaseName((await params).name);
    const { path } = geometryPath(req);
    const data = await readCaseBinaryFile(caseName, path, GEOMETRY_MAX_BYTES);
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(data.length),
        'Cache-Control': 'no-store',
      },
    });
  } catch (error: unknown) {
    return apiError(error);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { extractCaseSurface, cleanupCaseSurface } from '@/lib/wsl';
import { parseAsciiStl, encodeMeshPayload } from '@/lib/stl';
import { apiError } from '@/lib/api-response';
import { validateCaseName } from '@/lib/wsl-input';

// GET /api/mesh?case=NAME
//   → application/octet-stream, see encodeMeshPayload() for the layout.
//
// Extracts the case's boundary patches with surfaceMeshTriangulate, reads the
// STL straight off the WSL filesystem through its Windows path (much faster
// than piping it back through wsl.exe), packs it, and deletes the temp file.
//
// Only the boundary surface: it is what you actually look at to sanity-check a
// mesh, and it scales with surface area rather than cell count, so a case with
// a million cells stays manageable.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  let caseName: string;
  try {
    caseName = validateCaseName(url.searchParams.get('case') || '');
  } catch (e) {
    return apiError(e);
  }

  try {
    const { windowsPath, patchNames } = extractCaseSurface(caseName);

    let text: string;
    try {
      text = await fs.readFile(windowsPath, 'utf-8');
    } finally {
      // Never leave the temp STL behind in the user's case directory, even if
      // the read fails.
      cleanupCaseSurface(caseName);
    }

    const parsed = parseAsciiStl(text);

    // surfaceMeshTriangulate reports the patch list in its log; prefer those
    // names when the STL's own solid names are missing or generic.
    parsed.patches.forEach((p, i) => {
      if (patchNames[i] && /^patch\d+$/.test(p.name)) p.name = patchNames[i];
    });

    if (parsed.triangles === 0) {
      return NextResponse.json(
        { error: 'The extracted surface is empty — does this case have a mesh?' },
        { status: 422 }
      );
    }

    const payload = encodeMeshPayload(parsed);
    return new NextResponse(new Uint8Array(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(payload.length),
        'Cache-Control': 'no-store',
        'X-Mesh-Triangles': String(parsed.triangles),
        'X-Mesh-Patches': String(parsed.patches.length),
      },
    });
  } catch (e) {
    cleanupCaseSurface(caseName);
    return apiError(e);
  }
}

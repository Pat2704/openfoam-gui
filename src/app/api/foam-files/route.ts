import { NextRequest, NextResponse } from 'next/server';
import { listFoamDirectory, readFoamFile, getFoamSectionDir, FOAM_SECTIONS, FoamSection } from '@/lib/wsl';
import { apiError } from '@/lib/api-response';

function parseSection(value: string | null): FoamSection | null {
  if (!value) return null;
  return (FOAM_SECTIONS as readonly string[]).includes(value) ? (value as FoamSection) : null;
}

// GET /api/foam-files
//   ?action=ls&section=applications&path=...    → list directory
//   ?action=read&section=src&path=...           → read file
//   ?action=root&section=applications           → { rootDir } (for the breadcrumb header)
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action');
    const section = parseSection(searchParams.get('section'));
    if (!section) {
      return NextResponse.json({ error: `Invalid section. Use: ${FOAM_SECTIONS.join(', ')}` }, { status: 400 });
    }

    switch (action) {
      case 'ls': {
        const relPath = searchParams.get('path') || '';
        const result = listFoamDirectory(section, relPath);
        return NextResponse.json(result);
      }
      case 'read': {
        const relPath = searchParams.get('path') || '';
        if (!relPath) {
          return NextResponse.json({ error: 'Path required' }, { status: 400 });
        }
        const result = readFoamFile(section, relPath);
        return NextResponse.json(result);
      }
      case 'root': {
        const rootDir = getFoamSectionDir(section);
        return NextResponse.json({ rootDir, exists: !!rootDir });
      }
      default:
        return NextResponse.json(
          { error: 'Invalid action. Use: ls, read, root' },
          { status: 400 }
        );
    }
  } catch (error: unknown) {
    return apiError(error);
  }
}

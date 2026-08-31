import { NextRequest, NextResponse } from 'next/server';
import {
  listTutorialCategories,
  listTutorialCases,
  copyTutorial,
  getTutorialDirectory,
} from '@/lib/wsl';
import { apiError } from '@/lib/api-response';
import { validateCaseName } from '@/lib/wsl-input';

// GET /api/tutorials
//   ?action=categories          → { categories, tutorialDir }
//   ?action=cases&category=…    → { cases }
//   ?action=tutDir              → { tutorialDir }
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action');

    switch (action) {
      case 'categories': {
        const categories = listTutorialCategories();
        const tutorialDir = getTutorialDirectory();
        return NextResponse.json({ categories, tutorialDir });
      }
      case 'cases': {
        const category = searchParams.get('category') || '';
        const cases = listTutorialCases(category);
        return NextResponse.json({ cases });
      }
      case 'tutDir': {
        const tutorialDir = getTutorialDirectory();
        return NextResponse.json({ tutorialDir });
      }
      default:
        return NextResponse.json(
          { error: 'Invalid action. Use: categories, cases, tutDir' },
          { status: 400 }
        );
    }
  } catch (error: unknown) {
    return apiError(error);
  }
}

// POST /api/tutorials
//   { action: 'copy', tutorialPath, newCaseName } → { success, caseName }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (body?.action !== 'copy') {
      return NextResponse.json({ error: 'Invalid action. Use: copy' }, { status: 400 });
    }
    const tutorialPath = typeof body.tutorialPath === 'string' ? body.tutorialPath : '';
    const newCaseName = validateCaseName(body.newCaseName);
    const created = copyTutorial(tutorialPath, newCaseName);
    return NextResponse.json({ success: true, caseName: created });
  } catch (error: unknown) {
    return apiError(error);
  }
}

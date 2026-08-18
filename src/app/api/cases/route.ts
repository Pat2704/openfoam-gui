import { NextRequest, NextResponse } from 'next/server';
import {
  listCases,
  listCasesBatch,
  getCaseInfo,
  getTimeStepsOnly,
  getRunDirectory,
  createCase,
  deleteCase,
  renameCase,
} from '@/lib/wsl';
import { apiError } from '@/lib/api-response';
import { validateCaseName, WslInputError } from '@/lib/wsl-input';

// GET /api/cases
//   ?action=list         → { cases: string[] }
//   ?action=listBatch    → { cases: CaseSummary[] }
//   ?action=info&name=…  → getCaseInfo result
//   ?action=timesteps&name=… → { timeSteps: string[] }
//   ?action=runDir       → { runDir: string }
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action');

    switch (action) {
      case 'list': {
        const cases = listCases();
        return NextResponse.json({ cases });
      }
      case 'listBatch': {
        const cases = listCasesBatch();
        return NextResponse.json({ cases });
      }
      case 'info': {
        const name = searchParams.get('name');
        const safeName = validateCaseName(name || '');
        const info = getCaseInfo(safeName);
        return NextResponse.json(info);
      }
      case 'timesteps': {
        const name = searchParams.get('name');
        const safeName = validateCaseName(name || '');
        const timeSteps = getTimeStepsOnly(safeName);
        return NextResponse.json({ timeSteps });
      }
      case 'runDir': {
        const runDir = getRunDirectory();
        return NextResponse.json({ runDir });
      }
      default:
        return NextResponse.json(
          { error: 'Invalid action. Use: list, listBatch, info, timesteps, runDir' },
          { status: 400 }
        );
    }
  } catch (error: unknown) {
    return apiError(error);
  }
}

// POST /api/cases
//   { action: 'create', caseName } → { success, caseName }
//   { action: 'delete', caseName } → { success }
//   { action: 'rename', caseName, newName } → { success, caseName: newName }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body?.action;

    if (action === 'create') {
      const safeName = createCase(body.caseName);
      return NextResponse.json({ success: true, caseName: safeName });
    }
    if (action === 'delete') {
      const safeName = validateCaseName(body.caseName);
      deleteCase(safeName);
      return NextResponse.json({ success: true });
    }
    if (action === 'rename') {
      const newName = renameCase(body.caseName, body.newName);
      return NextResponse.json({ success: true, caseName: newName });
    }

    return NextResponse.json({ error: 'Invalid action. Use: create, delete, rename' }, { status: 400 });
  } catch (error: unknown) {
    return apiError(error);
  }
}

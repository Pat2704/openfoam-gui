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
  lastBatchContainers,
  createContainer,
  deleteContainer,
  renameContainer,
  setFolderKind,
} from '@/lib/wsl';
import { apiError } from '@/lib/api-response';
import { validateCaseName, WslInputError } from '@/lib/wsl-input';

// GET /api/cases
//   ?action=list         → { cases: string[] }
//   ?action=listBatch    → { cases: CaseSummary[], containers: string[] }
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
        return NextResponse.json({ cases, containers: lastBatchContainers() });
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
//
// A case name is a case REFERENCE: `case`, or `container/case`. Renaming to a
// reference in another container (or none) moves the case there.
//
// Containers — folders of the run directory that group cases:
//   { action: 'createContainer', name }          → { success, name }
//   { action: 'deleteContainer', name }          → { success } (only when empty)
//   { action: 'renameContainer', name, newName } → { success, name: newName }
//   { action: 'setKind', name, kind, confirmed? } → { success, kind } or, for a
//       folder that holds folders, { success: false, needsConfirmation, folders }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body?.action;

    if (action === 'create') {
      // `overwrite` is only sent after the user confirmed it (the wizard).
      const safeName = createCase(body.caseName, { allowExisting: body.overwrite === true });
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

    if (action === 'createContainer') {
      return NextResponse.json({ success: true, name: createContainer(body.name) });
    }
    if (action === 'deleteContainer') {
      deleteContainer(body.name);
      return NextResponse.json({ success: true });
    }
    if (action === 'renameContainer') {
      return NextResponse.json({ success: true, name: renameContainer(body.name, body.newName) });
    }
    if (action === 'setKind') {
      if (body.kind !== 'container' && body.kind !== 'case') {
        return NextResponse.json({ error: 'kind must be "container" or "case"' }, { status: 400 });
      }
      const result = setFolderKind(body.name, body.kind, body.confirmed === true);
      return NextResponse.json({ success: !result.needsConfirmation, ...result });
    }

    return NextResponse.json(
      { error: 'Invalid action. Use: create, delete, rename, createContainer, deleteContainer, renameContainer, setKind' },
      { status: 400 },
    );
  } catch (error: unknown) {
    return apiError(error);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import {
  getCaseInfo,
  listDirectory,
  readFile,
  writeFile,
  createDirectory,
  deleteFile,
  deletePath,
  deleteAllTimesteps,
  cloneCase,
  getCaseLog,
  listLogFiles,
  runCheckMesh,
  validateBoundaryConditions,
  getCaseSummary,
} from '@/lib/wsl';
import { apiError } from '@/lib/api-response';
import { validateCaseName, boundedInteger } from '@/lib/wsl-input';

// GET /api/cases/[name]
//   ?action=read&path=…          → { content }
//   ?action=info                 → getCaseInfo result
//   ?action=ls&path=…            → { items }
//   ?action=logs&log=…&tail=…    → { content, availableLogs }
//   ?action=listLogs             → { availableLogs }
//   ?action=residuals&log=…&maxLines=… → { content }
//   ?action=checkMesh            → CheckMeshResult
//   ?action=validateBC           → BCValidationResult
//   ?action=caseSummary          → CaseSummaryInfo
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const { name: rawName } = await params;
    const caseName = validateCaseName(rawName);
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action');

    switch (action) {
      case 'read': {
        const path = searchParams.get('path') || '';
        const content = readFile(caseName, path);
        return NextResponse.json({ content });
      }
      case 'info': {
        const info = getCaseInfo(caseName);
        return NextResponse.json(info);
      }
      case 'ls': {
        const dirPath = searchParams.get('path') || '';
        const items = listDirectory(caseName, dirPath);
        return NextResponse.json({ items });
      }
      case 'logs': {
        const log = searchParams.get('log') || 'log';
        const tail = boundedInteger(searchParams.get('tail'), 100, 1, 50000);
        const content = getCaseLog(caseName, log, tail);
        const availableLogs = listLogFiles(caseName);
        return NextResponse.json({ content, availableLogs });
      }
      case 'listLogs': {
        const availableLogs = listLogFiles(caseName);
        return NextResponse.json({ availableLogs });
      }
      case 'residuals': {
        const log = searchParams.get('log') || 'log';
        const maxLines = boundedInteger(searchParams.get('maxLines'), 50000, 1, 200000);
        const content = getCaseLog(caseName, log, maxLines);
        return NextResponse.json({ content });
      }
      case 'checkMesh': {
        const result = runCheckMesh(caseName);
        return NextResponse.json(result);
      }
      case 'validateBC': {
        const result = validateBoundaryConditions(caseName);
        return NextResponse.json(result);
      }
      case 'caseSummary': {
        const result = getCaseSummary(caseName);
        return NextResponse.json(result);
      }
      default:
        return NextResponse.json(
          { error: 'Invalid action. Use: read, info, ls, logs, listLogs, residuals, checkMesh, validateBC, caseSummary' },
          { status: 400 }
        );
    }
  } catch (error: unknown) {
    return apiError(error);
  }
}

// POST /api/cases/[name]
//   { action: 'write', path, content }        → { success }
//   { action: 'mkdir', dirPath }              → { success }
//   { action: 'deleteFile', path }            → { success }
//   { action: 'deletePath', path }            → { success }
//   { action: 'deleteBatch', paths }          → { success, deleted }
//   { action: 'deleteTimesteps' }             → { success, message, deleted, count }
//   { action: 'clone', newName }              → { success, caseName }
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const { name: rawName } = await params;
    const caseName = validateCaseName(rawName);
    const body = await req.json();
    const action = body?.action;

    switch (action) {
      case 'write': {
        writeFile(caseName, body.path, body.content ?? '');
        return NextResponse.json({ success: true });
      }
      case 'mkdir': {
        createDirectory(caseName, body.dirPath);
        return NextResponse.json({ success: true });
      }
      case 'deleteFile': {
        deleteFile(caseName, body.path);
        return NextResponse.json({ success: true });
      }
      case 'deletePath': {
        deletePath(caseName, body.path);
        return NextResponse.json({ success: true });
      }
      case 'deleteBatch': {
        const paths: string[] = Array.isArray(body.paths) ? body.paths : [];
        let deleted = 0;
        for (const p of paths) {
          try {
            deletePath(caseName, p);
            deleted++;
          } catch {
            /* continue with the rest of the batch */
          }
        }
        return NextResponse.json({ success: true, deleted });
      }
      case 'deleteTimesteps': {
        const result = deleteAllTimesteps(caseName);
        return NextResponse.json({
          success: true,
          message: `Deleted ${result.count} timesteps`,
          deleted: result.deleted,
          count: result.count,
        });
      }
      case 'clone': {
        const newName = cloneCase(caseName, body.newName);
        return NextResponse.json({ success: true, caseName: newName });
      }
      default:
        return NextResponse.json(
          { error: 'Invalid action. Use: write, mkdir, deleteFile, deletePath, deleteBatch, deleteTimesteps, clone' },
          { status: 400 }
        );
    }
  } catch (error: unknown) {
    return apiError(error);
  }
}

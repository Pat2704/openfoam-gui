import { NextRequest, NextResponse } from 'next/server';
import { analysisDocumentStore, analysisNamespace, ANALYSIS_DOCUMENT_BYTES } from '@/lib/analysis-document-store';
import { getOpenFOAMInstallationIdentity } from '@/lib/wsl';
import { validateCaseName, WslInputError } from '@/lib/wsl-input';
import { apiError } from '@/lib/api-response';

function scope(req: NextRequest) {
  const namespace = analysisNamespace(req.nextUrl.searchParams.get('namespace'));
  const caseName = validateCaseName(req.nextUrl.searchParams.get('case') || '');
  const installation = getOpenFOAMInstallationIdentity().baseId;
  const expected = req.headers.get('x-ofstudio-installation');
  if ((expected && expected !== installation) || (req.method !== 'GET' && !expected)) {
    throw new WslInputError('OpenFOAM installation changed. Reopen the saved analysis library.');
  }
  return { namespace, caseName, installation };
}

async function body(req: NextRequest) {
  if (Number(req.headers.get('content-length') || 0) > ANALYSIS_DOCUMENT_BYTES + 1024) throw new WslInputError('The saved analysis exceeds the 8 MB limit.');
  const reader = req.body?.getReader();
  if (!reader) throw new WslInputError('Saved analysis data required.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.length;
    if (length > ANALYSIS_DOCUMENT_BYTES + 1024) { await reader.cancel(); throw new WslInputError('The saved analysis exceeds the 8 MB limit.'); }
    chunks.push(next.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function GET(req: NextRequest) {
  try { const { namespace, caseName, installation } = scope(req); return NextResponse.json({ documents: await analysisDocumentStore().list(namespace, installation, caseName), installation }); }
  catch (error) { return apiError(error); }
}

export async function POST(req: NextRequest) {
  try {
    const value = await body(req);
    const { namespace, caseName, installation } = scope(req);
    return NextResponse.json({ document: await analysisDocumentStore().save(namespace, installation, caseName, value), installation });
  } catch (error) { return apiError(error); }
}

export async function DELETE(req: NextRequest) {
  try {
    const value = await body(req);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WslInputError('Invalid saved analysis deletion.');
    const { namespace, caseName, installation } = scope(req);
    await analysisDocumentStore().delete(namespace, installation, caseName, value.id);
    return NextResponse.json({ deleted: true });
  } catch (error) { return apiError(error); }
}

export type AnalysisNamespace = 'postprocess' | 'paraview';
export interface AnalysisDocument { id: string; name: string; savedAt: string; data: unknown }
let installation: string | null = null;
let revision = 0;
let listening = false;

async function request(namespace: AnalysisNamespace, caseName: string, method: string, body?: unknown) {
  if (typeof window !== 'undefined' && !listening) {
    listening = true;
    window.addEventListener('foam-version-changed', () => { installation = null; revision++; });
  }
  const started = revision;
  if (method !== 'GET' && !installation) await request(namespace, caseName, 'GET');
  if (started !== revision) throw new Error('OpenFOAM installation changed. Reopen the saved analysis library.');
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (installation && method !== 'GET') headers['X-Ofstudio-Installation'] = installation;
  const response = await fetch(`/api/analyses?namespace=${namespace}&case=${encodeURIComponent(caseName)}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined, cache: 'no-store',
  });
  const result = await response.json();
  if (started !== revision) throw new Error('OpenFOAM installation changed. Reopen the saved analysis library.');
  if (!response.ok) {
    if (String(result.error).startsWith('OpenFOAM installation changed.')) installation = null;
    throw new Error(result.error || 'Saved analyses are unavailable.');
  }
  if (typeof result.installation === 'string') installation = result.installation;
  return result;
}

export async function listAnalysisDocuments(namespace: AnalysisNamespace, caseName: string): Promise<AnalysisDocument[]> {
  return (await request(namespace, caseName, 'GET')).documents;
}

export async function saveAnalysisDocument(namespace: AnalysisNamespace, caseName: string, document: AnalysisDocument): Promise<AnalysisDocument> {
  return (await request(namespace, caseName, 'POST', document)).document;
}

export async function deleteAnalysisDocument(namespace: AnalysisNamespace, caseName: string, id: string): Promise<void> {
  await request(namespace, caseName, 'DELETE', { id });
}

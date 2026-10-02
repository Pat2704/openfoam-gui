import test from 'node:test';
import assert from 'node:assert/strict';
import { listAnalysisDocuments, saveAnalysisDocument } from '../src/lib/analysis-documents';

test('document mutations carry the selected installation and discard responses after an installation switch', async () => {
  const previousFetch = globalThis.fetch;
  const events = new EventTarget();
  Reflect.set(globalThis, 'window', events);
  const calls: { method: string; installation: string | undefined }[] = [];
  let selected = 'install-a';
  let changeDuringSave = false;
  const document = { id: 'saved', name: 'Saved', savedAt: '2026-10-02T10:00:00.000Z', data: { version: 1 } };
  globalThis.fetch = async (_input, init) => {
    calls.push({ method: init?.method ?? '', installation: (init?.headers as Record<string, string>)['X-Ofstudio-Installation'] });
    if (changeDuringSave && init?.method === 'POST') { selected = 'install-b'; events.dispatchEvent(new Event('foam-version-changed')); }
    return Response.json({ installation: selected, documents: [], document });
  };
  try {
    await saveAnalysisDocument('postprocess', 'cavity_test', document);
    assert.deepEqual(calls, [{ method: 'GET', installation: undefined }, { method: 'POST', installation: 'install-a' }]);
    changeDuringSave = true;
    await assert.rejects(saveAnalysisDocument('postprocess', 'cavity_test', document), /installation changed/);
    changeDuringSave = false;
    await listAnalysisDocuments('paraview', 'cavity_test');
    assert.equal(calls.at(-1)?.installation, undefined, 'The old installation token must be cleared.');
    await saveAnalysisDocument('paraview', 'cavity_test', document);
    assert.equal(calls.at(-1)?.installation, 'install-b');
  } finally { globalThis.fetch = previousFetch; Reflect.deleteProperty(globalThis, 'window'); }
});

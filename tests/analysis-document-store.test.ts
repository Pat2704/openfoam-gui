import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AnalysisDocumentStore, validateAnalysisDocument } from '../src/lib/analysis-document-store';

const doc = (id: string) => ({ id, name: `Analysis ${id}`, savedAt: '2026-10-02T10:00:00.000Z', data: { version: 1, note: '<script>not executable</script>' } });

test('saved documents survive store recreation and stay scoped by installation, case and section', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ofstudio-analyses-test-'));
  try {
    const store = new AnalysisDocumentStore(root);
    await store.save('postprocess', 'install-a', 'cavity_test', doc('first'));
    const reopened = new AnalysisDocumentStore(root);
    assert.deepEqual(await reopened.list('postprocess', 'install-a', 'cavity_test'), [doc('first')]);
    assert.deepEqual(await reopened.list('postprocess', 'install-b', 'cavity_test'), []);
    assert.deepEqual(await reopened.list('postprocess', 'install-a', 'other_test'), []);
    assert.deepEqual(await reopened.list('paraview', 'install-a', 'cavity_test'), []);
    await reopened.save('postprocess', 'install-a', 'cavity_test', { ...doc('first'), name: 'Updated' });
    assert.equal((await store.list('postprocess', 'install-a', 'cavity_test'))[0].name, 'Updated');
    await store.delete('postprocess', 'install-a', 'cavity_test', 'first');
    assert.deepEqual(await reopened.list('postprocess', 'install-a', 'cavity_test'), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent saves are serialized without losing entries; limits and traversal fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ofstudio-analyses-test-'));
  try {
    const store = new AnalysisDocumentStore(root);
    await Promise.all(Array.from({ length: 30 }, (_, index) => store.save('paraview', 'install', 'cavity_test', doc(`doc-${index}`))));
    assert.equal((await store.list('paraview', 'install', 'cavity_test')).length, 30);
    await assert.rejects(store.save('paraview', 'install', 'cavity_test', doc('over-limit')), /30 saved/);
    await assert.rejects(store.save('paraview', 'install', '../case', doc('escape')), /Invalid case/);
    await assert.rejects(store.delete('paraview', 'install', 'cavity_test', '../../escape'), /Invalid saved/);
    assert.throws(() => validateAnalysisDocument({ ...doc('safe'), name: 'bad\nname' }), /name/);
    assert.throws(() => validateAnalysisDocument({ ...doc('safe'), data: { huge: 'x'.repeat(8 * 1024 * 1024) } }), /8 MB/);
    // A corrupt library is never silently overwritten by the next save.
    const { readdir } = await import('node:fs/promises');
    const file = path.join(root, 'paraview', (await readdir(path.join(root, 'paraview')))[0]);
    await writeFile(file, '{broken', 'utf8');
    await assert.rejects(store.save('paraview', 'install', 'cavity_test', doc('safe')), SyntaxError);
    assert.equal(await readFile(file, 'utf8'), '{broken');
  } finally { await rm(root, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  compareParaViewVersions,
  normalizeParaViewPath,
  paraViewExecutableCandidates,
  paraViewVersionFromNames,
} from '../src/lib/paraview.ts';

test('ParaView candidate expansion accepts a version-independent install folder', () => {
  const root = 'C:\\Tools\\Scientific Suite';
  const candidates = paraViewExecutableCandidates(root).map(value => value.toLowerCase());
  assert.ok(candidates.includes(path.resolve(root, 'pvpython.exe').toLowerCase()));
  assert.ok(candidates.includes(path.resolve(root, 'bin', 'pvpython.exe').toLowerCase()));
});

test('ParaView candidate expansion maps paraview.exe to its pvpython sibling', () => {
  const executable = 'D:\\Portable\\ParaView-any-version\\bin\\paraview.exe';
  const expected = path.resolve(path.dirname(executable), 'pvpython.exe').toLowerCase();
  assert.ok(paraViewExecutableCandidates(executable).map(value => value.toLowerCase()).includes(expected));
});

test('ParaView candidate expansion recovers from a path one level too deep', () => {
  const share = 'C:\\Program Files\\ParaView-6.2.0\\share';
  const expected = path.resolve('C:\\Program Files\\ParaView-6.2.0\\bin\\pvpython.exe').toLowerCase();
  assert.ok(paraViewExecutableCandidates(share).map(value => value.toLowerCase()).includes(expected));
});

test('A pasted ParaView path keeps working with quotes, variables and trailing slashes', () => {
  process.env.OFSTUDIO_TEST_ROOT = 'C:\\Program Files';
  assert.equal(normalizeParaViewPath('  "C:\\Program Files\\ParaView-6.2.0\\"  '), 'C:\\Program Files\\ParaView-6.2.0');
  assert.equal(normalizeParaViewPath('%OFSTUDIO_TEST_ROOT%\\ParaView-6.2.0'), 'C:\\Program Files\\ParaView-6.2.0');
  // A bare drive keeps its separator: `C:` alone is that drive's current folder.
  assert.equal(normalizeParaViewPath('C:\\'), 'C:\\');
  delete process.env.OFSTUDIO_TEST_ROOT;
});

test('ParaView versions are compared numerically rather than lexically', () => {
  assert.ok(compareParaViewVersions('5.12.1', '5.9.0') > 0);
  assert.ok(compareParaViewVersions('6.0.0', '5.12.1') > 0);
  assert.equal(compareParaViewVersions('6.0', '6.0.0'), 0);
});

test('The installation version is read from the folders ParaView creates', () => {
  // The install folder carries the patch level that share/paraview-6.2 drops.
  assert.equal(paraViewVersionFromNames('ParaView-6.2.0', ['licenses', 'paraview-6.2', 'proj']), '6.2.0');
  assert.equal(paraViewVersionFromNames('ParaView 5.11.0-Windows', ['paraview-5.11']), '5.11.0');
  // A renamed or unversioned folder still resolves through the resource folder.
  assert.equal(paraViewVersionFromNames('ParaView', ['paraview-5.13']), '5.13');
  assert.equal(paraViewVersionFromNames('viewer-2024', ['paraview-6.0']), '6.0');
  assert.equal(paraViewVersionFromNames('Tools', ['bin', 'doc']), '');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { compareParaViewVersions, paraViewExecutableCandidates } from '../src/lib/paraview.ts';

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

test('ParaView versions are compared numerically rather than lexically', () => {
  assert.ok(compareParaViewVersions('5.12.1', '5.9.0') > 0);
  assert.ok(compareParaViewVersions('6.0.0', '5.12.1') > 0);
  assert.equal(compareParaViewVersions('6.0', '6.0.0'), 0);
});

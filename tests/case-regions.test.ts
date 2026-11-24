/** A case's mesh regions (src/lib/case-regions.ts). The shell function itself runs in tests/case-digest.test.ts. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeReaderPart, isReaderInternalMesh, isReaderPatch, meshTargets, parseCaseRegions, regionOption, regionPath,
} from '../src/lib/case-regions.ts';

test('the report lines become the regions, the meshed ones and the application', () => {
  assert.deepEqual(parseCaseRegions('R|film\nM|film\nR|fluid\nM|fluid\nAPP|foamMultiRun\n'),
    { regions: ['film', 'fluid'], meshRegions: ['film', 'fluid'], defaultMesh: false, application: 'foamMultiRun' });
  assert.deepEqual(parseCaseRegions('DEFAULT\nAPP|foamRun\n'),
    { regions: [], meshRegions: [], defaultMesh: true, application: 'foamRun' });
  assert.deepEqual(parseCaseRegions('R|bad name\nR|$(id)\n').regions, [], 'nothing a command line could misread');
});

test('the meshes to work on, and how a command names one', () => {
  assert.deepEqual(meshTargets(parseCaseRegions('R|a\nM|a\nR|b\n')), ['a']);
  assert.deepEqual(meshTargets(parseCaseRegions('DEFAULT\n')), ['']);
  assert.deepEqual(meshTargets(parseCaseRegions('')), []);
  assert.equal(regionOption('fluid'), ' -region fluid');
  assert.equal(regionOption(''), '');
  assert.throws(() => regionOption('a;b'));
  assert.equal(regionPath('constant', 'fluid', 'polyMesh'), 'constant/fluid/polyMesh');
  assert.equal(regionPath('constant', '', 'polyMesh'), 'constant/polyMesh');
});

test('the ParaView reader names a region’s parts behind it', () => {
  assert.deepEqual(describeReaderPart('/fluid/patch/inlet'), { region: 'fluid', kind: 'patch', label: 'inlet' });
  assert.deepEqual(describeReaderPart('/film/internalMesh'), { region: 'film', kind: 'mesh', label: 'internalMesh' });
  assert.deepEqual(describeReaderPart('group/wall'), { region: '', kind: 'group', label: 'wall' });
  assert.deepEqual(['internalMesh', '/fluid/internalMesh', '/fluid/patch/x', 'patch/y'].filter(isReaderInternalMesh),
    ['internalMesh', '/fluid/internalMesh']);
  assert.deepEqual(['internalMesh', '/fluid/patch/x', 'patch/y', '/fluid/group/wall'].filter(isReaderPatch),
    ['/fluid/patch/x', 'patch/y']);
});

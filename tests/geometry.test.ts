/**
 * Reading the geometry the wizard hands to snappyHexMesh.
 *
 * The bounding box proposes the background mesh and the triangles decide
 * whether insidePoint is in the fluid, so a reader that silently drops faces or
 * mistakes a binary STL for ASCII gives the user a wrong box and a wrong
 * verdict. The upload check is what keeps a mislabelled file out of the case.
 *
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  GEOMETRY_MAX_BYTES,
  geometryKind,
  geometryUploadProblem,
  isGzip,
  parseGeometry,
  pointInBox,
  pointInsideSurface,
  unionBbox,
  type Vec3,
} from '../src/lib/geometry.ts';

// A unit cube from (0 0 0) to (2 1 1): twelve triangles.
const V: Vec3[] = [[0, 0, 0], [2, 0, 0], [2, 1, 0], [0, 1, 0], [0, 0, 1], [2, 0, 1], [2, 1, 1], [0, 1, 1]];
const QUADS = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]];
const TRIS: Vec3[][] = QUADS.flatMap(([a, b, c, d]) => [[V[a], V[b], V[c]], [V[a], V[c], V[d]]]);

function asciiStl(name = 'box'): Uint8Array {
  const facets = TRIS.map(t =>
    `  facet normal 0 0 0\n    outer loop\n${t.map(v => `      vertex ${v.join(' ')}`).join('\n')}\n    endloop\n  endfacet`,
  ).join('\n');
  return new TextEncoder().encode(`solid ${name}\n${facets}\nendsolid ${name}\n`);
}

function binaryStl(): Uint8Array {
  const buf = new Uint8Array(84 + 50 * TRIS.length);
  // Binary files whose header starts with "solid" exist; the size must decide.
  buf.set(new TextEncoder().encode('solid exported by some CAD tool'), 0);
  const view = new DataView(buf.buffer);
  view.setUint32(80, TRIS.length, true);
  TRIS.forEach((t, i) => {
    let p = 84 + i * 50 + 12;
    for (const v of t) for (const c of v) { view.setFloat32(p, c, true); p += 4; }
  });
  return buf;
}

function obj(): Uint8Array {
  const verts = V.map(v => `v ${v.join(' ')}`).join('\n');
  // Quads, "/vt/vn" index parts, negative (relative) indices and two groups.
  const faces = QUADS.map((q, i) => {
    const idx = i % 2 === 0 ? q.map(k => `${k + 1}/1/1`) : q.map(k => String(k - V.length));
    return `${i === 0 ? 'g sideA\n' : i === 3 ? 'g sideB\n' : ''}f ${idx.join(' ')}`;
  }).join('\n');
  return new TextEncoder().encode(`# cube\n${verts}\n${faces}\n`);
}

describe('parseGeometry', () => {
  test('ASCII STL: every facet, the solid name as a region, the bounding box', () => {
    const g = parseGeometry('box.stl', asciiStl());
    assert.equal(g.triangleCount, 12);
    assert.equal(g.binary, false);
    assert.deepEqual(g.regions, ['box']);
    assert.deepEqual(g.bbox, { min: [0, 0, 0], max: [2, 1, 1] });
  });

  test('solid names are regions even when they look like `patchN`, and an unnamed solid is none', () => {
    const two = new TextDecoder().decode(asciiStl('patch1')) + new TextDecoder().decode(asciiStl('patch2'));
    assert.deepEqual(parseGeometry('flange.stl', new TextEncoder().encode(two)).regions, ['patch1', 'patch2']);
    const unnamed = new TextDecoder().decode(asciiStl('')).replace(/^solid \n/, 'solid\n');
    assert.deepEqual(parseGeometry('x.stl', new TextEncoder().encode(unnamed)).regions, []);
  });

  test('binary STL is recognised by its size even when its header says "solid"', () => {
    const g = parseGeometry('box.stl', binaryStl());
    assert.equal(g.binary, true);
    assert.equal(g.triangleCount, 12);
    assert.deepEqual(g.bbox, { min: [0, 0, 0], max: [2, 1, 1] });
  });

  test('OBJ: quads are split, relative indices resolve, groups become regions', () => {
    const g = parseGeometry('box.obj', obj());
    assert.equal(g.triangleCount, 12);
    assert.deepEqual(g.regions, ['sideA', 'sideB']);
    assert.deepEqual(g.bbox, { min: [0, 0, 0], max: [2, 1, 1] });
  });

  test('a file with no triangles, or an unknown extension, is refused in words', () => {
    assert.throws(() => parseGeometry('box.stl', new TextEncoder().encode('solid empty\nendsolid empty\n')), /No triangles/);
    assert.throws(() => parseGeometry('box.step', asciiStl()), /STL .* OBJ/);
  });
});

describe('pointInsideSurface', () => {
  const g = parseGeometry('box.stl', asciiStl());

  test('a point in the body is inside, the free stream is not', () => {
    assert.equal(pointInsideSurface(g, [1, 0.5, 0.5]), true);
    assert.equal(pointInsideSurface(g, [0.3, 0.7, 0.2]), true);
    assert.equal(pointInsideSurface(g, [3, 0.5, 0.5]), false);
    assert.equal(pointInsideSurface(g, [-1, -1, -1]), false);
  });

  test('the same answer from every reader', () => {
    for (const other of [parseGeometry('b.stl', binaryStl()), parseGeometry('b.obj', obj())]) {
      assert.equal(pointInsideSurface(other, [1, 0.5, 0.5]), true);
      assert.equal(pointInsideSurface(other, [1, 0.5, 1.5]), false);
    }
  });
});

describe('boxes', () => {
  test('union and strict containment', () => {
    const u = unionBbox([{ min: [0, 0, 0], max: [1, 1, 1] }, null, { min: [-1, 0.5, 0], max: [0.5, 2, 1] }]);
    assert.deepEqual(u, { min: [-1, 0, 0], max: [1, 2, 1] });
    assert.equal(unionBbox([null, undefined]), null);
    assert.equal(pointInBox([0.5, 0.5, 0.5], u!), true);
    assert.equal(pointInBox([1, 0.5, 0.5], u!), false, 'a point on the face is not inside');
  });
});

describe('geometryUploadProblem', () => {
  test('accepts the files the wizard names', () => {
    assert.equal(geometryUploadProblem('box.stl', asciiStl()), null);
    assert.equal(geometryUploadProblem('box.stl', binaryStl()), null);
    assert.equal(geometryUploadProblem('box.stlb', binaryStl()), null);
    assert.equal(geometryUploadProblem('box.obj', obj()), null);
    assert.equal(geometryUploadProblem('motorBike.obj.gz', gzipSync(obj())), null);
  });

  test('refuses names that are not a word plus a geometry extension', () => {
    for (const name of ['../box.stl', 'box', 'box.step', '1box.stl', 'my box.stl', 'box.stl.zip', '.stl']) {
      assert.match(geometryUploadProblem(name, asciiStl()) ?? '', /word followed by/, name);
    }
  });

  test('the name and the bytes must agree about compression and format', () => {
    assert.match(geometryUploadProblem('box.stl.gz', asciiStl()) ?? '', /not gzip/);
    assert.match(geometryUploadProblem('box.stl', gzipSync(asciiStl())) ?? '', /does not end in \.gz/);
    assert.match(geometryUploadProblem('box.stlb', asciiStl()) ?? '', /not a binary STL/);
    assert.match(geometryUploadProblem('box.obj', binaryStl()) ?? '', /not text/);
    assert.match(geometryUploadProblem('box.stl', new Uint8Array(0)) ?? '', /empty/);
  });

  test('the size limit is stated, not just enforced', () => {
    const big = { length: GEOMETRY_MAX_BYTES + 1 } as unknown as Uint8Array;
    assert.match(geometryUploadProblem('box.stl', big) ?? '', /limit is 100 MB/);
  });

  test('isGzip and geometryKind', () => {
    assert.equal(isGzip(gzipSync(obj())), true);
    assert.equal(isGzip(obj()), false);
    assert.equal(geometryKind('A.STL.GZ'), 'stl');
    assert.equal(geometryKind('a.stlb'), 'stl');
    assert.equal(geometryKind('a.obj.gz'), 'obj');
    assert.equal(geometryKind('a.vtk'), null);
  });
});

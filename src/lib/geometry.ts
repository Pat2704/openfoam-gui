/**
 * Surface geometry for snappyHexMesh: reading STL and OBJ files.
 *
 * The wizard reads the file the user picks IN THE BROWSER, before any case
 * exists: the bounding box proposes the background mesh, and the triangles are
 * what tells whether `insidePoint` sits in the fluid or inside the body. The
 * same bytes are then uploaded unchanged to `constant/geometry`, where OpenFOAM
 * reads them itself — this module never rewrites a geometry file.
 *
 * Pure and dependency-free apart from the ASCII STL reader in ./stl, so it runs
 * in the browser, in the upload route and in `node --test`. Decompressing a
 * `.gz` is the caller's job (DecompressionStream in the browser, zlib in tests):
 * OpenFOAM reads `motorBike.obj.gz` when a dictionary names `motorBike.obj`,
 * which is how every tutorial ships its geometry, so compressed files are
 * uploaded as they are.
 */

import { parseAsciiStl } from './stl';

/** Largest geometry file the upload accepts, compressed size if it is a .gz. */
export const GEOMETRY_MAX_BYTES = 100 * 1024 * 1024;

/**
 * The name a geometry file gets in `constant/geometry`.
 *
 * The wizard derives it from the surface name (an OpenFOAM word), so it is
 * deliberately narrower than a case-relative path: no spaces, no dots before the
 * extension, nothing a dictionary would have to quote specially.
 */
export const GEOMETRY_FILE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}\.(stl|stlb|obj)(\.gz)?$/;

export type GeometryKind = 'stl' | 'obj';

export type Vec3 = [number, number, number];

export interface Bbox { min: Vec3; max: Vec3 }

export interface ParsedGeometry {
  kind: GeometryKind;
  /** Binary STL; ASCII STL and OBJ are text. */
  binary: boolean;
  /** x, y, z of three vertices per triangle, not indexed. */
  triangles: Float32Array;
  triangleCount: number;
  /**
   * Named regions: ASCII STL solids or OBJ groups that carry faces. snappyHexMesh
   * makes one patch per region, named `<surface>_<region>`. A binary STL has
   * one unnamed region and reports an empty list.
   */
  regions: string[];
  bbox: Bbox;
}

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** The format a file name declares, ignoring a trailing `.gz`. */
export function geometryKind(fileName: string): GeometryKind | null {
  const n = fileName.toLowerCase().replace(/\.gz$/, '');
  if (n.endsWith('.stl') || n.endsWith('.stlb')) return 'stl';
  if (n.endsWith('.obj')) return 'obj';
  return null;
}

/**
 * A binary STL is an 80-byte header, a triangle count and 50 bytes per
 * triangle. The size is the only reliable test: plenty of binary files begin
 * their header with the word "solid", which is what ASCII files begin with.
 */
function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false;
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  return 84 + 50 * n === bytes.length;
}

function looksLikeText(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 4096);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return false;
  return true;
}

/**
 * Why a file may not be uploaded as `name`, or null if it may.
 *
 * Checked by the upload route on the bytes it actually received, so a file
 * whose name promises one thing and whose content is another is refused before
 * it reaches the case, rather than by snappyHexMesh minutes later.
 */
export function geometryUploadProblem(name: string, bytes: Uint8Array): string | null {
  if (!GEOMETRY_FILE_PATTERN.test(name)) {
    return 'The geometry file name must be a word followed by .stl, .stlb or .obj, optionally .gz.';
  }
  if (bytes.length === 0) return 'The geometry file is empty.';
  if (bytes.length > GEOMETRY_MAX_BYTES) {
    return `The geometry file is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is ${GEOMETRY_MAX_BYTES / 1048576} MB. Compress it with gzip.`;
  }
  const gz = name.toLowerCase().endsWith('.gz');
  if (gz !== isGzip(bytes)) {
    return gz
      ? 'The file is named .gz but is not gzip-compressed.'
      : 'The file is gzip-compressed but its name does not end in .gz.';
  }
  if (gz) return null;
  const lower = name.toLowerCase();
  if (lower.endsWith('.stlb') && !isBinaryStl(bytes)) return 'The .stlb file is not a binary STL.';
  if (lower.endsWith('.stl') && !isBinaryStl(bytes) && !looksLikeText(bytes)) {
    return 'The .stl file is neither ASCII nor a well-formed binary STL.';
  }
  if (lower.endsWith('.obj') && !looksLikeText(bytes)) return 'The .obj file is not text.';
  return null;
}

function emptyBbox(): { min: Vec3; max: Vec3 } {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

function bboxOf(tris: Float32Array): Bbox {
  const b = emptyBbox();
  for (let i = 0; i < tris.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = tris[i + a];
      if (v < b.min[a]) b.min[a] = v;
      if (v > b.max[a]) b.max[a] = v;
    }
  }
  return b;
}

function parseBinaryStl(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint32(80, true);
  const out = new Float32Array(n * 9);
  let o = 0;
  for (let t = 0; t < n; t++) {
    // 12 bytes of facet normal first, then three vertices; 2 attribute bytes last.
    let p = 84 + t * 50 + 12;
    for (let k = 0; k < 9; k++, p += 4) out[o++] = view.getFloat32(p, true);
  }
  return out;
}

/**
 * Wavefront OBJ: `v` vertices and `f` faces, fan-triangulated; `g` and `o`
 * start a region. Face indices may carry `/vt/vn` parts and may be negative
 * (counted back from the last vertex), both of which exporters use.
 */
function parseObj(text: string): { triangles: Float32Array; regions: string[] } {
  const verts: number[] = [];
  let tris = new Float32Array(1 << 16);
  let n = 0;
  const regions: string[] = [];
  const seen = new Set<string>();
  let region = '';

  const pushVertex = (index: number) => {
    const at = index * 3;
    if (n + 3 > tris.length) {
      const bigger = new Float32Array(tris.length * 2);
      bigger.set(tris.subarray(0, n));
      tris = bigger;
    }
    tris[n++] = verts[at];
    tris[n++] = verts[at + 1];
    tris[n++] = verts[at + 2];
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length < 2) continue;
    const c = line.charCodeAt(0);
    const sep = line.charCodeAt(1);
    if (sep !== 32 && sep !== 9) continue;

    if (c === 118 /* v */) {
      const parts = line.slice(2).trim().split(/\s+/);
      verts.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
    } else if (c === 102 /* f */) {
      const count = verts.length / 3;
      const idx = line.slice(2).trim().split(/\s+/).map(tok => {
        const i = parseInt(tok, 10);
        return i < 0 ? count + i : i - 1;
      }).filter(i => Number.isInteger(i) && i >= 0 && i < count);
      if (idx.length < 3) continue;
      if (!seen.has(region)) { seen.add(region); if (region) regions.push(region); }
      for (let k = 1; k + 1 < idx.length; k++) {
        pushVertex(idx[0]); pushVertex(idx[k]); pushVertex(idx[k + 1]);
      }
    } else if (c === 103 /* g */ || c === 111 /* o */) {
      region = line.slice(2).trim().split(/\s+/)[0] || '';
    }
  }
  return { triangles: tris.slice(0, n), regions };
}

/**
 * Read an uncompressed geometry file. Throws with a sentence for the user when
 * the file holds no triangles, which is what a wrong format usually produces.
 */
export function parseGeometry(fileName: string, bytes: Uint8Array): ParsedGeometry {
  const kind = geometryKind(fileName);
  if (!kind) throw new Error('Only STL (.stl, .stlb) and OBJ (.obj) files can be used, optionally gzip-compressed.');

  let triangles: Float32Array;
  let regions: string[] = [];
  let binary = false;

  if (kind === 'stl' && (fileName.toLowerCase().replace(/\.gz$/, '').endsWith('.stlb') || isBinaryStl(bytes))) {
    binary = true;
    triangles = parseBinaryStl(bytes);
  } else if (kind === 'stl') {
    const text = new TextDecoder().decode(bytes);
    triangles = parseAsciiStl(text).positions;
    // The names on the `solid` lines themselves: the reader invents `patchN`
    // for an unnamed solid, but a file can genuinely call its solids `patch1`
    // (the installation's flange.stl does), so the names are read here.
    const named = [...text.matchAll(/^[ \t]*solid[ \t]+(\S+)/gm)].map(m => m[1]);
    regions = [...new Set(named)];
  } else {
    ({ triangles, regions } = parseObj(new TextDecoder().decode(bytes)));
  }

  const triangleCount = Math.floor(triangles.length / 9);
  if (triangleCount === 0) throw new Error(`No triangles were found in ${fileName}.`);
  for (let i = 0; i < triangles.length; i++) {
    if (!Number.isFinite(triangles[i])) throw new Error(`${fileName} contains coordinates that are not numbers.`);
  }
  return { kind, binary, triangles, triangleCount, regions, bbox: bboxOf(triangles) };
}

export function unionBbox(boxes: (Bbox | null | undefined)[]): Bbox | null {
  const b = emptyBbox();
  let any = false;
  for (const box of boxes) {
    if (!box) continue;
    any = true;
    for (let a = 0; a < 3; a++) {
      b.min[a] = Math.min(b.min[a], box.min[a]);
      b.max[a] = Math.max(b.max[a], box.max[a]);
    }
  }
  return any ? b : null;
}

/** Is `p` strictly inside `box`? */
export function pointInBox(p: Vec3, box: Bbox): boolean {
  return p.every((v, a) => v > box.min[a] && v < box.max[a]);
}

/**
 * Directions for the parity test. Deliberately not the axes: a ray along an
 * axis through a CAD model runs exactly along edges and through vertices, where
 * a hit is counted twice or not at all.
 */
const RAYS: Vec3[] = [
  [1, 0.0123, 0.0071],
  [-0.0131, 1, 0.0293],
  [0.0217, -0.0173, 1],
];

function crossings(tris: Float32Array, o: Vec3, d: Vec3): number {
  let count = 0;
  for (let i = 0; i < tris.length; i += 9) {
    const e1x = tris[i + 3] - tris[i], e1y = tris[i + 4] - tris[i + 1], e1z = tris[i + 5] - tris[i + 2];
    const e2x = tris[i + 6] - tris[i], e2y = tris[i + 7] - tris[i + 1], e2z = tris[i + 8] - tris[i + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-20 && det < 1e-20) continue;
    const inv = 1 / det;
    const tx = o[0] - tris[i], ty = o[1] - tris[i + 1], tz = o[2] - tris[i + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 1e-12) count++;
  }
  return count;
}

/**
 * Is `p` inside the closed surface? A ray from inside crosses the surface an
 * odd number of times; three rays vote, so one ray grazing an edge or slipping
 * through a gap in an imperfect CAD export does not decide the answer alone.
 * For a surface that is not closed the answer is a best guess — as it is for
 * snappyHexMesh itself, which then leaks.
 */
export function pointInsideSurface(g: ParsedGeometry, p: Vec3): boolean {
  if (!pointInBox(p, g.bbox)) return false;
  let votes = 0;
  for (const d of RAYS) if (crossings(g.triangles, p, d) % 2 === 1) votes++;
  return votes >= 2;
}

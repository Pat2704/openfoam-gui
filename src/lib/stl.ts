/**
 * Minimal ASCII STL reader, used to turn what surfaceMeshTriangulate writes
 * into something compact enough to send to the browser.
 *
 * An 83k-triangle case comes out as ~18 MB of ASCII. Shipping that as-is would
 * be wasteful twice over — over the wire, and again as JS strings to parse in
 * the renderer — so we parse here and emit packed Float32 positions plus the
 * ranges that map each patch onto that array.
 *
 * Normals are deliberately dropped: STL stores one per facet, which doubles the
 * payload, and three.js recomputes identical flat normals from non-indexed
 * positions with computeVertexNormals().
 */

export interface StlPatch {
  name: string;
  /** First vertex index of this patch (in vertices, not floats). */
  start: number;
  /** Number of vertices (3 per triangle). */
  count: number;
}

export interface ParsedStl {
  /** x,y,z per vertex, 3 vertices per triangle, no indexing. */
  positions: Float32Array;
  patches: StlPatch[];
  triangles: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

/**
 * Parses ASCII STL. Written as a single pass over the buffer rather than
 * split('\n') + per-line regex: on an 18 MB file the naive version spends most
 * of its time allocating strings.
 */
export function parseAsciiStl(text: string): ParsedStl {
  // Three vertices per facet; grow geometrically, trim at the end.
  let cap = 1 << 16;
  let positions = new Float32Array(cap);
  let n = 0; // floats written

  const patches: StlPatch[] = [];
  let current: StlPatch | null = null;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  const push = (x: number, y: number, z: number) => {
    if (n + 3 > cap) {
      cap *= 2;
      const bigger = new Float32Array(cap);
      bigger.set(positions.subarray(0, n));
      positions = bigger;
    }
    positions[n++] = x;
    positions[n++] = y;
    positions[n++] = z;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  };

  let i = 0;
  const len = text.length;

  while (i < len) {
    // start of a line
    let end = text.indexOf('\n', i);
    if (end === -1) end = len;

    // skip leading whitespace without slicing
    let s = i;
    while (s < end && (text.charCodeAt(s) === 32 || text.charCodeAt(s) === 9)) s++;

    const c = text.charCodeAt(s);
    // 'v' = vertex, 's' = solid, 'e' = endsolid/endloop/endfacet
    if (c === 118 /* v */ && text.startsWith('vertex', s)) {
      const parts = text.slice(s + 6, end).trim().split(/\s+/);
      if (parts.length >= 3) {
        push(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]));
      }
    } else if (c === 115 /* s */ && text.startsWith('solid', s)) {
      const name = text.slice(s + 5, end).trim() || `patch${patches.length}`;
      current = { name, start: n / 3, count: 0 };
      patches.push(current);
    } else if (c === 101 /* e */ && text.startsWith('endsolid', s)) {
      if (current) {
        current.count = n / 3 - current.start;
        current = null;
      }
    }

    i = end + 1;
  }

  // Unterminated last solid (some writers omit endsolid).
  if (current) current.count = n / 3 - current.start;

  const triangles = n / 9;
  if (!isFinite(minX)) {
    minX = minY = minZ = maxX = maxY = maxZ = 0;
  }

  return {
    positions: positions.subarray(0, n),
    patches: patches.filter(p => p.count > 0),
    triangles,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}

/**
 * Wire format for /api/mesh:
 *   [0..4)            uint32LE  header length (already padded, see below)
 *   [4..4+H)          UTF-8 JSON: { patches, triangles, bbox }
 *   [4+H..]           Float32LE positions
 *
 * A single response instead of JSON-with-embedded-numbers: the positions stay
 * binary the whole way, so the renderer can hand the buffer straight to a
 * three.js BufferAttribute with no per-number parsing.
 *
 * The header is space-padded to a multiple of 4 so that the positions begin on
 * a 4-byte boundary. Without it `new Float32Array(buf, 4 + headerLen)` throws
 * "start offset of Float32Array should be a multiple of 4" for every header
 * whose length is not already aligned — which is almost all of them. Trailing
 * whitespace is valid JSON, so the client can parse the padded slice as-is.
 */
export function encodeMeshPayload(parsed: ParsedStl): Buffer {
  const json = JSON.stringify({
    patches: parsed.patches,
    triangles: parsed.triangles,
    bbox: parsed.bbox,
  });
  const padding = (4 - (Buffer.byteLength(json, 'utf-8') % 4)) % 4;
  const header = Buffer.from(json + ' '.repeat(padding), 'utf-8');

  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(header.length, 0);

  // Copy into a plain Buffer so the byte order is explicit (Float32Array's
  // underlying buffer is already little-endian on every platform we target,
  // but going through Buffer keeps that assumption in one place).
  const body = Buffer.from(
    parsed.positions.buffer,
    parsed.positions.byteOffset,
    parsed.positions.byteLength
  );

  return Buffer.concat([prefix, header, body]);
}

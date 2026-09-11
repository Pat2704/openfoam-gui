/**
 * Reading geometry files in the browser, for the wizard's mesh step. The
 * parsing is src/lib/geometry.ts; this adds the browser's gzip support.
 */

import { isGzip, parseGeometry, type ParsedGeometry } from '@/lib/geometry';

export interface LoadedGeometry {
  /** Bytes to upload at Create/Update; null when the file is already in the case. */
  upload: Uint8Array | null;
  /** Null while it is still being read back from the case. */
  parsed: ParsedGeometry | null;
  error?: string;
}

export interface InsideCheck { tone: 'ok' | 'bad' | 'unknown'; message: string }

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Parse a geometry file as picked or as read back from the case, .gz or not. */
export async function readGeometry(name: string, raw: Uint8Array): Promise<ParsedGeometry> {
  const plain = isGzip(raw) ? await gunzip(raw) : raw;
  return parseGeometry(name.replace(/\.gz$/i, ''), plain);
}

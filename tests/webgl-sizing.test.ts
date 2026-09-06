import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_DRAWING_BUFFER_PIXELS, safeDrawingBufferPixelRatio } from '../src/lib/webgl-sizing.ts';

test('ordinary viewers retain HiDPI rendering', () => {
  assert.equal(safeDrawingBufferPixelRatio({
    width: 1200,
    height: 500,
    devicePixelRatio: 2,
    maxRenderbufferSize: 8192,
    maxViewportWidth: 8192,
    maxViewportHeight: 8192,
  }), 2);
});

test('large HiDPI viewers stay within the physical-pixel budget', () => {
  const ratio = safeDrawingBufferPixelRatio({
    width: 4000,
    height: 2500,
    devicePixelRatio: 2,
    maxRenderbufferSize: 16384,
    maxViewportWidth: 16384,
    maxViewportHeight: 16384,
  });
  assert.ok(4000 * ratio * 2500 * ratio <= MAX_DRAWING_BUFFER_PIXELS + 1);
});

test('lower-end GPU dimensions limit raster density without changing CSS size', () => {
  const width = 3000;
  const height = 1000;
  const ratio = safeDrawingBufferPixelRatio({
    width,
    height,
    devicePixelRatio: 2,
    maxRenderbufferSize: 4096,
    maxViewportWidth: 4096,
    maxViewportHeight: 4096,
  });
  assert.ok(width * ratio <= 4096);
  assert.ok(height * ratio <= 4096);
  assert.equal(width, 3000);
  assert.equal(height, 1000);
});

// Roughly one 4K drawing buffer. Antialiasing may allocate extra samples, so
// this keeps memory use reasonable on integrated GPUs with shared RAM too.
export const MAX_DRAWING_BUFFER_PIXELS = 8_000_000;

interface PixelRatioLimits {
  width: number;
  height: number;
  devicePixelRatio: number;
  maxRenderbufferSize: number;
  maxViewportWidth: number;
  maxViewportHeight: number;
  maxPixels?: number;
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Bound only the physical drawing buffer. The caller keeps logical dimensions
 * for layout, camera aspect and pointer input, so GPU limits cannot move or
 * distort the scene.
 */
export function safeDrawingBufferPixelRatio({
  width,
  height,
  devicePixelRatio,
  maxRenderbufferSize,
  maxViewportWidth,
  maxViewportHeight,
  maxPixels = MAX_DRAWING_BUFFER_PIXELS,
}: PixelRatioLimits): number {
  const cssWidth = positive(width, 1);
  const cssHeight = positive(height, 1);
  const requested = Math.min(Math.max(positive(devicePixelRatio, 1), 0.1), 2);
  const renderbuffer = positive(maxRenderbufferSize, 4096);
  const viewportWidth = positive(maxViewportWidth, renderbuffer);
  const viewportHeight = positive(maxViewportHeight, renderbuffer);
  const pixelBudget = positive(maxPixels, MAX_DRAWING_BUFFER_PIXELS);

  const dimensionLimit = Math.min(
    renderbuffer / cssWidth,
    renderbuffer / cssHeight,
    viewportWidth / cssWidth,
    viewportHeight / cssHeight,
  );
  const areaLimit = Math.sqrt(pixelBudget / (cssWidth * cssHeight));
  return Math.min(requested, dimensionLimit, areaLimit);
}

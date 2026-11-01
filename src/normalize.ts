import type { RgbaImage } from './lineart';
import { CARD_MM } from './pdf';

/** Working resolution: 63 × 88 mm at ~300 DPI. */
export const CARD_PX = { w: 744, h: 1039 };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Bounding box of everything that differs from the top-left pixel's color,
 * e.g. a card photographed or scanned on a plain background.
 */
export function findContentBounds(img: RgbaImage, tolerance = 40): Rect {
  const { width: w, height: h, data } = img;
  const bg = [data[0], data[1], data[2]];
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const diff = Math.max(
        Math.abs(data[p] - bg[0]),
        Math.abs(data[p + 1] - bg[1]),
        Math.abs(data[p + 2] - bg[2]),
      );
      if (diff > tolerance) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w, h };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  return [c, ctx];
}

/** Crops background, then scales the card to CARD_PX on white (stretching only if the aspect ratio is close). */
export function normalizeCard(source: ImageBitmap): ImageData {
  const [full, fullCtx] = canvas(source.width, source.height);
  fullCtx.drawImage(source, 0, 0);
  let b = findContentBounds(fullCtx.getImageData(0, 0, full.width, full.height));
  if (b.w * b.h > 0.96 * full.width * full.height) b = { x: 0, y: 0, w: full.width, h: full.height };

  const { w: W, h: H } = CARD_PX;
  const [, ctx] = canvas(W, H);
  const ratio = b.w / b.h / (CARD_MM.w / CARD_MM.h);
  if (Math.abs(ratio - 1) < 0.05) {
    ctx.drawImage(full, b.x, b.y, b.w, b.h, 0, 0, W, H);
  } else {
    const scale = Math.min(W / b.w, H / b.h);
    const dw = b.w * scale, dh = b.h * scale;
    ctx.drawImage(full, b.x, b.y, b.w, b.h, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  return ctx.getImageData(0, 0, W, H);
}

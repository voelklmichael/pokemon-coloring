// PNG helpers shared by the scripts that read card images.
import { decode } from 'fast-png';
import type { Rect } from '../src/detect';

/** Decoded PNG as 8-bit RGBA (TCGdex serves palette PNGs). */
export function toRgba(png: ReturnType<typeof decode>) {
  const { width, height, channels, palette } = png;
  const src = png.data;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (palette) {
      const [r, g, b, a = 255] = palette[src[i]];
      data.set([r, g, b, a], i * 4);
      continue;
    }
    for (let c = 0; c < 3; c++) data[i * 4 + c] = src[i * channels + (channels < 3 ? 0 : c)];
    data[i * 4 + 3] = channels === 4 || channels === 2 ? src[i * channels + channels - 1] : 255;
  }
  return { width, height, data };
}

export function crop(img: { width: number; data: Uint8ClampedArray }, r: Rect, inset: number) {
  const x = r.x + inset, y = r.y + inset, w = r.w - 2 * inset, h = r.h - 2 * inset;
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const start = ((y + row) * img.width + x) * 4;
    out.set(img.data.subarray(start, start + w * 4), row * w * 4);
  }
  return { width: w, height: h, data: out, channels: 4 };
}

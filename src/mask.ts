import { dilate, lineArt, type LineArtSettings, type RgbaImage } from './lineart';

/** ImageNet mean/std, as U²-Net was trained with. */
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** RGBA image (already at the model's input size) → normalized planar RGB (CHW). */
export function toModelInput(img: RgbaImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) out[c * n + i] = (img.data[i * 4 + c] / 255 - MEAN[c]) / STD[c];
  }
  return out;
}

/** Rescales values to 0..1 by their own min and max, in place. */
export function normalizeRange(values: Float32Array): Float32Array {
  let min = Infinity, max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const scale = 1 / Math.max(max - min, 1e-6);
  for (let i = 0; i < values.length; i++) values[i] = (values[i] - min) * scale;
  return values;
}

/** Bilinear resize of a single-channel image (pixel centers aligned). */
export function resizeBilinear(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh);
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  for (let y = 0; y < dh; y++) {
    const fy = clamp(((y + 0.5) * sh) / dh - 0.5, sh - 1);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, sh - 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = clamp(((x + 0.5) * sw) / dw - 0.5, sw - 1);
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, sw - 1), tx = fx - x0;
      const top = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const bottom = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * dw + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return out;
}

/** Labels 8-connected components of a binary mask; returns labels (0 = none) and each label's size. */
function labelComponents(mask: Uint8Array, w: number, h: number) {
  const labels = new Int32Array(w * h);
  const sizes = [0];
  const stack = new Int32Array(w * h);
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || labels[s]) continue;
    const label = sizes.length;
    let sp = 0, size = 0;
    stack[sp++] = s;
    labels[s] = label;
    while (sp > 0) {
      const i = stack[--sp];
      size++;
      const x = i % w, y = (i - x) / w;
      for (let ny = Math.max(y - 1, 0); ny <= Math.min(y + 1, h - 1); ny++) {
        for (let nx = Math.max(x - 1, 0); nx <= Math.min(x + 1, w - 1); nx++) {
          const j = ny * w + nx;
          if (mask[j] && !labels[j]) {
            labels[j] = label;
            stack[sp++] = j;
          }
        }
      }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/** Sets background regions that don't touch the image border (holes inside the foreground), in place. */
export function fillHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const visit = (i: number) => {
    if (!mask[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) visit(x), visit((h - 1) * w + x);
  for (let y = 0; y < h; y++) visit(y * w), visit(y * w + w - 1);
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < (h - 1) * w) visit(i + w);
  }
  for (let i = 0; i < mask.length; i++) if (!outside[i]) mask[i] = 1;
  return mask;
}

/**
 * Turns a soft foreground probability map into the final mask (1 = Pokémon): threshold,
 * keep only large blobs (≥ 10 % of the largest and ≥ 0.2 % of the image), fill enclosed
 * holes, grow by 2 px so the outline isn't cut off.
 */
export function cleanMask(prob: Float32Array, w: number, h: number, threshold = 0.5): Uint8Array {
  const fg = new Uint8Array(w * h);
  for (let i = 0; i < fg.length; i++) fg[i] = prob[i] >= threshold ? 1 : 0;
  const { labels, sizes } = labelComponents(fg, w, h);
  const minSize = Math.max(0.1 * Math.max(...sizes), 0.002 * w * h);
  for (let i = 0; i < fg.length; i++) fg[i] = labels[i] && sizes[labels[i]] >= minSize ? 1 : 0;
  return dilate(fillHoles(fg, w, h), w, h, 5);
}

/** What happens to the artwork outside the Pokémon. */
export type BackgroundMode = 'keep' | 'fade' | 'remove';

/** Line settings for a faded background: smoother, fewer and thinner lines. */
export function fadedSettings(s: LineArtSettings): LineArtSettings {
  return {
    blur: s.blur + 1,
    detail: Math.max(1, Math.round(s.detail / 2)),
    minSpeckle: s.minSpeckle * 3,
    lineWidth: Math.max(1, s.lineWidth - 2),
  };
}

/** Line art of the artwork, with the background (mask = 0) kept, faded or removed. */
export function artLineArt(img: RgbaImage, s: LineArtSettings, mode: BackgroundMode, mask?: Uint8Array): Uint8Array {
  if (mode === 'keep' || !mask) return lineArt(img, s);
  if (mode === 'remove') {
    // Transparent pixels count as white, so the background yields no edges, only the outline.
    const data = Uint8ClampedArray.from(img.data);
    for (let i = 0; i < mask.length; i++) if (!mask[i]) data[i * 4 + 3] = 0;
    return lineArt({ width: img.width, height: img.height, data }, s);
  }
  const fg = lineArt(img, s);
  const bg = lineArt(img, fadedSettings(s));
  for (let i = 0; i < fg.length; i++) if (!mask[i]) fg[i] = bg[i];
  return fg;
}

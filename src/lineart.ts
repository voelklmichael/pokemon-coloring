import { TEXT_REGIONS, type Region } from './layout';

/** Minimal RGBA image; structurally compatible with the DOM's ImageData. */
export interface RgbaImage {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/** "hide": blank the text areas, leaving empty boxes. "edges": treat text like the rest of the card. */
export type TextMode = 'hide' | 'edges';

export interface LineArtSettings {
  /** Blur radius in px applied before edge detection; removes texture and holo patterns. */
  blur: number;
  /** Percentage (0..100) of pixels with the strongest gradients that start a line. Adapts to each card's contrast. */
  detail: number;
  /** Line fragments smaller than this many px are removed. */
  minSpeckle: number;
  /** Output stroke width in px (odd values). */
  lineWidth: number;
  textMode: TextMode;
}

export const PRESETS = {
  simple: { blur: 2, detail: 10, minSpeckle: 80, lineWidth: 3 },
  detailed: { blur: 1, detail: 14, minSpeckle: 40, lineWidth: 3 },
  thick: { blur: 2, detail: 10, minSpeckle: 150, lineWidth: 7 },
} satisfies Record<string, Omit<LineArtSettings, 'textMode'>>;

export type PresetName = keyof typeof PRESETS;

export const DEFAULT_LINE_ART: LineArtSettings = { ...PRESETS.detailed, textMode: 'hide' };

/** Luminance 0..255, with transparent pixels composited onto white. */
export function toGray(img: RgbaImage): Float32Array {
  const { data } = img;
  const out = new Float32Array(img.width * img.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const a = data[p + 3] / 255;
    const g = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    out[i] = g * a + 255 * (1 - a);
  }
  return out;
}

function boxBlurH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(Math.max(k, 0), w - 1)];
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc * norm;
      acc += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)];
    }
  }
}

function boxBlurV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const norm = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[Math.min(Math.max(k, 0), h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * norm;
      acc += src[Math.min(y + r + 1, h - 1) * w + x] - src[Math.max(y - r, 0) * w + x];
    }
  }
}

/** Approximate Gaussian blur: three box blur passes. */
export function blur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const a = src.slice();
  if (radius <= 0) return a;
  const b = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) {
    boxBlurH(a, b, w, h, radius);
    boxBlurV(b, a, w, h, radius);
  }
  return a;
}

/** Gradient value above which `percent` % of the pixels lie. */
export function percentile(values: Float32Array, percent: number): number {
  const bins = new Uint32Array(1024);
  let max = 0;
  for (const v of values) if (v > max) max = v;
  if (max === 0) return Infinity;
  const scale = (bins.length - 1) / max;
  for (const v of values) bins[Math.floor(v * scale)]++;
  let remaining = (values.length * percent) / 100;
  for (let b = bins.length - 1; b > 0; b--) {
    remaining -= bins[b];
    if (remaining < 0) return b / scale;
  }
  return 1 / scale;
}

/**
 * Canny edge detection (Sobel, non-maximum suppression, hysteresis). Returns 1 for edge pixels.
 * The thresholds adapt to the image: the strongest `detail` % of gradients start lines.
 */
export function canny(gray: Float32Array, w: number, h: number, detail: number): Uint8Array {
  const n = w * h;
  const mag = new Float32Array(n);
  const dir = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = gray[i - w - 1], t = gray[i - w], tr = gray[i - w + 1];
      const l = gray[i - 1], r = gray[i + 1];
      const bl = gray[i + w - 1], b = gray[i + w], br = gray[i + w + 1];
      const gx = tr + 2 * r + br - (tl + 2 * l + bl);
      const gy = bl + 2 * b + br - (tl + 2 * t + tr);
      mag[i] = Math.hypot(gx, gy) / 4;
      let angle = (Math.atan2(gy, gx) * 180) / Math.PI;
      if (angle < 0) angle += 180;
      // 0: gradient along x, 1: along the down-right diagonal, 2: along y, 3: along the down-left diagonal
      dir[i] = angle < 22.5 || angle >= 157.5 ? 0 : angle < 67.5 ? 1 : angle < 112.5 ? 2 : 3;
    }
  }

  // Never treat faint texture as lines, even on very flat images.
  const high = Math.max(percentile(mag, detail), 8);
  const low = high / 2;

  const neighbor = [1, w + 1, w, w - 1];
  const edge = new Uint8Array(n); // 0 none, 1 weak, 2 strong
  const stack = new Int32Array(n);
  let sp = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < low) continue;
      const d = neighbor[dir[i]];
      if (m < mag[i - d] || m < mag[i + d]) continue;
      if (m >= high) {
        edge[i] = 2;
        stack[sp++] = i;
      } else {
        edge[i] = 1;
      }
    }
  }

  // Hysteresis: promote weak edges connected to strong ones.
  while (sp > 0) {
    const i = stack[--sp];
    for (let dy = -w; dy <= w; dy += w) {
      for (let dx = -1; dx <= 1; dx++) {
        const j = i + dy + dx;
        if (edge[j] === 1) {
          edge[j] = 2;
          stack[sp++] = j;
        }
      }
    }
  }

  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = edge[i] === 2 ? 1 : 0;
  return out;
}

/** Removes 8-connected components with fewer than `minSize` pixels, in place. */
export function removeSpeckles(mask: Uint8Array, w: number, h: number, minSize: number): void {
  if (minSize <= 1) return;
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const component = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (!mask[s] || seen[s]) continue;
    let sp = 0;
    let size = 0;
    stack[sp++] = s;
    seen[s] = 1;
    while (sp > 0) {
      const i = stack[--sp];
      component[size++] = i;
      const x = i % w;
      const y = (i - x) / w;
      for (let ny = Math.max(y - 1, 0); ny <= Math.min(y + 1, h - 1); ny++) {
        for (let nx = Math.max(x - 1, 0); nx <= Math.min(x + 1, w - 1); nx++) {
          const j = ny * w + nx;
          if (mask[j] && !seen[j]) {
            seen[j] = 1;
            stack[sp++] = j;
          }
        }
      }
    }
    if (size < minSize) for (let k = 0; k < size; k++) mask[component[k]] = 0;
  }
}

/** Thickens lines by stamping a disk of the given diameter onto every set pixel. */
export function dilate(mask: Uint8Array, w: number, h: number, width: number): Uint8Array {
  const r = Math.max(0, Math.floor((width - 1) / 2));
  if (r === 0) return mask.slice();
  const offsets: [number, number][] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + r) offsets.push([dx, dy]);
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (const [dx, dy] of offsets) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) out[ny * w + nx] = 1;
      }
    }
  }
  return out;
}

/** Clears a region and draws a box outline around it. */
function hideRegion(mask: Uint8Array, w: number, h: number, region: Region, lineWidth: number) {
  const x0 = Math.round(region.x * w), y0 = Math.round(region.y * h);
  const x1 = Math.round((region.x + region.w) * w), y1 = Math.round((region.y + region.h) * h);
  const lw = Math.max(1, Math.round(lineWidth / 2));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const border = x < x0 + lw || x >= x1 - lw || y < y0 + lw || y >= y1 - lw;
      mask[y * w + x] = border ? 1 : 0;
    }
  }
}

/** Converts a card image to a line-art mask: 1 = black line, 0 = white. */
export function lineArt(img: RgbaImage, s: LineArtSettings, textRegions: Region[] = TEXT_REGIONS): Uint8Array {
  const { width: w, height: h } = img;
  const smooth = blur(toGray(img), w, h, s.blur);
  const edges = canny(smooth, w, h, s.detail);
  removeSpeckles(edges, w, h, s.minSpeckle);
  const mask = dilate(edges, w, h, s.lineWidth);
  if (s.textMode === 'hide') for (const region of textRegions) hideRegion(mask, w, h, region, s.lineWidth);
  return mask;
}

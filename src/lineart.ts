/** Minimal RGBA image; structurally compatible with the DOM's ImageData. */
export interface RgbaImage {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export interface LineArtSettings {
  /** Blur radius in px applied before edge detection; removes texture and holo patterns. */
  blur: number;
  /** Percentage (0..100) of pixels with the strongest gradients that start a line. Adapts to each image's contrast. */
  detail: number;
  /** Line fragments smaller than this many px are removed. */
  minSpeckle: number;
  /** Output stroke width in px (odd values). */
  lineWidth: number;
}

export const PRESETS = {
  simple: { blur: 2, detail: 10, minSpeckle: 80, lineWidth: 3 },
  detailed: { blur: 1, detail: 14, minSpeckle: 40, lineWidth: 3 },
  thick: { blur: 2, detail: 10, minSpeckle: 150, lineWidth: 7 },
} satisfies Record<string, LineArtSettings>;

export type PresetName = keyof typeof PRESETS;

export const DEFAULT_LINE_ART: LineArtSettings = { ...PRESETS.detailed };

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

/** One color channel 0..255, with transparent pixels composited onto white. */
function toChannel(img: RgbaImage, c: 0 | 1 | 2): Float32Array {
  const { data } = img;
  const out = new Float32Array(img.width * img.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const a = data[p + 3] / 255;
    out[i] = data[p + c] * a + 255 * (1 - a);
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

export interface Gradient {
  /** Gradient strength, roughly 0..255. */
  mag: Float32Array;
  /** Direction quantized to 0: along x, 1: down-right diagonal, 2: along y, 3: down-left diagonal. */
  dir: Uint8Array;
}

/**
 * Sobel gradient over several channels; per pixel the strongest channel wins.
 * With R, G and B this also finds borders between colors of similar brightness.
 */
export function gradient(channels: Float32Array[], w: number, h: number): Gradient {
  const mag = new Float32Array(w * h);
  const dir = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let best = -1, gx = 0, gy = 0;
      for (const c of channels) {
        const dx = c[i - w + 1] + 2 * c[i + 1] + c[i + w + 1] - (c[i - w - 1] + 2 * c[i - 1] + c[i + w - 1]);
        const dy = c[i + w - 1] + 2 * c[i + w] + c[i + w + 1] - (c[i - w - 1] + 2 * c[i - w] + c[i - w + 1]);
        const m = dx * dx + dy * dy;
        if (m > best) {
          best = m;
          gx = dx;
          gy = dy;
        }
      }
      mag[i] = Math.sqrt(best) / 4;
      let angle = (Math.atan2(gy, gx) * 180) / Math.PI;
      if (angle < 0) angle += 180;
      dir[i] = angle < 22.5 || angle >= 157.5 ? 0 : angle < 67.5 ? 1 : angle < 112.5 ? 2 : 3;
    }
  }
  return { mag, dir };
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
 * Canny edge detection (non-maximum suppression, hysteresis) on a precomputed gradient.
 * The thresholds adapt to the image: the strongest `detail` % of gradients start lines.
 * Returns 1 for edge pixels.
 */
export function canny({ mag, dir }: Gradient, w: number, h: number, detail: number): Uint8Array {
  const n = w * h;
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

/** Shrinks a mask by a disk of the given diameter. */
export function erode(mask: Uint8Array, w: number, h: number, width: number): Uint8Array {
  const grown = dilate(mask.map((v) => 1 - v), w, h, width);
  return grown.map((v) => 1 - v);
}

/** Foreground mask from the alpha channel (1 = opaque), or null if the image has no transparent pixels. */
export function alphaMask(img: RgbaImage): Uint8Array | null {
  const n = img.width * img.height;
  const fg = new Uint8Array(n);
  let transparent = false;
  for (let i = 0; i < n; i++) {
    if (img.data[i * 4 + 3] >= 128) fg[i] = 1;
    else transparent = true;
  }
  return transparent ? fg : null;
}

/**
 * Closed outline around a foreground mask, `width` px wide. The mask is smoothed first, so the
 * outline doesn't follow its pixel steps. The image border is not outlined: there the Pokémon is
 * cut off by the art window, whose frame the template draws.
 */
export function silhouette(fg: Uint8Array, w: number, h: number, width: number): Uint8Array {
  const soft = blur(Float32Array.from(fg), w, h, 3);
  const inside = (i: number) => soft[i] >= 0.5;
  const edge = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!inside(i)) continue;
      if ((x > 0 && !inside(i - 1)) || (x < w - 1 && !inside(i + 1)) || (y > 0 && !inside(i - w)) || (y < h - 1 && !inside(i + w))) {
        edge[i] = 1;
      }
    }
  }
  return dilate(edge, w, h, width);
}

/** Outline width for a given interior line width: a bolder outer line makes the figure read clearly. */
export const outlineWidth = (lineWidth: number) => lineWidth + 2;

/**
 * Converts an image to a line-art mask: 1 = black line, 0 = white.
 * If the image has a transparent background (Pokémon cut out), the Pokémon gets a smooth closed
 * outline from the alpha mask, and edges are only detected inside it.
 */
export function lineArt(img: RgbaImage, s: LineArtSettings): Uint8Array {
  const { width: w, height: h } = img;
  const channels = ([0, 1, 2] as const).map((c) => blur(toChannel(img, c), w, h, s.blur));
  const edges = canny(gradient(channels, w, h), w, h, s.detail);
  const fg = alphaMask(img);
  if (!fg) {
    removeSpeckles(edges, w, h, s.minSpeckle);
    return dilate(edges, w, h, s.lineWidth);
  }
  // Drop edges near the silhouette: the cutout's edge itself and the artist's ink outline just
  // inside it would otherwise run as a second, wobbly line beside the outline.
  const outline = outlineWidth(s.lineWidth);
  const inner = erode(fg, w, h, 2 * (outline + s.blur) + 1);
  for (let i = 0; i < edges.length; i++) edges[i] &= inner[i];
  removeSpeckles(edges, w, h, s.minSpeckle);
  const lines = dilate(edges, w, h, s.lineWidth);
  const ring = silhouette(fg, w, h, outline);
  for (let i = 0; i < lines.length; i++) lines[i] |= ring[i];
  return lines;
}

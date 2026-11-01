// Coloring-book line art for a cut-out Pokémon (docs/LINE_ART.md): bold outline from the mask, the artist's
// ink lines, borders between color areas, cleaned up into closed areas and drawn as smooth strokes.
// Ported from the prototype scripts/lineart.py; lengths there are in source px (9 px ≈ 1 mm), here `U`.
import { CARD_W } from './template';
import { blur, outlineWidth, removeSpeckles, type LineArtSettings, type RgbaImage } from './lineart';
import { RegionGraph, slic, smoothLabels } from './regions';
import {
  clearBorder,
  closeGaps,
  closeToOutline,
  prune,
  removeDangling,
  smoothPath,
  thin,
  tracePaths,
  type Point,
} from './skeleton';

/** Working resolution = artwork × K. */
const K = 2;
/** Artwork px per mm on the printed card (63 mm wide). */
const PX_PER_MM = CARD_W / 63;
/** Working px per prototype source px (1/9 mm). */
const U = (K * PX_PER_MM) / 9;

/** Lightness counts less than hue/chroma: shading should not split an area. */
const L_WEIGHT = 0.45;
/** Regions darker than this and smaller than PUPIL_MAX_AREA of the Pokémon are filled black (pupils). */
const PUPIL_MAX_L = 28;
const PUPIL_MAX_AREA = 0.02;
/** Ink score at or above which art counts as inked (drawn lines) rather than soft painted. */
export const INKED_MIN = 0.045;

export interface ColoringParams {
  /** Neighbors merge across borders weaker than this (≈ weighted Lab difference per 1/9 mm). */
  colorMerge: number;
  /** Regions smaller than this (in (1/9 mm)²) merge into their closest neighbor. */
  minArea: number;
  /** Ink strokes shorter than this (1/9 mm) are dropped. */
  minInk: number;
  /** Interior stroke width in artwork px; the outline is outlineWidth() of it. */
  lineWidth: number;
}

/**
 * Maps the line-art sliders onto the coloring pipeline: "Detail" moves between the prototype's
 * simple (detail ≤ 10) and detailed (detail ≥ 14) presets, line width is used as is.
 */
export function coloringParams(s: LineArtSettings): ColoringParams {
  const t = Math.min(Math.max((s.detail - 10) / 4, 0), 1);
  const lerp = (simple: number, detailed: number) => simple + (detailed - simple) * t;
  return {
    colorMerge: lerp(9, 6),
    minArea: Math.exp(lerp(Math.log(900), Math.log(250))),
    minInk: lerp(30, 12),
    lineWidth: s.lineWidth,
  };
}

// ---------- image helpers ----------

/** Box radius for blur() (three box passes) that approximates a Gaussian of the given sigma. */
const boxRadius = (sigma: number) => Math.max(1, Math.round(Math.sqrt(sigma * sigma + 0.25) - 0.5));

/** Chamfer (3-4) distance of every pixel to the nearest set pixel of `src`, in px. */
export function distanceTo(src: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = src[i] ? 0 : 1e9;
  const a = 1, b = 1.4142;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      if (y > 0) {
        v = Math.min(v, d[i - w] + a);
        if (x > 0) v = Math.min(v, d[i - w - 1] + b);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + b);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + a);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + a);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + b);
        if (x > 0) v = Math.min(v, d[i + w - 1] + b);
      }
      d[i] = v;
    }
  }
  return d;
}

// Plain loops: typed-array from()/map() with callbacks are many times slower on megapixel images.

/** 1 where dist ≤ r (and `also` is set, if given). */
function within(dist: Float32Array, r: number, also?: Uint8Array): Uint8Array {
  const out = new Uint8Array(dist.length);
  for (let i = 0; i < out.length; i++) out[i] = dist[i] <= r && (!also || also[i]) ? 1 : 0;
  return out;
}

/** 1 where dist > r and `also` is set: the mask shrunk by r when dist is the distance to its outside. */
function beyond(dist: Float32Array, r: number, also: Uint8Array): Uint8Array {
  const out = new Uint8Array(dist.length);
  for (let i = 0; i < out.length; i++) out[i] = dist[i] > r && also[i] ? 1 : 0;
  return out;
}

function invert(m: Uint8Array): Uint8Array {
  const out = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) out[i] = 1 - m[i];
  return out;
}

function or(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] | b[i];
  return out;
}

/** Sliding max (or min) over 2r+1 px along rows or columns, O(n) with a monotonic deque. */
function slide(src: Float32Array, w: number, h: number, r: number, max: boolean, vertical: boolean): Float32Array {
  const out = new Float32Array(src.length);
  const [len, lines, stride, lineStride] = vertical ? [h, w, w, 1] : [w, h, 1, w];
  const q = new Int32Array(len);
  const better = (a: number, b: number) => (max ? a >= b : a <= b);
  for (let l = 0; l < lines; l++) {
    const base = l * lineStride;
    let head = 0, tail = 0;
    for (let k = 0; k < len + r; k++) {
      if (k < len) {
        const v = src[base + k * stride];
        while (tail > head && better(v, src[base + q[tail - 1] * stride])) tail--;
        q[tail++] = k;
      }
      const c = k - r;
      if (c < 0) continue;
      while (q[head] < c - r) head++;
      out[base + c * stride] = src[base + q[head] * stride];
    }
  }
  return out;
}

/** Morphological closing of a single-channel image with a (2r+1)² square. */
function closing(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const dil = slide(slide(src, w, h, r, true, false), w, h, r, true, true);
  return slide(slide(dil, w, h, r, false, false), w, h, r, false, true);
}

/** Edge-preserving smoothing (bilateral filter) of RGB; removes print raster and texture. */
function bilateral(img: RgbaImage, radius: number, sigmaSpace: number, sigmaColor: number): Float32Array {
  const { width: w, height: h, data } = img;
  const out = new Float32Array(w * h * 3);
  const space: number[] = [];
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) space.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigmaSpace ** 2)));
  const colorLut = Float32Array.from({ length: 3 * 255 * 255 + 1 }, (_, d) => Math.exp(-d / (2 * sigmaColor ** 2)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const r0 = data[p], g0 = data[p + 1], b0 = data[p + 2];
      let sr = 0, sg = 0, sb = 0, sum = 0, k = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = Math.min(Math.max(y + dy, 0), h - 1);
        for (let dx = -radius; dx <= radius; dx++, k++) {
          const q = (yy * w + Math.min(Math.max(x + dx, 0), w - 1)) * 4;
          const dr = data[q] - r0, dg = data[q + 1] - g0, db = data[q + 2] - b0;
          const wgt = space[k] * colorLut[dr * dr + dg * dg + db * db];
          sr += data[q] * wgt;
          sg += data[q + 1] * wgt;
          sb += data[q + 2] * wgt;
          sum += wgt;
        }
      }
      const o = (y * w + x) * 3;
      out[o] = sr / sum;
      out[o + 1] = sg / sum;
      out[o + 2] = sb / sum;
    }
  }
  return out;
}

/** Bilinear upscaling of an interleaved image with `c` channels by an integer factor. */
function upscale(src: Float32Array, w: number, h: number, c: number, k: number): Float32Array {
  const W = w * k, H = h * k;
  const out = new Float32Array(W * H * c);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(Math.max((y + 0.5) / k - 0.5, 0), h - 1);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, h - 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(Math.max((x + 0.5) / k - 0.5, 0), w - 1);
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, w - 1), tx = fx - x0;
      for (let ch = 0; ch < c; ch++) {
        const top = src[(y0 * w + x0) * c + ch] * (1 - tx) + src[(y0 * w + x1) * c + ch] * tx;
        const bottom = src[(y1 * w + x0) * c + ch] * (1 - tx) + src[(y1 * w + x1) * c + ch] * tx;
        out[(y * W + x) * c + ch] = top * (1 - ty) + bottom * ty;
      }
    }
  }
  return out;
}

/** sRGB (0..255, interleaved) → CIELAB (D65), in place. */
export function rgbToLab(px: Float32Array): Float32Array {
  const lin = (v: number) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  for (let i = 0; i < px.length; i += 3) {
    const r = lin(px[i]), g = lin(px[i + 1]), b = lin(px[i + 2]);
    const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
    const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    px[i] = 116 * fy - 16;
    px[i + 1] = 500 * (fx - fy);
    px[i + 2] = 200 * (fy - fz);
  }
  return px;
}

/** Labels 4-connected components of a mask; returns labels (0 = none) and their sizes (index = label). */
function components(mask: Uint8Array, w: number, h: number) {
  const labels = new Int32Array(w * h);
  const sizes = [0];
  const stack = new Int32Array(w * h);
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || labels[s]) continue;
    const label = sizes.length;
    let sp = 0, size = 0;
    labels[s] = label;
    stack[sp++] = s;
    while (sp > 0) {
      const i = stack[--sp];
      size++;
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1]) {
        if (j >= 0 && mask[j] && !labels[j]) {
          labels[j] = label;
          stack[sp++] = j;
        }
      }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

// ---------- pipeline ----------

/** Working-resolution data shared by the ink score and the coloring pipeline. */
interface Prepared {
  w: number;
  h: number;
  /** CIELAB, interleaved. */
  lab: Float32Array;
  /** Smoothed Pokémon mask; the outermost pixel ring is always empty. */
  mask: Uint8Array;
}

function prepare(img: RgbaImage, fg: Uint8Array): Prepared {
  const { width, height } = img;
  const w = width * K, h = height * K;
  const smooth = bilateral(img, 4, (2 * U) / K, 30);
  const lab = rgbToLab(upscale(smooth, width, height, 3, K));
  // Blur the mask edge before thresholding, so the silhouette is round instead of pixel steps.
  const alpha = blur(upscale(Float32Array.from(fg), width, height, 1, K), w, h, boxRadius(1.2 * U));
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = alpha[i] >= 0.5 ? 1 : 0;
  clearBorder(mask, w, h);
  return { w, h, lab, mask };
}

/** Dark thin lines (the artist's ink) inside the mask; strokes below minLen (1/9 mm) are dropped. */
function inkLines({ w, h, lab, mask }: Prepared, minLen: number): Uint8Array {
  const n = w * h;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = lab[i * 3];
  const closed = closing(L, w, h, Math.round(2.5 * U));
  const strong = new Uint8Array(n), weak = new Uint8Array(n);
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const tophat = closed[i] - L[i]; // black top-hat: how much darker than its surroundings
    const chroma = Math.hypot(lab[i * 3 + 1], lab[i * 3 + 2]);
    if (tophat > 18 && L[i] < 55) {
      strong[i] = 1;
      stack.push(i);
    } else if (tophat > 9 && L[i] < 65 && chroma < 45) {
      weak[i] = 1;
    }
  }
  // Hysteresis: weak pixels count if connected to strong ones.
  while (stack.length) {
    const i = stack.pop()!;
    for (const d of [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1]) {
      if (weak[i + d]) {
        weak[i + d] = 0;
        strong[i + d] = 1;
        stack.push(i + d);
      }
    }
  }
  removeSpeckles(strong, w, h, Math.round(minLen * U * U) + 1);
  return strong;
}

/**
 * Share of the Pokémon's interior covered by ink lines. Inked art (drawn outlines) scores ≥ INKED_MIN;
 * soft painted or 3D-rendered art scores lower and doesn't give good line art.
 */
export function inkScore(img: RgbaImage, fg: Uint8Array): number {
  const p = prepare(img, fg);
  return inkScoreOf(p, inkLines(p, 12));
}

function inkScoreOf(p: Prepared, ink: Uint8Array): number {
  const inner = beyond(distanceTo(invert(p.mask), p.w, p.h), 4 * U, p.mask);
  let area = 0, inked = 0;
  for (let i = 0; i < inner.length; i++) {
    area += inner[i];
    inked += inner[i] & ink[i];
  }
  return area ? inked / area : 0;
}

/** Replaces masked pixels by the average of their known neighbors, layer by layer from the outside in. */
function inpaint(lab: Float32Array, hole: Uint8Array, w: number, h: number): Float32Array {
  const out = lab.slice();
  const known = invert(hole);
  let front: number[] = [];
  const offsets = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
  const inside = (j: number) => j >= 0 && j < w * h;
  for (let i = 0; i < hole.length; i++) if (hole[i] && offsets.some((d) => inside(i + d) && known[i + d])) front.push(i);
  while (front.length) {
    const values = front.map((i) => {
      const s = [0, 0, 0];
      let n = 0;
      for (const d of offsets) {
        const j = i + d;
        if (!inside(j) || !known[j]) continue;
        s[0] += out[j * 3];
        s[1] += out[j * 3 + 1];
        s[2] += out[j * 3 + 2];
        n++;
      }
      return s.map((v) => v / n);
    });
    front.forEach((i, k) => {
      out.set(values[k], i * 3);
      known[i] = 1;
    });
    const next = new Set<number>();
    for (const i of front) for (const d of offsets) if (inside(i + d) && !known[i + d]) next.add(i + d);
    front = [...next];
  }
  return out;
}

/** Flat color areas and small dark areas to fill black (pupils). */
function colorRegions(p: Prepared, ink: Uint8Array, params: ColoringParams) {
  const { w, h, mask } = p;
  const n = w * h;
  // Paint the ink out first, so ink lines don't become thin regions of their own.
  const lab = inpaint(p.lab, within(distanceTo(ink, w, h), 1.5), w, h);
  let area = 0;
  for (const v of mask) area += v;
  const labels = slic(lab, mask, w, h, Math.max(50, area / (7 * U) ** 2));

  // Border strength: color gradient with lightness weighted down.
  const r = boxRadius(0.7 * U);
  const feat = [0, 1, 2].map((c) => {
    const f = new Float32Array(n);
    const weight = c ? 1 : L_WEIGHT;
    for (let i = 0; i < n; i++) f[i] = lab[i * 3 + c] * weight;
    return blur(f, w, h, r);
  });
  const strength = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let s = 0;
      for (const f of feat) {
        const gx = f[i - w + 1] + 2 * f[i + 1] + f[i + w + 1] - f[i - w - 1] - 2 * f[i - 1] - f[i + w - 1];
        const gy = f[i + w - 1] + 2 * f[i + w] + f[i + w + 1] - f[i - w - 1] - 2 * f[i - w] - f[i - w + 1];
        s += gx * gx + gy * gy;
      }
      strength[i] = (Math.sqrt(s) / 8) * U; // ≈ color difference per 1/9 mm
    }
  }
  const graph = new RegionGraph(labels, strength, w, h);
  graph.mergeWeak(params.colorMerge);

  // Small dark enclosed regions → filled black. Decided before merging by size.
  const merged = graph.result();
  const count = graph.area.length;
  const sumL = new Float64Array(count), size = new Float64Array(count);
  const touchesBg = new Uint8Array(count);
  const nearBg = within(distanceTo(invert(mask), w, h), 1.5);
  for (let i = 0; i < n; i++) {
    sumL[merged[i]] += lab[i * 3];
    size[merged[i]]++;
    if (nearBg[i]) touchesBg[merged[i]] = 1;
  }
  const isBlack = new Uint8Array(count);
  for (let l = 1; l < count; l++) {
    const s = size[l];
    if (s > (2 * U) ** 2 && s < PUPIL_MAX_AREA * area && sumL[l] / s < PUPIL_MAX_L && !touchesBg[l]) isBlack[l] = 1;
  }
  graph.mergeSmall(params.minArea * U * U, (l) => isBlack[l] === 1);
  const final = smoothLabels(graph.result(), mask, w, h, boxRadius(1.5 * U));
  const black = new Uint8Array(n);
  for (let i = 0; i < n; i++) black[i] = isBlack[final[i]];
  return { labels: final, black };
}

/** Polylines (working px) of the interior lines, the silhouette, and the black fill mask. */
function lineDrawing(p: Prepared, params: ColoringParams) {
  const { w, h, mask } = p;
  const n = w * h;
  const ink = inkLines(p, params.minInk);
  const { labels, black } = colorRegions(p, ink, params);

  const inner = beyond(distanceTo(invert(mask), w, h), 4.5 * U, mask);
  let lines = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = labels[i];
      const border = l && (labels[i - 1] !== l || labels[i + 1] !== l || labels[i - w] !== l || labels[i + w] !== l);
      lines[i] = (ink[i] || border) && inner[i] && !black[i] ? 1 : 0;
    }
  }
  // An ink line and a region border usually lie side by side: merge them into one stroke.
  lines = within(distanceTo(lines, w, h), U, mask);
  let sk = prune(thin(lines, w, h), w, h, Math.round(4 * U));

  // Silhouette edge (not along the image border, where the Pokémon is cut off by the art window).
  const edge = new Uint8Array(n);
  for (let y = 3; y < h - 3; y++) {
    for (let x = 3; x < w - 3; x++) {
      const i = y * w + x;
      if (mask[i] && (!mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w])) edge[i] = 1;
    }
  }
  const blackRing = within(distanceTo(black, w, h), 1.5, invert(black));
  const back = Math.round(3 * U);
  sk = closeGaps(sk, or(edge, blackRing), w, 8 * U, back);
  sk = closeToOutline(sk, edge, w, 14 * U, 4 * U, back);
  const anchors = within(distanceTo(or(edge, black), w, h), 3 * U);
  for (let k = 0; k < 2; k++) sk = removeDangling(sk, w, Math.round(6 * U), anchors);
  sk = thin(sk, w, h);
  removeSpeckles(sk, w, h, Math.round(8 * U) + 1);

  const interior = tracePaths(sk, w).map((pts) => smoothPath(pts, 1.5 * U, isClosed(pts)));
  const outline = tracePaths(thin(edge, w, h), w).map((pts) => smoothPath(pts, 2 * U, isClosed(pts)));
  return { interior, outline, black };
}

const isClosed = (pts: Point[]) => pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];

// ---------- rendering ----------

/** Draws a polyline as an anti-aliased stroke of the given width into a darkness map (0..1), keeping the max. */
export function strokePath(dark: Float32Array, w: number, h: number, pts: Point[], width: number) {
  const r = width / 2;
  for (let k = 0; k < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[Math.min(k + 1, pts.length - 1)];
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r + 1));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r + 1));
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = len2 ? Math.min(Math.max(((x - ax) * dx + (y - ay) * dy) / len2, 0), 1) : 0;
        const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
        const cover = Math.min(Math.max(r + 0.5 - d, 0), 1);
        const i = y * w + x;
        if (cover > dark[i]) dark[i] = cover;
      }
    }
  }
}

/**
 * Fills areas that are too small (< 1 mm²) or too narrow (< 0.5 mm) to color with black, like coloring
 * books do with tiny gaps between lines. Works on the final darkness map (0..255), in place.
 */
export function fillCrumbs(dark: Uint8Array, fg: Uint8Array, w: number, h: number) {
  const space = new Uint8Array(dark.length);
  for (let i = 0; i < space.length; i++) space[i] = dark[i] < 128 && fg[i] ? 1 : 0;
  const { labels, sizes } = components(space, w, h);
  const dist = distanceTo(invert(space), w, h);
  const widest = new Float32Array(sizes.length);
  for (let i = 0; i < labels.length; i++) if (labels[i]) widest[labels[i]] = Math.max(widest[labels[i]], 2 * dist[i]);
  const crumb = PX_PER_MM ** 2, minWidth = 0.5 * PX_PER_MM;
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l && (sizes[l] < crumb || widest[l] < minWidth)) dark[i] = 255;
  }
}

/**
 * Coloring-book line art of the Pokémon (fg = 1) in an artwork image, at the image's size.
 * Returns darkness per pixel (0 = white, 255 = black), anti-aliased. Pixels outside the Pokémon stay white.
 */
export function coloring(img: RgbaImage, fg: Uint8Array, params: ColoringParams): Uint8Array {
  return draw(prepare(img, fg), img.width, img.height, fg, params);
}

function draw(p: Prepared, w: number, h: number, fg: Uint8Array, params: ColoringParams): Uint8Array {
  const { interior, outline, black } = lineDrawing(p, params);
  const dark = new Float32Array(w * h);
  // Black fills: smooth the edge, then average down to the artwork size.
  const soft = blur(Float32Array.from(black), p.w, p.h, boxRadius(0.7 * U));
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) if (soft[y * p.w + x] > 0.5) dark[Math.floor(y / K) * w + Math.floor(x / K)] += 1 / (K * K);
  // Working px centers map to artwork coordinates (x + 0.5) / K - 0.5.
  const toArt = (pts: Point[]) => pts.map(([x, y]) => [(x + 0.5) / K - 0.5, (y + 0.5) / K - 0.5] as Point);
  for (const pts of interior) strokePath(dark, w, h, toArt(pts), params.lineWidth);
  for (const pts of outline) strokePath(dark, w, h, toArt(pts), outlineWidth(params.lineWidth));
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.min(dark[i], 1) * 255);
  fillCrumbs(out, fg, w, h);
  return out;
}

/** Ink score and coloring in one pass (shares the preprocessing). */
export function analyze(img: RgbaImage, fg: Uint8Array, params?: ColoringParams): { inkScore: number; lines?: Uint8Array } {
  if (!params) return { inkScore: inkScore(img, fg) };
  const p = prepare(img, fg);
  return { inkScore: inkScoreOf(p, inkLines(p, 12)), lines: draw(p, img.width, img.height, fg, params) };
}

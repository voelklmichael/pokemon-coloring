import { describe, expect, it } from 'vitest';
import { coloring, coloringParams, fillCrumbs, inkScore, rgbToLab, strokePath } from '../src/coloring';
import { DEFAULT_LINE_ART, PRESETS, type RgbaImage } from '../src/lineart';
import { MinHeap, RegionGraph, slic } from '../src/regions';
import { closeGaps, endpoints, prune, smoothPath, thin, tracePaths } from '../src/skeleton';

const count = (mask: ArrayLike<number>) => Array.from(mask).reduce((sum, v) => sum + (v ? 1 : 0), 0);

/** w×h image, color per pixel from `paint` (RGB), opaque where `inside`, transparent elsewhere. */
function image(w: number, h: number, paint: (x: number, y: number) => [number, number, number] | null): { img: RgbaImage; fg: Uint8Array } {
  const data = new Uint8ClampedArray(w * h * 4);
  const fg = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = paint(x, y);
      if (!c) continue;
      data.set([...c, 255], (y * w + x) * 4);
      fg[y * w + x] = 1;
    }
  }
  return { img: { width: w, height: h, data }, fg };
}

/** Pixels reachable from `start` through values below 128 (4-connected). */
function reach(dark: Uint8Array, w: number, h: number, start: number): Uint8Array {
  const seen = new Uint8Array(w * h);
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j >= 0 && j < w * h && !seen[j] && dark[j] < 128) {
        seen[j] = 1;
        stack.push(j);
      }
    }
  }
  return seen;
}

describe('skeleton', () => {
  it('thins a thick bar to a 1 px line', () => {
    const w = 30, h = 11;
    const mask = new Uint8Array(w * h);
    for (let y = 3; y < 8; y++) for (let x = 3; x < 27; x++) mask[y * w + x] = 1;
    const sk = thin(mask, w, h);
    for (let x = 6; x < 24; x++) expect(count([3, 4, 5, 6, 7].map((y) => sk[y * w + x]))).toBe(1);
    expect(endpoints(sk, w)).toHaveLength(2);
  });

  it('prunes short spurs but keeps long lines', () => {
    const w = 40, h = 20;
    const sk = new Uint8Array(w * h);
    for (let x = 2; x < 38; x++) sk[10 * w + x] = 1; // long line
    for (let y = 7; y < 10; y++) sk[y * w + 20] = 1; // 3 px spur
    const out = prune(sk, w, h, 5);
    expect(out[8 * w + 20]).toBe(0);
    expect(out[10 * w + 3]).toBe(1);
    expect(out[10 * w + 36]).toBe(1);
  });

  it('closes a small gap in the direction of the line', () => {
    const w = 40, h = 10;
    const sk = new Uint8Array(w * h);
    for (let x = 2; x < 18; x++) sk[5 * w + x] = 1;
    for (let x = 22; x < 38; x++) sk[5 * w + x] = 1;
    const out = closeGaps(sk, new Uint8Array(w * h), w, 6, 3);
    for (let x = 18; x < 22; x++) expect(out[5 * w + x]).toBe(1);
  });

  it('traces a closed ring as one closed path', () => {
    const w = 30, h = 30;
    const sk = new Uint8Array(w * h);
    for (let a = 0; a < 360; a += 0.5) sk[Math.round(15 + 10 * Math.sin((a * Math.PI) / 180)) * w + Math.round(15 + 10 * Math.cos((a * Math.PI) / 180))] = 1;
    const paths = tracePaths(thin(sk, w, h), w);
    expect(paths).toHaveLength(1);
    expect(paths[0][0]).toEqual(paths[0][paths[0].length - 1]);
  });

  it('smooths a path but keeps its end points', () => {
    const pts: [number, number][] = Array.from({ length: 20 }, (_, i) => [i, i % 2]);
    const out = smoothPath(pts, 2, false);
    expect(out[0]).toEqual([0, 0]);
    expect(out[19]).toEqual([19, 1]);
    expect(Math.abs(out[10][1] - 0.5)).toBeLessThan(0.2);
  });
});

describe('regions', () => {
  it('pops in priority order', () => {
    const heap = new MinHeap<string>();
    for (const [p, v] of [[3, 'c'], [1, 'a'], [2, 'b']] as const) heap.push(p, v);
    expect([heap.pop()![1], heap.pop()![1], heap.pop()![1]]).toEqual(['a', 'b', 'c']);
  });

  it('merges superpixels across weak borders, not across strong ones', () => {
    const w = 60, h = 30;
    const lab = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) lab.set((i % w) < 30 ? [50, 60, 0] : [50, -60, 0], i * 3);
    const mask = new Uint8Array(w * h).fill(1);
    const labels = slic(lab, mask, w, h, 18);
    const strength = new Float32Array(w * h);
    for (let y = 0; y < h; y++) strength[y * w + 29] = strength[y * w + 30] = 100;
    const graph = new RegionGraph(labels, strength, w, h);
    graph.mergeWeak(20);
    const merged = graph.result();
    const side = (x0: number, x1: number) => new Set(Array.from(merged).filter((_, i) => i % w >= x0 && i % w < x1));
    expect(side(0, 26).size).toBe(1);
    expect(side(34, w).size).toBe(1);
    expect(merged[0]).not.toBe(merged[w - 1]);
  });
});

describe('rgbToLab', () => {
  it('maps white, black and red', () => {
    const lab = rgbToLab(Float32Array.from([255, 255, 255, 0, 0, 0, 255, 0, 0]));
    expect(lab[0]).toBeCloseTo(100, 0);
    expect(lab[3]).toBeCloseTo(0, 0);
    expect(lab[6]).toBeCloseTo(53.2, 0);
    expect(lab[7]).toBeCloseTo(80.1, 0);
  });
});

describe('rendering', () => {
  it('draws an anti-aliased stroke of the given width', () => {
    const w = 20, h = 10;
    const dark = new Float32Array(w * h);
    strokePath(dark, w, h, [[2, 5], [17, 5]], 3);
    expect(dark[5 * w + 10]).toBe(1);
    expect(dark[4 * w + 10]).toBe(1);
    expect(dark[2 * w + 10]).toBe(0);
  });

  it('fills areas too small to color', () => {
    const w = 60, h = 60;
    const dark = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x === 30 || (x > 30 && x < 35 && (y === 10 || y === 14)) || x === 35) dark[y * w + x] = 255;
    const fg = new Uint8Array(w * h).fill(1);
    fillCrumbs(dark, fg, w, h);
    expect(dark[12 * w + 32]).toBe(255); // 4 px wide slot between the two vertical lines: too narrow
    expect(dark[12 * w + 10]).toBe(0); // large area on the left
  });
});

describe('coloring', () => {
  const params = coloringParams({ ...DEFAULT_LINE_ART, ...PRESETS.detailed });
  const w = 160, h = 120;

  it('outlines a flat shape with a closed line and leaves a shading gradient alone', () => {
    // Orange ellipse whose lightness changes smoothly from left to right (shading).
    const { img, fg } = image(w, h, (x, y) => (((x - 80) / 60) ** 2 + ((y - 60) / 45) ** 2 <= 1 ? [230 - x / 2, 130 - x / 4, 40] : null));
    const dark = coloring(img, fg, params);
    const inside = reach(dark, w, h, 60 * w + 80);
    expect(inside[0]).toBe(0); // closed outline
    expect(inside[60 * w + 40]).toBe(1); // no line across the gradient
    expect(inside[60 * w + 120]).toBe(1);
  });

  it('separates two flat colors with a line', () => {
    const { img, fg } = image(w, h, (x, y) => (((x - 80) / 60) ** 2 + ((y - 60) / 45) ** 2 <= 1 ? (x < 80 ? [220, 60, 50] : [50, 90, 220]) : null));
    const dark = coloring(img, fg, params);
    const left = reach(dark, w, h, 60 * w + 50);
    expect(left[60 * w + 110]).toBe(0);
  });

  it('turns an inked ring into one line, not two', () => {
    const { img, fg } = image(w, h, (x, y) => {
      if (((x - 80) / 60) ** 2 + ((y - 60) / 45) ** 2 > 1) return null;
      const r = Math.hypot(x - 80, y - 60);
      return Math.abs(r - 25) < 1.5 ? [20, 20, 20] : [240, 200, 80];
    });
    const dark = coloring(img, fg, params);
    // Across the ring along the middle row: one dark run, not two.
    let runs = 0;
    for (let x = 90; x < 120; x++) if (dark[60 * w + x] >= 128 && dark[60 * w + x - 1] < 128) runs++;
    expect(runs).toBe(1);
    expect(inkScore(img, fg)).toBeGreaterThan(0);
  });

  it('scores flat art without lines as not inked', () => {
    const { img, fg } = image(w, h, (x, y) => (((x - 80) / 60) ** 2 + ((y - 60) / 45) ** 2 <= 1 ? [240, 150, 180] : null));
    expect(inkScore(img, fg)).toBe(0);
  });
});

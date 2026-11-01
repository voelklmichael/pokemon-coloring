import { describe, expect, it } from 'vitest';
import { DEFAULT_LINE_ART, type RgbaImage } from '../src/lineart';
import { artLineArt, cleanMask, fillHoles, normalizeRange, resizeBilinear, toModelInput } from '../src/mask';

const count = (mask: ArrayLike<number>) => Array.from(mask).reduce((sum, v) => sum + v, 0);

/** Probability map with filled rectangles [x0, y0, x1, y1) set to 1. */
function probMap(w: number, h: number, ...rects: [number, number, number, number][]): Float32Array {
  const out = new Float32Array(w * h);
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out[y * w + x] = 1;
  }
  return out;
}

/** Gray image with two filled squares: one "Pokémon" (left) and one "background" detail (right). */
function twoSquares(w: number, h: number): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4).fill(128);
  for (let y = 10; y < 30; y++) {
    for (let x = 0; x < w; x++) {
      const inLeft = x >= 10 && x < 30, inRight = x >= 50 && x < 70;
      if (inLeft || inRight) data.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
    }
  }
  return { width: w, height: h, data };
}

describe('toModelInput', () => {
  it('normalizes with ImageNet mean/std into planar RGB', () => {
    const out = toModelInput({ width: 1, height: 1, data: [255, 0, 255, 255] });
    expect(out[0]).toBeCloseTo((1 - 0.485) / 0.229);
    expect(out[1]).toBeCloseTo((0 - 0.456) / 0.224);
    expect(out[2]).toBeCloseTo((1 - 0.406) / 0.225);
  });
});

describe('normalizeRange', () => {
  it('rescales to 0..1', () => {
    expect(Array.from(normalizeRange(Float32Array.from([0.2, 0.4, 0.6])))).toEqual([0, expect.closeTo(0.5), 1]);
  });

  it('keeps a constant map finite', () => {
    expect(Array.from(normalizeRange(Float32Array.from([0.3, 0.3])))).toEqual([0, 0]);
  });
});

describe('resizeBilinear', () => {
  it('keeps constant images constant and interpolates in between', () => {
    expect(Array.from(resizeBilinear(Float32Array.from([1, 1, 1, 1]), 2, 2, 5, 3))).toEqual(Array(15).fill(1));
    const row = resizeBilinear(Float32Array.from([0, 1]), 2, 1, 4, 1);
    expect(row[0]).toBe(0);
    expect(row[3]).toBe(1);
    expect(row[1]).toBeGreaterThan(0);
    expect(row[1]).toBeLessThan(row[2]);
  });
});

describe('fillHoles', () => {
  it('fills enclosed background but not background touching the border', () => {
    const w = 10, h = 10;
    const ring = new Uint8Array(w * h);
    for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) ring[y * w + x] = x === 2 || x === 7 || y === 2 || y === 7 ? 1 : 0;
    fillHoles(ring, w, h);
    expect(ring[5 * w + 5]).toBe(1);
    expect(ring[0]).toBe(0);
    expect(count(ring)).toBe(36);
  });
});

describe('cleanMask', () => {
  it('drops blobs much smaller than the largest one', () => {
    const w = 100, h = 100;
    const mask = cleanMask(probMap(w, h, [20, 20, 60, 60], [80, 80, 83, 83]), w, h);
    expect(mask[40 * w + 40]).toBe(1);
    expect(mask[81 * w + 81]).toBe(0);
  });

  it('keeps several large blobs (cards with two Pokémon)', () => {
    const w = 100, h = 100;
    const mask = cleanMask(probMap(w, h, [5, 5, 40, 40], [60, 60, 90, 90]), w, h);
    expect(mask[20 * w + 20]).toBe(1);
    expect(mask[75 * w + 75]).toBe(1);
  });

  it('grows the mask by 2 px', () => {
    const w = 50, h = 50;
    const mask = cleanMask(probMap(w, h, [20, 20, 30, 30]), w, h);
    expect(mask[25 * w + 18]).toBe(1);
    expect(mask[25 * w + 16]).toBe(0);
  });

  it('returns an empty mask when nothing is found', () => {
    expect(count(cleanMask(new Float32Array(100), 10, 10))).toBe(0);
  });
});

describe('artLineArt', () => {
  const w = 80, h = 40;
  const img = twoSquares(w, h);
  const foreground = cleanMask(probMap(w, h, [5, 5, 35, 35]), w, h);
  const linesIn = (lines: Uint8Array, x0: number, x1: number) => {
    let n = 0;
    for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) n += lines[y * w + x];
    return n;
  };

  it('keeps everything without a mask or with "keep"', () => {
    const lines = artLineArt(img, DEFAULT_LINE_ART, 'remove');
    expect(linesIn(lines, 45, 75)).toBeGreaterThan(0);
    expect(artLineArt(img, DEFAULT_LINE_ART, 'keep', foreground)).toEqual(lines);
  });

  it('removes lines outside the Pokémon with "remove"', () => {
    const lines = artLineArt(img, DEFAULT_LINE_ART, 'remove', foreground);
    expect(linesIn(lines, 0, 40)).toBeGreaterThan(0);
    expect(linesIn(lines, 45, 75)).toBe(0);
  });

  it('keeps the Pokémon unchanged and thins the background with "fade"', () => {
    // No speck removal: the test squares' outlines are shorter than the faded speck threshold.
    const s = { ...DEFAULT_LINE_ART, minSpeckle: 0 };
    const keep = artLineArt(img, s, 'keep');
    const fade = artLineArt(img, s, 'fade', foreground);
    expect(linesIn(fade, 0, 38)).toBe(linesIn(keep, 0, 38));
    expect(linesIn(fade, 45, 75)).toBeGreaterThan(0);
    expect(linesIn(fade, 45, 75)).toBeLessThan(linesIn(keep, 45, 75));
  });
});

import { describe, expect, it } from 'vitest';
import { canny, dilate, gradient, lineArt, removeSpeckles, toGray, DEFAULT_LINE_ART, type RgbaImage } from '../src/lineart';

/** White image with a black filled rectangle. */
function rectImage(w: number, h: number, x0: number, y0: number, x1: number, y1: number): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * w + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = 0;
    }
  }
  return { width: w, height: h, data };
}

const count = (mask: Uint8Array) => mask.reduce((sum, v) => sum + v, 0);

describe('toGray', () => {
  it('composites transparent pixels onto white', () => {
    const img = { width: 1, height: 1, data: [0, 0, 0, 0] };
    expect(toGray(img)[0]).toBe(255);
  });
});

describe('canny', () => {
  it('finds the outline of a filled rectangle, not its inside', () => {
    const w = 40, h = 40;
    const mask = canny(gradient([toGray(rectImage(w, h, 10, 10, 30, 30))], w, h), w, h, 10);
    expect(mask[20 * w + 20]).toBe(0); // center of the rectangle
    expect(mask[2 * w + 2]).toBe(0); // background
    // some edge pixel on the left border column
    expect(mask[20 * w + 9] || mask[20 * w + 10]).toBe(1);
    // outline only: roughly the perimeter, far less than the filled area
    expect(count(mask)).toBeLessThan(200);
    expect(count(mask)).toBeGreaterThan(60);
  });
});

describe('removeSpeckles', () => {
  it('removes small components and keeps large ones', () => {
    const w = 10, h = 3;
    const mask = new Uint8Array(w * h);
    mask[0] = 1; // single speck
    for (let x = 3; x < 10; x++) mask[w + x] = 1; // 7 px line
    removeSpeckles(mask, w, h, 5);
    expect(mask[0]).toBe(0);
    expect(count(mask)).toBe(7);
  });
});

describe('dilate', () => {
  it('grows a single pixel into a disk', () => {
    const w = 7, h = 7;
    const mask = new Uint8Array(w * h);
    mask[3 * w + 3] = 1;
    expect(count(dilate(mask, w, h, 1))).toBe(1);
    const grown = dilate(mask, w, h, 3);
    expect(count(grown)).toBe(9);
    expect(grown[2 * w + 2]).toBe(1);
  });
});

describe('lineArt', () => {
  it('finds borders between colors of equal brightness', () => {
    // red and green halves with nearly identical luminance
    const w = 40, h = 40;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set(i % w < 20 ? [200, 60, 60, 255] : [60, 135, 60, 255], i * 4);
    const img = { width: w, height: h, data };
    const gray = toGray(img);
    expect(Math.abs(gray[0] - gray[w - 1])).toBeLessThan(5);
    const mask = lineArt(img, { ...DEFAULT_LINE_ART, minSpeckle: 0, lineWidth: 1 });
    expect(mask[20 * w + 19] || mask[20 * w + 20]).toBe(1);
    expect(mask[20 * w + 5]).toBe(0);
  });
});

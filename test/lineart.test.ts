import { describe, expect, it } from 'vitest';
import {
  alphaMask, canny, dilate, erode, gradient, lineArt, removeSpeckles, silhouette, toGray, DEFAULT_LINE_ART, type RgbaImage,
} from '../src/lineart';

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

/** Transparent image with an opaque colored disk; `inner` paints a smaller dark disk inside it. */
function diskImage(w: number, h: number, cx: number, cy: number, r: number, inner = 0): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r) data.set(d <= inner ? [30, 30, 30, 255] : [220, 120, 40, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

/** Pixels reachable from `start` without crossing the mask (4-connected). */
function floodFill(mask: Uint8Array, w: number, h: number, start: number): Uint8Array {
  const seen = new Uint8Array(w * h);
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j >= 0 && j < w * h && !seen[j] && !mask[j]) {
        seen[j] = 1;
        stack.push(j);
      }
    }
  }
  return seen;
}

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

  it('outlines a cut-out shape and keeps details inside it, but not edges next to the outline', () => {
    const w = 120, h = 120;
    const s = { ...DEFAULT_LINE_ART, minSpeckle: 0 };
    const mask = lineArt(diskImage(w, h, 60, 60, 50, 15), s);
    expect(floodFill(mask, w, h, 60 * w + 60)[0]).toBe(0); // closed outline
    expect(mask[60 * w + 45] || mask[60 * w + 44] || mask[60 * w + 46]).toBe(1); // inner dark disk's edge
    expect(count(mask.slice(60 * w + 15, 60 * w + 25))).toBe(0); // just inside the outline: empty
  });
});

describe('erode', () => {
  it('shrinks a filled square', () => {
    const w = 9, h = 9;
    const mask = new Uint8Array(w * h);
    for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) mask[y * w + x] = 1;
    const out = erode(mask, w, h, 3);
    expect(count(out)).toBe(9);
    expect(out[4 * w + 4]).toBe(1);
    expect(out[2 * w + 2]).toBe(0);
  });
});

describe('alphaMask', () => {
  it('is null for opaque images', () => {
    expect(alphaMask(rectImage(4, 4, 1, 1, 3, 3))).toBeNull();
  });

  it('marks opaque pixels', () => {
    const fg = alphaMask(diskImage(20, 20, 10, 10, 5))!;
    expect(fg[10 * 20 + 10]).toBe(1);
    expect(fg[0]).toBe(0);
  });
});

describe('silhouette', () => {
  it('is a closed ring around the shape', () => {
    const w = 60, h = 60;
    const ring = silhouette(alphaMask(diskImage(w, h, 30, 30, 20))!, w, h, 5);
    expect(ring[30 * w + 30]).toBe(0);
    expect(ring[30 * w + 10] || ring[30 * w + 11]).toBe(1);
    expect(floodFill(ring, w, h, 30 * w + 30)[0]).toBe(0);
  });

  it('does not outline the image border', () => {
    const w = 40, h = 40;
    const fg = new Uint8Array(w * h);
    for (let y = 10; y < 30; y++) for (let x = 0; x < 20; x++) fg[y * w + x] = 1;
    const ring = silhouette(fg, w, h, 3);
    expect(ring[20 * w]).toBe(0); // left image border, inside the shape
    expect(ring[20 * w + 19] || ring[20 * w + 20]).toBe(1); // right side of the shape
  });
});

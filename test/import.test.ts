import { describe, expect, it } from 'vitest';
import { nameFromUrl, parseUrls } from '../src/import';
import { findContentBounds } from '../src/normalize';

describe('parseUrls', () => {
  it('extracts unique http(s) links from mixed text', () => {
    const text = 'https://a.example/1.png\n  junk  http://b.example/2.jpg https://a.example/1.png';
    expect(parseUrls(text)).toEqual(['https://a.example/1.png', 'http://b.example/2.jpg']);
  });
});

describe('nameFromUrl', () => {
  it('uses the last path segments', () => {
    expect(nameFromUrl('https://images.pokemontcg.io/sv1/1_hires.png')).toBe('sv1/1_hires.png');
  });
});

describe('findContentBounds', () => {
  it('finds a card on a plain background', () => {
    const w = 20, h = 20;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const x = i % w, y = Math.floor(i / w);
      const inside = x >= 5 && x < 15 && y >= 3 && y < 17;
      data.set(inside ? [255, 255, 255, 255] : [40, 80, 40, 255], i * 4);
    }
    expect(findContentBounds({ width: w, height: h, data })).toEqual({ x: 5, y: 3, w: 10, h: 14 });
  });
});

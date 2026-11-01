import { blur, toGray, type RgbaImage } from './lineart';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Artwork window of a modern card in fractions of the card size; used when detection fails (e.g. full-art cards). */
export const DEFAULT_ART: Rect = { x: 0.077, y: 0.098, w: 0.846, h: 0.374 };

function scaleRect(r: Rect, w: number, h: number): Rect {
  return { x: Math.round(r.x * w), y: Math.round(r.y * h), w: Math.round(r.w * w), h: Math.round(r.h * h) };
}

/**
 * Finds the artwork window of a normalized card image: the strongest horizontal
 * and vertical border lines near where cards of all eras put them.
 */
export function findArtRect(img: RgbaImage): Rect {
  const { width: w, height: h } = img;
  const gray = blur(toGray(img), w, h, 1);
  const T = 12;

  // Fraction of positions along a line where the brightness changes across it.
  const rowScore = (y: number) => {
    let n = 0;
    for (let x = Math.round(0.2 * w); x < 0.8 * w; x++) {
      if (Math.abs(gray[(y + 1) * w + x] - gray[(y - 1) * w + x]) > T) n++;
    }
    return n / (0.6 * w);
  };
  const colScore = (x: number, y0: number, y1: number) => {
    let n = 0;
    for (let y = y0; y < y1; y++) if (Math.abs(gray[y * w + x + 1] - gray[y * w + x - 1]) > T) n++;
    return n / Math.max(1, y1 - y0);
  };
  const best = (from: number, to: number, score: (v: number) => number) => {
    let arg = -1, max = 0;
    for (let v = Math.round(from); v <= to; v++) {
      const s = score(v);
      if (s > max) {
        max = s;
        arg = v;
      }
    }
    return { arg, max };
  };

  const fallback = scaleRect(DEFAULT_ART, w, h);
  const top = best(0.08 * h, 0.17 * h, rowScore);
  const bottom = best(0.4 * h, 0.56 * h, rowScore);
  if (top.max < 0.6 || bottom.max < 0.6) return fallback;
  const margin = Math.round(0.1 * (bottom.arg - top.arg));
  const sideScore = (x: number) => colScore(x, top.arg + margin, bottom.arg - margin);
  const left = best(0.04 * w, 0.14 * w, sideScore);
  const right = best(0.86 * w, 0.96 * w, sideScore);
  if (left.max < 0.6 && right.max < 0.6) return fallback;
  // The art window is centered; trust the side with the clearer border.
  const inset = left.max >= right.max ? left.arg : w - 1 - right.arg;
  return { x: inset, y: top.arg, w: w - 1 - 2 * inset, h: bottom.arg - top.arg };
}

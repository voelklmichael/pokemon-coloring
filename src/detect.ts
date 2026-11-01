import { blur, type RgbaImage } from './lineart';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Artwork window of a modern card in fractions of the card size; used when detection fails (e.g. full-art cards). */
export const DEFAULT_ART: Rect = { x: 0.077, y: 0.098, w: 0.846, h: 0.374 };

export function scaleRect(r: Rect, w: number, h: number): Rect {
  return { x: Math.round(r.x * w), y: Math.round(r.y * h), w: Math.round(r.w * w), h: Math.round(r.h * h) };
}

/** Color change (largest of the R, G, B differences) that counts as an edge. */
const EDGE = 9;
/** Share of a line that must be edge for it to count as a border. */
const MIN_LINE = 0.6;
/** A line this complete close to the strongest one, on the art's side of it, is the actual art border. */
const FULL_LINE = 0.9;

/**
 * Logistic weights telling a real art window from a false one on full-art and
 * full-bleed cards (ex, GX, V, …), whose name and ability bars also form lines.
 * Fitted on the TCGdex Pokémon cards labeled by rarity and name suffix.
 */
const WINDOW_SCORE = { left: 9.69, right: 31.13, bottom: 24.44, top: 11.1, bottomInside: 9.69, inset: 34.97, bias: -82.56 };

/**
 * Finds the artwork window of a card image: the strongest horizontal and vertical
 * border lines near where cards of all eras put them. Returns null when the card
 * has no such window (full-art cards, art that runs behind the card text).
 */
export function detectArtWindow(img: RgbaImage): Rect | null {
  const { width: w, height: h, data } = img;
  const channels = [0, 1, 2].map((c) => {
    const a = new Float32Array(w * h);
    for (let i = 0, p = 0; i < a.length; i++, p += 4) {
      const alpha = data[p + 3] / 255;
      a[i] = data[p + c] * alpha + 255 * (1 - alpha);
    }
    return blur(a, w, h, 1);
  });
  const edge = (p: number, q: number) =>
    Math.abs(channels[0][p] - channels[0][q]) > EDGE ||
    Math.abs(channels[1][p] - channels[1][q]) > EDGE ||
    Math.abs(channels[2][p] - channels[2][q]) > EDGE;
  // Fraction of positions along a line where the color changes across it.
  const rowScore = (y: number, x0: number, x1: number) => {
    let n = 0;
    for (let x = x0; x < x1; x++) if (edge((y + 1) * w + x, (y - 1) * w + x)) n++;
    return n / Math.max(1, x1 - x0);
  };
  const colScore = (x: number, y0: number, y1: number) => {
    let n = 0;
    for (let y = y0; y < y1; y++) if (edge(y * w + x + 1, y * w + x - 1)) n++;
    return n / Math.max(1, y1 - y0);
  };
  const best = (from: number, to: number, score: (v: number) => number) => {
    let arg = from, max = -1;
    for (let v = Math.round(from); v <= Math.floor(to); v++) {
      const s = score(v);
      if (s > max) {
        max = s;
        arg = v;
      }
    }
    return { arg, max };
  };
  // Frames often have two lines, and newer cards an info bar under the art: move
  // from the strongest line to a complete one nearer the art, if there is one.
  const inner = (from: number, to: number, step: number, score: (v: number) => number) => {
    let found = from;
    for (let v = from + step; step > 0 ? v <= to : v >= to; v += step) if (score(v) >= FULL_LINE) found = v;
    return found;
  };

  const x0 = Math.floor(0.2 * w), x1 = Math.floor(0.8 * w);
  const row = (y: number) => rowScore(y, x0, x1);
  const top = best(0.08 * h, 0.17 * h, row);
  const bottom = best(0.4 * h, 0.56 * h, row);
  if (top.max < MIN_LINE || bottom.max < MIN_LINE) return null;
  const t = inner(top.arg, Math.min(Math.floor(top.arg + 0.03 * h), Math.floor(0.17 * h)), 1, row);
  const b = inner(bottom.arg, Math.max(Math.floor(bottom.arg - 0.035 * h), Math.round(0.4 * h)), -1, row);

  const margin = Math.floor(0.1 * (b - t));
  const col = (x: number) => colScore(x, t + margin, b - margin);
  const left = best(0.03 * w, 0.14 * w, col);
  const right = best(0.86 * w, 0.97 * w, col);
  if (left.max < MIN_LINE && right.max < MIN_LINE) return null;
  let l = inner(left.arg, Math.min(Math.floor(left.arg + 0.05 * w), Math.floor(0.14 * w)), 1, col);
  let r = inner(right.arg, Math.max(Math.ceil(right.arg - 0.05 * w), Math.round(0.86 * w)), -1, col);
  // Card images are not always centered, so use both sides when both are clear.
  if (left.max < MIN_LINE) l = w - 1 - r;
  if (right.max < MIN_LINE) r = w - 1 - l;

  let bottomInside = 0;
  for (let y = b - 2; y <= b + 2; y++) bottomInside = Math.max(bottomInside, rowScore(y, l + 4, r - 4));
  const s = WINDOW_SCORE;
  const score =
    s.left * left.max + s.right * right.max + s.bottom * bottom.max + s.top * top.max +
    s.bottomInside * bottomInside + s.inset * Math.min(l / w, (w - 1 - r) / w) + s.bias;
  if (score < 0) return null;
  return { x: l, y: t, w: r - l, h: b - t };
}

/** The artwork window of a card image, or the usual place of it when the card has none. */
export function findArtRect(img: RgbaImage): Rect {
  return detectArtWindow(img) ?? scaleRect(DEFAULT_ART, img.width, img.height);
}

import type { Rect } from './detect';
import { lineArt, type LineArtSettings } from './lineart';
import { artLineArt, type BackgroundMode } from './mask';
import type { CardStructure } from './structure';
import { ART_FRAME, CARD_H, CARD_W, drawTemplate } from './template';

/** "template": base layout with only the artwork as line art. "original": outlines of the whole card. */
export type LayoutMode = 'template' | 'original';

export interface RenderInput {
  /** Normalized card image (CARD_W × CARD_H). */
  source: HTMLCanvasElement;
  art: Rect;
  structure: CardStructure;
  /** Pokémon mask of the artwork (ART_FRAME size, from `artImage`), once computed. */
  foreground?: Uint8Array;
  /** Coloring-book line art of the Pokémon (darkness 0..255, ART_FRAME size, from src/coloring.ts), once computed. */
  coloring?: Uint8Array;
}

/** Darkness per pixel → gray image; `scale` maps the values to 0..255 (255 for 0/1 masks). */
function darknessToImageData(dark: Uint8Array, w: number, h: number, scale: number): ImageData {
  const out = new ImageData(w, h);
  for (let i = 0, p = 0; i < dark.length; i++, p += 4) {
    const v = 255 - Math.min(255, dark[i] * scale);
    out.data[p] = out.data[p + 1] = out.data[p + 2] = v;
    out.data[p + 3] = 255;
  }
  return out;
}

/** Crops the artwork (minus its border) to the frame's aspect ratio and scales it to the frame size. */
export function artImage(source: HTMLCanvasElement, art: Rect): ImageData {
  const inset = 5;
  let sx = art.x + inset, sy = art.y + inset, sw = art.w - 2 * inset, sh = art.h - 2 * inset;
  const frameRatio = ART_FRAME.w / ART_FRAME.h;
  if (sw / sh > frameRatio) {
    const cw = sh * frameRatio;
    sx += (sw - cw) / 2;
    sw = cw;
  } else {
    const ch = sw / frameRatio;
    sy += (sh - ch) / 2;
    sh = ch;
  }
  const c = document.createElement('canvas');
  c.width = ART_FRAME.w;
  c.height = ART_FRAME.h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

export function renderCard(
  target: HTMLCanvasElement,
  input: RenderInput,
  settings: LineArtSettings,
  mode: LayoutMode,
  background: BackgroundMode = 'keep',
) {
  target.width = CARD_W;
  target.height = CARD_H;
  const ctx = target.getContext('2d')!;
  if (mode === 'original') {
    const img = input.source.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, CARD_W, CARD_H);
    ctx.putImageData(darknessToImageData(lineArt(img, settings), CARD_W, CARD_H, 255), 0, 0);
    return;
  }
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  const art = artImage(input.source, input.art);
  const lines = artLineArt(art, settings, background, input.foreground);
  if (input.coloring && input.foreground && background !== 'keep') {
    // The Pokémon from the coloring pipeline; outside it the (faded or removed) background.
    const { coloring, foreground } = input;
    const dark = new Uint8Array(lines.length);
    for (let i = 0; i < dark.length; i++) dark[i] = Math.max(coloring[i], foreground[i] ? 0 : lines[i] * 255);
    ctx.putImageData(darknessToImageData(dark, art.width, art.height, 1), ART_FRAME.x, ART_FRAME.y);
  } else {
    ctx.putImageData(darknessToImageData(lines, art.width, art.height, 255), ART_FRAME.x, ART_FRAME.y);
  }
  drawTemplate(ctx, input.structure);
}

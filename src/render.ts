import type { Rect } from './detect';
import { lineArt, type LineArtSettings } from './lineart';
import type { CardStructure } from './structure';
import { ART_FRAME, CARD_H, CARD_W, drawTemplate } from './template';

/** "template": base layout with only the artwork as line art. "original": outlines of the whole card. */
export type LayoutMode = 'template' | 'original';

export interface RenderInput {
  /** Normalized card image (CARD_W × CARD_H). */
  source: HTMLCanvasElement;
  art: Rect;
  structure: CardStructure;
}

function maskToImageData(mask: Uint8Array, w: number, h: number): ImageData {
  const out = new ImageData(w, h);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const v = mask[i] ? 0 : 255;
    out.data[p] = out.data[p + 1] = out.data[p + 2] = v;
    out.data[p + 3] = 255;
  }
  return out;
}

/** Crops the artwork (minus its border) to the frame's aspect ratio and scales it to the frame size. */
function artImage(source: HTMLCanvasElement, art: Rect): ImageData {
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

export function renderCard(target: HTMLCanvasElement, input: RenderInput, settings: LineArtSettings, mode: LayoutMode) {
  target.width = CARD_W;
  target.height = CARD_H;
  const ctx = target.getContext('2d')!;
  if (mode === 'original') {
    const img = input.source.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, CARD_W, CARD_H);
    ctx.putImageData(maskToImageData(lineArt(img, settings), CARD_W, CARD_H), 0, 0);
    return;
  }
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  const art = artImage(input.source, input.art);
  ctx.putImageData(maskToImageData(lineArt(art, settings), art.width, art.height), ART_FRAME.x, ART_FRAME.y);
  drawTemplate(ctx, input.structure);
}

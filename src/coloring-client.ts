import type { ColoringParams } from './coloring';
import type { ColoringRequest, ColoringResponse } from './coloring.worker';

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, { resolve: (out: { inkScore: number; lines?: Uint8Array }) => void; reject: (err: Error) => void }>();

/**
 * Ink score and (with params) coloring-book line art of an artwork in a worker; see src/coloring.ts.
 * `lines` is darkness per pixel (0..255) at the artwork's size.
 */
export function analyzeArt(art: ImageData, foreground: Uint8Array, params?: ColoringParams): Promise<{ inkScore: number; lines?: Uint8Array }> {
  if (!worker) {
    worker = new Worker(new URL('./coloring.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<ColoringResponse>) => {
      const p = pending.get(data.id);
      pending.delete(data.id);
      if ('error' in data) p?.reject(new Error(data.error));
      else p?.resolve(data);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'line art worker failed'));
      pending.clear();
      worker = undefined;
    };
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const request: ColoringRequest = { id, width: art.width, height: art.height, data: art.data, foreground: foreground.slice(), params };
    worker!.postMessage(request);
  });
}

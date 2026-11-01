// Runs the coloring-book line art (and the ink score) off the main thread.
import { analyze, type ColoringParams } from './coloring';

export interface ColoringRequest {
  id: number;
  width: number;
  height: number;
  /** Artwork RGBA. */
  data: Uint8ClampedArray;
  /** Pokémon mask, 1 = foreground. */
  foreground: Uint8Array;
  /** Without params, only the ink score is computed. */
  params?: ColoringParams;
}

export type ColoringResponse = { id: number; inkScore: number; lines?: Uint8Array } | { id: number; error: string };

self.onmessage = ({ data }: MessageEvent<ColoringRequest>) => {
  try {
    const { inkScore, lines } = analyze({ width: data.width, height: data.height, data: data.data }, data.foreground, data.params);
    self.postMessage({ id: data.id, inkScore, lines } satisfies ColoringResponse, { transfer: lines ? [lines.buffer] : [] });
  } catch (err) {
    self.postMessage({ id: data.id, error: (err as Error).message ?? String(err) } satisfies ColoringResponse);
  }
};

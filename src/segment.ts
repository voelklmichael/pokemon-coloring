import { cleanMask, normalizeRange, resizeBilinear, toModelInput } from './mask';
import type { SegmentRequest, SegmentResponse } from './segment.worker';

/** U²-Net-p (Apache-2.0, 4.6 MB): small salient-object model; see docs/BACKGROUND_REMOVAL.md. */
const MODEL_URL = new URL(`${import.meta.env.BASE_URL}models/u2netp.onnx`, location.href).href;
const MODEL_SIZE = 320;

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, { resolve: (out: Float32Array) => void; reject: (err: Error) => void }>();

function run(input: Float32Array): Promise<Float32Array> {
  if (!worker) {
    worker = new Worker(new URL('./segment.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<SegmentResponse>) => {
      const p = pending.get(data.id);
      pending.delete(data.id);
      if ('error' in data) p?.reject(new Error(data.error));
      else p?.resolve(data.output);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'background model failed to load'));
      pending.clear();
      worker = undefined;
    };
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, modelUrl: MODEL_URL, size: MODEL_SIZE, input } satisfies SegmentRequest, [input.buffer]);
  });
}

/** Finds the Pokémon in an artwork image: 1 = foreground, 0 = background, at the image's size. */
export async function foregroundMask(art: ImageData): Promise<Uint8Array> {
  const c = new OffscreenCanvas(MODEL_SIZE, MODEL_SIZE);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  // The model takes a square image; stretching worked better than padding (see docs).
  ctx.drawImage(await createImageBitmap(art), 0, 0, MODEL_SIZE, MODEL_SIZE);
  const output = await run(toModelInput(ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE)));
  const prob = resizeBilinear(normalizeRange(output), MODEL_SIZE, MODEL_SIZE, art.width, art.height);
  return cleanMask(prob, art.width, art.height);
}

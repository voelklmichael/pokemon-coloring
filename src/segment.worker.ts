// Runs the background-removal model off the main thread.
import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

export interface SegmentRequest {
  id: number;
  modelUrl: string;
  size: number;
  /** Normalized planar RGB, 3 × size × size. */
  input: Float32Array;
}

export type SegmentResponse = { id: number; output: Float32Array } | { id: number; error: string };

ort.env.wasm.wasmPaths = { wasm: wasmUrl };

let session: Promise<ort.InferenceSession> | undefined;

self.onmessage = async ({ data }: MessageEvent<SegmentRequest>) => {
  try {
    session ??= ort.InferenceSession.create(data.modelUrl, { executionProviders: ['wasm'] });
    const s = await session;
    const input = new ort.Tensor('float32', data.input, [1, 3, data.size, data.size]);
    const result = await s.run({ [s.inputNames[0]]: input });
    const output = result[s.outputNames[0]].data as Float32Array;
    self.postMessage({ id: data.id, output } satisfies SegmentResponse, { transfer: [output.buffer] });
  } catch (err) {
    session = undefined;
    self.postMessage({ id: data.id, error: (err as Error).message ?? String(err) } satisfies SegmentResponse);
  }
};

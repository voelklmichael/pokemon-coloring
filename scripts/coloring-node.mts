// Runs the app's coloring() and inkScore() (src/coloring.ts) on raw RGBA files, for checks against
// scripts/lineart.py. Alpha = Pokémon mask. File format: uint32 LE width, uint32 LE height, pixels.
// Output: darkness map (same header, 1 byte per pixel); prints one JSON line per file.
// Usage: node coloring-node.mjs detail lineWidth in1.bin out1.bin [in2.bin out2.bin ...]
import { readFileSync, writeFileSync } from 'node:fs';
import { analyze, coloringParams } from '../src/coloring';
import { DEFAULT_LINE_ART } from '../src/lineart';

const [detail, lineWidth, ...files] = process.argv.slice(2);
const params = coloringParams({ ...DEFAULT_LINE_ART, detail: Number(detail), lineWidth: Number(lineWidth) });
for (let i = 0; i < files.length; i += 2) {
  const buf = readFileSync(files[i]);
  const width = buf.readUInt32LE(0), height = buf.readUInt32LE(4);
  const data = buf.subarray(8);
  const fg = new Uint8Array(width * height);
  for (let p = 0; p < fg.length; p++) fg[p] = data[p * 4 + 3] >= 128 ? 1 : 0;
  const t = performance.now();
  const { inkScore, lines } = analyze({ width, height, data }, fg, params);
  writeFileSync(files[i + 1], Buffer.concat([buf.subarray(0, 8), lines!]));
  console.log(JSON.stringify({ file: files[i], inkScore, ms: Math.round(performance.now() - t) }));
}

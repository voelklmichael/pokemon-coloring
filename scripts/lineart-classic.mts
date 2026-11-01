// Runs the app's current lineArt() on raw RGBA files, for comparison in scripts/lineart.py.
// File format (in and out): uint32 LE width, uint32 LE height, then the pixels (RGBA in, mask out).
// Usage: node lineart-classic.mjs in1.bin out1.bin [in2.bin out2.bin ...]
import { readFileSync, writeFileSync } from 'node:fs';
import { lineArt, PRESETS } from '../src/lineart';

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const buf = readFileSync(args[i]);
  const width = buf.readUInt32LE(0), height = buf.readUInt32LE(4);
  const mask = lineArt({ width, height, data: buf.subarray(8) }, PRESETS.detailed);
  writeFileSync(args[i + 1], Buffer.concat([buf.subarray(0, 8), mask]));
}

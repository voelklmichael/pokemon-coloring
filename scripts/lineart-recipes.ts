// Line-art recipes, pipeline v0 "classic": the app's lineArt() on each art crop (see
// scripts/extract-art.ts), with a small search over blur × detail. The config whose ink coverage
// is closest to TARGET_INK wins; no config inside INK_BAND fails the image.
// Writes per art file <recipeDir>/<file>.json (the config used, or the reason it failed)
// and <outDir>/<file> (the line art of the chosen config).
// Usage: [SHARD=i/n] npx vite-node scripts/lineart-recipes.ts [count=800] [artDir=.cache/art]
//        [recipeDir=.cache/recipes] [outDir=.cache/lineart/classic]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decode, encode } from 'fast-png';
import { lineArt, type LineArtSettings } from '../src/lineart';
import { toRgba } from './png';

const count = Number(process.argv[2] ?? 800);
const artDir = process.argv[3] ?? '.cache/art';
const recipeDir = process.argv[4] ?? '.cache/recipes';
const outDir = process.argv[5] ?? '.cache/lineart/classic';

const PIPELINE = 'classic-v0';
const TARGET_INK = 0.15;
const INK_BAND = [0.04, 0.3];
const SEARCH: LineArtSettings[] = [1, 2].flatMap((blur) =>
  [6, 10, 14].map((detail) => ({ blur, detail, minSpeckle: 40, lineWidth: 3 })),
);

// Deterministic sample spread over all sets: shuffle with a fixed seed.
function shuffle<T>(items: T[], seed = 1): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const j = seed % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const entries = (await readFile(join(artDir, 'art.tsv'), 'utf8'))
  .split('\n')
  .slice(1)
  .filter(Boolean)
  .map((line) => {
    const [id, file, status] = line.split('\t');
    return { id, file, status };
  });

type Recipe =
  | { id: string; file: string; pipeline: string; ok: true; config: LineArtSettings; ink: number; tried: { config: LineArtSettings; ink: number }[]; ms: number }
  | { id: string; file: string; pipeline: string; ok: false; reason: string; tried?: { config: LineArtSettings; ink: number }[] };

async function recipe(e: (typeof entries)[number]): Promise<Recipe> {
  const base = { id: e.id, file: e.file, pipeline: PIPELINE };
  if (e.status === 'no-window') return { ...base, ok: false, reason: 'full-art card: no art window found' };
  let img;
  try {
    img = toRgba(decode(await readFile(join(artDir, e.file))));
  } catch (err) {
    return { ...base, ok: false, reason: `cannot read art: ${(err as Error).message}` };
  }
  const start = performance.now();
  const n = img.width * img.height;
  let best: { config: LineArtSettings; ink: number; mask: Uint8Array } | null = null;
  const tried = [];
  for (const config of SEARCH) {
    const mask = lineArt(img, config);
    let black = 0;
    for (let i = 0; i < n; i++) black += mask[i];
    const ink = Math.round((black / n) * 1000) / 1000;
    tried.push({ config, ink });
    if (!best || Math.abs(ink - TARGET_INK) < Math.abs(best.ink - TARGET_INK)) best = { config, ink, mask };
  }
  if (best!.ink < INK_BAND[0] || best!.ink > INK_BAND[1]) {
    const why = best!.ink < INK_BAND[0] ? 'too few lines (flat art)' : 'too many lines (busy texture)';
    return { ...base, ok: false, reason: `${why}: best ink ${best!.ink} outside ${INK_BAND.join('..')}`, tried };
  }
  const png = new Uint8Array(n);
  for (let i = 0; i < n; i++) png[i] = best!.mask[i] ? 0 : 255;
  const path = join(outDir, e.file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encode({ width: img.width, height: img.height, data: png, channels: 1 }));
  return { ...base, ok: true, config: best!.config, ink: best!.ink, tried, ms: Math.round(performance.now() - start) };
}

// SHARD=i/n processes every n-th image starting at i, to run n processes in parallel.
const [shard, shards] = (process.env.SHARD ?? '0/1').split('/').map(Number);
const sample = shuffle(entries).slice(0, count).filter((_, i) => i % shards === shard);
const reasons = new Map<string, number>();
for (const [i, e] of sample.entries()) {
  const r = await recipe(e);
  const path = join(recipeDir, e.file.replace(/\.png$/, '.json'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(r, null, 1) + '\n');
  const key = r.ok ? 'ok' : r.reason.split(':')[0];
  reasons.set(key, (reasons.get(key) ?? 0) + 1);
  if ((i + 1) % 100 === 0) console.log(`${i + 1}/${sample.length}`);
}
console.log(`done: ${sample.length} recipes in ${recipeDir}`, Object.fromEntries(reasons));

// Downloads a sample of Pokémon cards from TCGdex, spread evenly across series, and
// stores only the artwork (cut out with the app's art detection) as the test set for
// image processing such as background removal.
// Usage: npx vite-node scripts/fetch-testset.ts [count=200] [outDir=testdata]
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decode, encode } from 'fast-png';
import { DEFAULT_ART, findArtRect } from '../src/detect';
import { crop, toRgba } from './png';

const API = 'https://api.tcgdex.net/v2/en';
const count = Number(process.argv[2] ?? 200);
const outDir = process.argv[3] ?? 'testdata';

/** Deterministic PRNG so the same test set is drawn every time. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(42);

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function get(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res;
    if (attempt >= 4) throw new Error(`${res.status} ${url}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

const exists = (p: string) => access(p).then(() => true, () => false);

interface BriefCard {
  id: string;
  name: string;
  image?: string;
}

const cards = ((await (await get(`${API}/cards?category=Pokemon`)).json()) as BriefCard[]).filter((c) => c.image);

// Image URLs look like https://assets.tcgdex.net/en/<series>/<set>/<localId>.
const seriesOf = (c: BriefCard) => c.image!.split('/')[4];
const bySeries = new Map<string, BriefCard[]>();
for (const c of cards) {
  if (!bySeries.has(seriesOf(c))) bySeries.set(seriesOf(c), []);
  bySeries.get(seriesOf(c))!.push(c);
}
// Round-robin over series so small old series are as represented as big new ones.
const pools = [...bySeries.values()].map(shuffle);
const picked: BriefCard[] = [];
while (picked.length < count && pools.some((p) => p.length)) {
  for (const p of pools) if (p.length && picked.length < count) picked.push(p.pop()!);
}

await mkdir(outDir, { recursive: true });
const manifest = [];
let failed = 0;
for (const [i, c] of picked.entries()) {
  const file = `${c.id.replace(/[^\w.-]/g, '_')}.png`;
  try {
    const d = await (await get(`${API}/cards/${encodeURIComponent(c.id)}`)).json();
    const img = toRgba(decode(new Uint8Array(await (await get(`${c.image}/high.png`)).arrayBuffer())));
    const { width: w, height: h } = img;
    const rect = findArtRect(img);
    const fallback =
      rect.x === Math.round(DEFAULT_ART.x * w) && rect.y === Math.round(DEFAULT_ART.y * h) &&
      rect.w === Math.round(DEFAULT_ART.w * w) && rect.h === Math.round(DEFAULT_ART.h * h);
    const path = join(outDir, file);
    // Same border inset as render.ts, scaled from the 744 px working width.
    if (!(await exists(path))) await writeFile(path, encode(crop(img, rect, Math.round((5 * w) / 744))));
    manifest.push({
      file,
      id: c.id,
      name: c.name,
      set: d.set?.name,
      series: seriesOf(c),
      rarity: d.rarity,
      stage: d.stage,
      types: d.types,
      image: `${c.image}/high.png`,
      card: { width: w, height: h },
      art: rect,
      artFallback: fallback,
    });
    console.log(`${i + 1}/${picked.length} ${c.id} ${c.name} (${d.rarity ?? '?'})`);
  } catch (e) {
    failed++;
    console.warn(`${i + 1}/${picked.length} skipped ${c.id}: ${(e as Error).message}`);
  }
}
await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`done: ${manifest.length} artworks in ${outDir}, ${failed} failed`);

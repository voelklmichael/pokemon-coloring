// Builds the card catalog (src/catalog.ts) from TCGdex and the images downloaded by
// scripts/download-cards.ts, sorted like scripts/card-urls.ts (by National Pokédex number).
// Only Pokémon cards, no Trainer or Energy cards. Cards whose image is not downloaded get sha256 null, so
// run it again after the download has finished.
// The catalog is CSV, written gzipped; the app decompresses it.
// Usage: npx vite-node scripts/build-catalog.ts [cards=.cache/cards] [out=public/catalog.csv.gz]
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { catalogToCsv, parseCatalog, type CatalogCard } from '../src/catalog';
import { structureFromTcgdex } from '../src/database';

const cardsDir = process.argv[2] ?? '.cache/cards';
const out = process.argv[3] ?? 'public/catalog.csv.gz';

const QUERY = `{ cards {
  id localId name image category dexId set { id }
  stage types abilities { name } attacks { cost damage }
  weaknesses { type } resistances { type } retreat
} }`;

type GqlCard = Parameters<typeof structureFromTcgdex>[0] & {
  localId: string;
  image: string | null;
  category: string;
  dexId: number[] | null;
  set: { id: string };
};

const res = await fetch('https://api.tcgdex.net/v2/graphql', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: QUERY }),
});
if (!res.ok) throw new Error(`${res.status} TCGdex GraphQL`);
const body = (await res.json()) as { data?: { cards: GqlCard[] }; errors?: { message: string }[] };
if (!body.data) throw new Error(`TCGdex GraphQL: ${body.errors?.map((e) => e.message).join('; ')}`);
const all = body.data.cards.filter((c) => c.category === 'Pokemon');

// Same order as scripts/card-urls.ts; cards without image go last within their number.
const dex = (c: GqlCard) => (c.dexId?.length ? Math.min(...c.dexId) : Infinity);
all.sort(
  (a, b) =>
    dex(a) - dex(b) ||
    Number(!a.image) - Number(!b.image) ||
    (a.image ?? a.id).localeCompare(b.image ?? b.id, 'en', { numeric: true }),
);

if (new Set(all.map((c) => c.id)).size !== all.length) throw new Error('duplicate card ids');

const cards: CatalogCard[] = [];
let hashed = 0;
for (const c of all) {
  // File path as written by scripts/card-urls.ts.
  const file = join(cardsDir, c.set.id, `${encodeURIComponent(c.localId)}.png`);
  const bytes = c.image ? await readFile(file).catch(() => null) : null;
  const sha256 = bytes?.length ? createHash('sha256').update(bytes).digest('hex') : null;
  if (sha256) hashed++;
  cards.push({
    id: c.id,
    name: c.name,
    set: c.set.id,
    dex: c.dexId ?? [],
    category: 'Pokemon',
    image: c.image,
    sha256,
    structure: structureFromTcgdex(c),
  });
}

const csv = catalogToCsv(cards);
if (JSON.stringify(parseCatalog(csv)) !== JSON.stringify(cards)) throw new Error('catalog does not round-trip');

await mkdir(dirname(out), { recursive: true });
// Node writes no timestamp into the gzip header, so the same catalog gives the same file.
const gz = gzipSync(csv, { level: 9 });
await writeFile(out, gz);
const withImage = cards.filter((c) => c.image).length;
const kb = (n: number) => `${Math.round(n / 1024)} KB`;
console.log(
  `${cards.length} cards, ${withImage} with image, ${hashed} hashed (${withImage - hashed} not downloaded); ` +
    `written to ${out} (${kb(gz.length)}, ${kb(csv.length)} unzipped)`,
);

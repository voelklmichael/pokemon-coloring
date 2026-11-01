// Writes the list of all TCGdex card images to download, sorted by National Pokédex
// number (Kanto first); Trainer and Energy cards come last.
// One line per card: <dexId>\t<cardId>\t<image url>\t<file path relative to the list>.
// Usage: npx vite-node scripts/card-urls.ts [out=.cache/cards/urls.tsv]
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const out = process.argv[2] ?? '.cache/cards/urls.tsv';

interface Card {
  id: string;
  localId: string;
  image: string | null;
  dexId: number[] | null;
  set: { id: string };
}

// The REST list has no dexId; GraphQL returns it for all cards in one request.
const res = await fetch('https://api.tcgdex.net/v2/graphql', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: '{ cards { id localId image dexId set { id } } }' }),
});
if (!res.ok) throw new Error(`${res.status} TCGdex GraphQL`);
const all = ((await res.json()) as { data: { cards: Card[] } }).data.cards;
const cards = all.filter((c) => c.image);

// Cards showing several Pokémon (e.g. Tag Team) sort by their lowest number.
const dex = (c: Card) => (c.dexId?.length ? Math.min(...c.dexId) : Infinity);
cards.sort((a, b) => dex(a) - dex(b) || a.image!.localeCompare(b.image!, 'en', { numeric: true }));

// encodeURIComponent keeps ids like "!" and "?" distinct and valid as file names.
const lines = cards.map((c) => {
  const file = `${c.set.id}/${encodeURIComponent(c.localId)}.png`;
  return [c.dexId?.length ? dex(c) : '-', c.id, `${c.image}/high.png`, file].join('\t');
});
if (new Set(lines.map((l) => l.split('\t')[3])).size !== lines.length) throw new Error('duplicate file paths');

await mkdir(dirname(out), { recursive: true });
await writeFile(out, lines.join('\n') + '\n');
console.log(`${lines.length} of ${all.length} cards have images; written to ${out}`);

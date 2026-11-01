// Cuts the artwork out of every downloaded card (see scripts/download-cards.ts) with the
// app's art detection, and reports cards whose artwork is not the usual window in the
// upper part of the card: full-art cards (no window found) and unusually large windows.
// Writes <outDir>/<file> per card and <outDir>/art.tsv with the window and status of each.
// Cards already listed in art.tsv whose crop exists are not processed again.
// Usage: npx vite-node scripts/extract-art.ts [list=.cache/cards/urls.tsv] [outDir=.cache/art]
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decode, encode } from 'fast-png';
import { DEFAULT_ART, detectArtWindow, scaleRect, type Rect } from '../src/detect';
import { crop, toRgba } from './png';

const list = process.argv[2] ?? '.cache/cards/urls.tsv';
const outDir = process.argv[3] ?? '.cache/art';
const root = dirname(list);
// A window this much wider or taller than the median (relative to the card) counts as large.
const LARGE = 1.1;

const entries = (await readFile(list, 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [dex, id, , file] = line.split('\t');
    return { dex, id, file };
  });

interface Result {
  id: string;
  file: string;
  card: { w: number; h: number };
  art: Rect;
  found: boolean;
}

const exists = (p: string) => stat(p).then((s) => s.size > 0, () => false);
const report = join(outDir, 'art.tsv');
const previous = new Map<string, Result>();
for (const line of (await readFile(report, 'utf8').catch(() => '')).split('\n').slice(1).filter(Boolean)) {
  const [id, file, status, cw, ch, x, y, w, h] = line.split('\t');
  const n = (v: string) => Number(v);
  previous.set(file, { id, file, card: { w: n(cw), h: n(ch) }, art: { x: n(x), y: n(y), w: n(w), h: n(h) }, found: status !== 'no-window' });
}

const results: Result[] = [];
let missing = 0;
for (const [i, e] of entries.entries()) {
  const known = previous.get(e.file);
  if (known && (await exists(join(outDir, e.file)))) {
    results.push(known);
    continue;
  }
  const bytes = await readFile(join(root, e.file)).catch(() => null);
  if (!bytes?.length) {
    missing++;
    continue;
  }
  try {
    const img = toRgba(decode(bytes));
    const { width: w, height: h } = img;
    const window = detectArtWindow(img);
    const found = window !== null;
    const art = window ?? scaleRect(DEFAULT_ART, w, h);
    const path = join(outDir, e.file);
    await mkdir(dirname(path), { recursive: true });
    // Same border inset as render.ts, scaled from the 744 px working width.
    await writeFile(path, encode(crop(img, art, Math.round((5 * w) / 744))));
    results.push({ id: e.id, file: e.file, card: { w, h }, art, found });
  } catch (err) {
    console.warn(`failed ${e.id} (${e.file}): ${(err as Error).message}`);
  }
  if ((i + 1) % 250 === 0) console.log(`${i + 1}/${entries.length}`);
}

const median = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)];
const found = results.filter((r) => r.found);
const typW = median(found.map((r) => r.art.w / r.card.w));
const typH = median(found.map((r) => r.art.h / r.card.h));
const status = (r: Result) =>
  !r.found ? 'no-window'
  : r.art.w / r.card.w > typW * LARGE || r.art.h / r.card.h > typH * LARGE ? 'large'
  : 'ok';

const rows = results.map((r) => {
  const rel = (v: number, of: number) => (v / of).toFixed(3);
  return [r.id, r.file, status(r), r.card.w, r.card.h, r.art.x, r.art.y, r.art.w, r.art.h,
    rel(r.art.w, r.card.w), rel(r.art.h, r.card.h)].join('\t');
});
const header = 'id\tfile\tstatus\tcardW\tcardH\tartX\tartY\tartW\tartH\trelW\trelH';
await writeFile(report, [header, ...rows].join('\n') + '\n');

// Flagged cards per set: whole sets usually share one layout (e.g. the taller HGSS window).
const sets = new Map<string, { total: number; large: string[]; noWindow: string[] }>();
for (const r of results) {
  const set = r.file.split('/')[0];
  if (!sets.has(set)) sets.set(set, { total: 0, large: [], noWindow: [] });
  const s = sets.get(set)!;
  s.total++;
  const st = status(r);
  if (st === 'large') s.large.push(r.id);
  if (st === 'no-window') s.noWindow.push(r.id);
}
const sample = (ids: string[]) => (ids.length > 8 ? `${ids.slice(0, 8).join(' ')} …` : ids.join(' '));
for (const [set, s] of sets) {
  if (s.large.length) console.log(`${set}: ${s.large.length}/${s.total} large: ${sample(s.large)}`);
  if (s.noWindow.length) console.log(`${set}: ${s.noWindow.length}/${s.total} without window: ${sample(s.noWindow)}`);
}
const count = (st: string) => results.filter((r) => status(r) === st).length;
console.log(
  `done: ${results.length} artworks in ${outDir}, typical window ${(100 * typW).toFixed(1)}% × ` +
    `${(100 * typH).toFixed(1)}% of the card; ${count('no-window')} without a window (full art?), ` +
    `${count('large')} large (see ${report})` + (missing ? `; ${missing} not downloaded` : ''),
);

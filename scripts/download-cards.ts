// Downloads the card images listed by scripts/card-urls.ts, in list order, at a fixed
// rate. Files that already exist are skipped, so it can be stopped and restarted anytime.
// Usage: npx vite-node scripts/download-cards.ts [list=.cache/cards/urls.tsv] [perSecond=5]
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const list = process.argv[2] ?? '.cache/cards/urls.tsv';
const perSecond = Number(process.argv[3] ?? 5);
const maxInFlight = 4 * perSecond;
const root = dirname(list);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exists = (p: string) => stat(p).then((s) => s.size > 0, () => false);

const entries = (await readFile(list, 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [dex, id, url, file] = line.split('\t');
    return { dex, id, url, path: join(root, file) };
  });

const done = await Promise.all(entries.map((e) => exists(e.path)));
const todo = entries.filter((_, i) => !done[i]);
console.log(`${entries.length - todo.length} of ${entries.length} already downloaded, ${todo.length} to go`);

async function download(e: (typeof todo)[number]) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(e.url).catch((err: Error) => err);
    if (res instanceof Response && res.ok) {
      await mkdir(dirname(e.path), { recursive: true });
      // Write then rename, so an interrupted download never looks finished.
      await writeFile(`${e.path}.part`, new Uint8Array(await res.arrayBuffer()));
      await rename(`${e.path}.part`, e.path);
      return;
    }
    const reason = res instanceof Response ? `HTTP ${res.status}` : res.message;
    if (attempt >= 3 || (res instanceof Response && res.status === 404)) throw new Error(reason);
    await sleep(2000 * 2 ** attempt);
  }
}

let ok = 0;
let failed = 0;
const start = Date.now();
const inFlight = new Set<Promise<void>>();
for (const [i, e] of todo.entries()) {
  // Start one request per 1/perSecond seconds, measured from the start, so slow
  // responses don't lower the rate.
  await sleep(start + (i * 1000) / perSecond - Date.now());
  while (inFlight.size >= maxInFlight) await Promise.race(inFlight);
  const p = download(e)
    .then(() => void ok++)
    .catch((err: Error) => {
      failed++;
      console.warn(`failed ${e.id} (${e.url}): ${err.message}`);
    })
    .finally(() => inFlight.delete(p));
  inFlight.add(p);
  if ((i + 1) % 100 === 0) {
    const eta = Math.round((todo.length - i - 1) / perSecond / 60);
    console.log(`${i + 1}/${todo.length} started (dex ${e.dex}, ${e.id}), ${failed} failed, ~${eta} min left`);
  }
}
await Promise.all(inFlight);
console.log(`done: ${ok} downloaded, ${failed} failed${failed ? ' (run again to retry)' : ''}`);

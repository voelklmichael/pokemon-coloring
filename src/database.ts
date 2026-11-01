import { energyFromName, type CardStructure } from './structure';

/**
 * Card databases with CORS-enabled APIs and images:
 * - TCGdex (https://tcgdex.dev): search by name, primary source.
 * - pokemontcg.io: for links to its images, e.g. https://images.pokemontcg.io/sv3pt5/25_hires.png
 */

const TCGDEX = 'https://api.tcgdex.net/v2/en';

export interface SearchResult {
  id: string;
  name: string;
  /** Image base URL; append "/low.webp" or "/high.png". */
  image: string;
}

export interface DatabaseCard {
  id: string;
  name: string;
  imageUrl: string;
  structure: CardStructure;
}

async function getJson<T>(url: string): Promise<T> {
  let lastError: unknown;
  // Public APIs occasionally answer 5xx; one retry fixes most of those.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) return (await res.json()) as T;
      lastError = new Error(`HTTP ${res.status}`);
      if (res.status < 500) break;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw lastError;
}

export async function searchCards(name: string): Promise<SearchResult[]> {
  const results = await getJson<Partial<SearchResult>[]>(`${TCGDEX}/cards?name=${encodeURIComponent(name.trim())}`);
  return results.filter((r): r is SearchResult => Boolean(r.id && r.name && r.image));
}

interface TcgdexCard {
  id: string;
  name: string;
  image?: string;
  stage?: string;
  types?: string[];
  abilities?: unknown[];
  attacks?: { cost?: string[]; damage?: string | number }[];
  weaknesses?: { type: string }[];
  resistances?: { type: string }[];
  retreat?: number;
}

export function structureFromTcgdex(card: TcgdexCard): CardStructure {
  const stage = (card.stage ?? '').toLowerCase().replace(/\s/g, '');
  return {
    stage: stage === 'stage2' ? 'stage2' : stage === 'stage1' ? 'stage1' : 'basic',
    type: energyFromName(card.types?.[0]),
    abilities: card.abilities?.length ?? 0,
    attacks: (card.attacks ?? []).map((a) => ({
      cost: (a.cost ?? []).flatMap((c) => energyFromName(c) ?? []),
      damage: a.damage !== undefined && a.damage !== '',
    })),
    weakness: energyFromName(card.weaknesses?.[0]?.type),
    resistance: energyFromName(card.resistances?.[0]?.type),
    retreat: card.retreat ?? 0,
  };
}

export async function fetchTcgdexCard(id: string): Promise<DatabaseCard> {
  const card = await getJson<TcgdexCard>(`${TCGDEX}/cards/${encodeURIComponent(id)}`);
  if (!card.image) throw new Error('the database has no image for this card');
  return { id: card.id, name: card.name, imageUrl: `${card.image}/high.png`, structure: structureFromTcgdex(card) };
}

interface PokemontcgCard {
  id: string;
  name: string;
  subtypes?: string[];
  types?: string[];
  abilities?: unknown[];
  attacks?: { cost?: string[]; damage?: string }[];
  weaknesses?: { type: string }[];
  resistances?: { type: string }[];
  retreatCost?: string[];
  images?: { large?: string };
}

export function structureFromPokemontcg(card: PokemontcgCard): CardStructure {
  const subtypes = card.subtypes ?? [];
  return {
    stage: subtypes.includes('Stage 2') ? 'stage2' : subtypes.includes('Stage 1') ? 'stage1' : 'basic',
    type: energyFromName(card.types?.[0]),
    abilities: card.abilities?.length ?? 0,
    attacks: (card.attacks ?? []).map((a) => ({
      cost: (a.cost ?? []).flatMap((c) => energyFromName(c) ?? []),
      damage: Boolean(a.damage),
    })),
    weakness: energyFromName(card.weaknesses?.[0]?.type),
    resistance: energyFromName(card.resistances?.[0]?.type),
    retreat: card.retreatCost?.length ?? 0,
  };
}

export async function fetchPokemontcgCard(id: string): Promise<DatabaseCard> {
  const { data } = await getJson<{ data: PokemontcgCard }>(`https://api.pokemontcg.io/v2/cards/${encodeURIComponent(id)}`);
  const imageUrl = data.images?.large;
  if (!imageUrl) throw new Error('the database has no image for this card');
  return { id: data.id, name: data.name, imageUrl, structure: structureFromPokemontcg(data) };
}

export type DatabaseRef = { db: 'tcgdex' | 'pokemontcg'; id: string };

/**
 * Recognizes card links of the supported databases:
 * - https://assets.tcgdex.net/en/sv/sv03.5/025/high.png
 * - https://api.tcgdex.net/v2/en/cards/sv03.5-025
 * - https://images.pokemontcg.io/sv3pt5/25_hires.png
 * - https://api.pokemontcg.io/v2/cards/sv3pt5-25
 */
export function parseDatabaseUrl(url: string): DatabaseRef | null {
  let m = /^https:\/\/assets\.tcgdex\.net\/[a-z-]+\/[^/]+\/([^/]+)\/([^/]+)(?:\/(?:high|low)\.(?:png|webp|jpg))?$/i.exec(url);
  if (m) return { db: 'tcgdex', id: `${m[1]}-${m[2]}` };
  m = /^https:\/\/api\.tcgdex\.net\/v2\/[a-z-]+\/cards\/([^/?#]+)/i.exec(url);
  if (m) return { db: 'tcgdex', id: decodeURIComponent(m[1]) };
  m = /^https:\/\/images\.pokemontcg\.io\/([^/]+)\/([^/_.]+)(?:_hires)?\.png$/i.exec(url);
  if (m) return { db: 'pokemontcg', id: `${m[1]}-${m[2]}` };
  m = /^https:\/\/api\.pokemontcg\.io\/v2\/cards\/([^/?#]+)/i.exec(url);
  if (m) return { db: 'pokemontcg', id: decodeURIComponent(m[1]) };
  return null;
}

export function fetchDatabaseCard(ref: DatabaseRef): Promise<DatabaseCard> {
  return ref.db === 'tcgdex' ? fetchTcgdexCard(ref.id) : fetchPokemontcgCard(ref.id);
}

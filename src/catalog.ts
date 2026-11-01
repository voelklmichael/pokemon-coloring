import { costToLetters, energyFromName, lettersToCost, type CardStructure, type EnergyType } from './structure';

/**
 * All cards the app offers, built offline by scripts/build-catalog.ts from TCGdex and the
 * downloaded card images, stored as CSV. Holds no card text or images, only names, numbers
 * and structure.
 *
 * Columns (empty = none):
 * - dex: National Pokédex numbers, space-separated
 * - image: TCGdex image base URL; append "/high.png"
 * - sha256: hex SHA-256 of that "/high.png" file; empty when it could not be downloaded
 * - stage … retreat: the card structure, empty for Trainer and Energy cards
 * - attacks: one entry per attack, space-separated: the cost as energy letters ("0" if
 *   free), followed by "*" if it deals damage, e.g. "C LL*"
 */
export interface CatalogCard {
  /** TCGdex card id, e.g. "base1-58". */
  id: string;
  name: string;
  set: string;
  dex: number[];
  category: 'Pokemon' | 'Trainer' | 'Energy';
  image: string | null;
  sha256: string | null;
  /** Null for Trainer and Energy cards. */
  structure: CardStructure | null;
}

export const CATALOG_COLUMNS = [
  'id',
  'name',
  'set',
  'dex',
  'category',
  'image',
  'sha256',
  'stage',
  'type',
  'abilities',
  'attacks',
  'weakness',
  'resistance',
  'retreat',
] as const;

const CATEGORIES = ['Pokemon', 'Trainer', 'Energy'] as const;

function cardToRow(c: CatalogCard): string[] {
  const s = c.structure;
  return [
    c.id,
    c.name,
    c.set,
    c.dex.join(' '),
    c.category,
    c.image ?? '',
    c.sha256 ?? '',
    s?.stage ?? '',
    s?.type ?? '',
    s ? String(s.abilities) : '',
    s?.attacks.map((a) => (costToLetters(a.cost) || '0') + (a.damage ? '*' : '')).join(' ') ?? '',
    s?.weakness ?? '',
    s?.resistance ?? '',
    s ? String(s.retreat) : '',
  ];
}

function rowToCard(row: string[], line: number): CatalogCard {
  const f = Object.fromEntries(CATALOG_COLUMNS.map((name, i) => [name, row[i] ?? '']));
  if (!(CATEGORIES as readonly string[]).includes(f.category)) {
    throw new Error(`catalog line ${line}: unknown category "${f.category}"`);
  }
  const energy = (v: string): EnergyType | null => (v ? energyFromName(v) : null);
  return {
    id: f.id,
    name: f.name,
    set: f.set,
    dex: f.dex ? f.dex.split(' ').map(Number) : [],
    category: f.category as CatalogCard['category'],
    image: f.image || null,
    sha256: f.sha256 || null,
    structure: f.stage
      ? {
          stage: f.stage as CardStructure['stage'],
          type: energy(f.type),
          abilities: Number(f.abilities),
          attacks: f.attacks
            ? f.attacks.split(' ').map((a) => ({ cost: lettersToCost(a), damage: a.endsWith('*') }))
            : [],
          weakness: energy(f.weakness),
          resistance: energy(f.resistance),
          retreat: Number(f.retreat),
        }
      : null,
  };
}

function csvField(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function catalogToCsv(cards: CatalogCard[]): string {
  return [CATALOG_COLUMNS, ...cards.map(cardToRow)].map((r) => r.map(csvField).join(',')).join('\n') + '\n';
}

/** Splits CSV text (RFC 4180: quoted fields may hold commas, quotes and newlines) into rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') field += text[i++];
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

export function parseCatalog(text: string): CatalogCard[] {
  const [header, ...rows] = parseCsv(text);
  if (header?.join(',') !== CATALOG_COLUMNS.join(',')) throw new Error('catalog: unexpected columns');
  return rows.map((r, i) => rowToCard(r, i + 2));
}

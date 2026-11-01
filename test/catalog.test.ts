import { describe, expect, it } from 'vitest';
import { catalogToCsv, parseCatalog, type CatalogCard } from '../src/catalog';

const pikachu: CatalogCard = {
  id: 'base1-58',
  name: 'Pikachu',
  set: 'base1',
  dex: [25],
  category: 'Pokemon',
  image: 'https://assets.tcgdex.net/en/base/base1/58',
  sha256: 'd800508f4b0067c23148406098f0064b1bcf5b22977d1706c7b06b683f62185c',
  structure: {
    stage: 'basic',
    type: 'lightning',
    abilities: 0,
    attacks: [
      { cost: ['colorless'], damage: false },
      { cost: ['lightning', 'colorless'], damage: true },
      { cost: [], damage: true },
    ],
    weakness: 'fighting',
    resistance: null,
    retreat: 1,
  },
};

const trainer: CatalogCard = {
  id: 'x-1',
  name: 'Quote "and", comma',
  set: 'x',
  dex: [],
  category: 'Trainer',
  image: null,
  sha256: null,
  structure: null,
};

describe('catalog CSV', () => {
  it('round-trips cards, including quoted names and empty fields', () => {
    const csv = catalogToCsv([pikachu, trainer]);
    expect(parseCatalog(csv)).toEqual([pikachu, trainer]);
  });

  it('writes attacks as energy letters with "*" for damage', () => {
    const line = catalogToCsv([pikachu]).split('\n')[1];
    expect(line).toContain(',C LC* 0*,');
    expect(catalogToCsv([trainer]).split('\n')[1]).toBe('x-1,"Quote ""and"", comma",x,,Trainer,,,,,,,,,');
  });

  it('accepts CRLF line endings', () => {
    const csv = catalogToCsv([pikachu]).replace(/\n/g, '\r\n');
    expect(parseCatalog(csv)).toEqual([pikachu]);
  });

  it('rejects unknown columns', () => {
    expect(() => parseCatalog('id,name\nx,y\n')).toThrow('unexpected columns');
  });
});

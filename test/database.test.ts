import { describe, expect, it } from 'vitest';
import { parseDatabaseUrl, structureFromPokemontcg, structureFromTcgdex } from '../src/database';
import { costToLetters, lettersToCost } from '../src/structure';

describe('parseDatabaseUrl', () => {
  it.each([
    ['https://assets.tcgdex.net/en/sv/sv03.5/025/high.png', { db: 'tcgdex', id: 'sv03.5-025' }],
    ['https://assets.tcgdex.net/en/base/base1/4', { db: 'tcgdex', id: 'base1-4' }],
    ['https://api.tcgdex.net/v2/en/cards/swsh3-136', { db: 'tcgdex', id: 'swsh3-136' }],
    ['https://images.pokemontcg.io/sv3pt5/25_hires.png', { db: 'pokemontcg', id: 'sv3pt5-25' }],
    ['https://images.pokemontcg.io/base1/4.png', { db: 'pokemontcg', id: 'base1-4' }],
    ['https://example.com/card.png', null],
  ])('%s', (url, expected) => {
    expect(parseDatabaseUrl(url)).toEqual(expected);
  });
});

describe('structureFromTcgdex', () => {
  it('maps a TCGdex card (base set Charizard)', () => {
    const s = structureFromTcgdex({
      id: 'base1-4',
      name: 'Charizard',
      stage: 'Stage2',
      types: ['Fire'],
      abilities: [{ type: 'Pokemon Power' }],
      attacks: [{ cost: ['Fire', 'Fire', 'Fire', 'Fire'], damage: 100 }],
      weaknesses: [{ type: 'Water' }],
      resistances: [{ type: 'Fighting' }],
      retreat: 3,
    });
    expect(s).toEqual({
      stage: 'stage2',
      type: 'fire',
      abilities: 1,
      attacks: [{ cost: ['fire', 'fire', 'fire', 'fire'], damage: true }],
      weakness: 'water',
      resistance: 'fighting',
      retreat: 3,
    });
  });

  it('marks attacks without damage', () => {
    const s = structureFromTcgdex({ id: 'x', name: 'x', attacks: [{ cost: ['Lightning'] }] });
    expect(s.attacks).toEqual([{ cost: ['lightning'], damage: false }]);
    expect(s.stage).toBe('basic');
  });
});

describe('structureFromPokemontcg', () => {
  it('maps a pokemontcg.io card (Pikachu sv3pt5-25)', () => {
    const s = structureFromPokemontcg({
      id: 'sv3pt5-25',
      name: 'Pikachu',
      subtypes: ['Basic'],
      types: ['Lightning'],
      attacks: [
        { cost: ['Lightning'], damage: '' },
        { cost: ['Lightning', 'Lightning', 'Colorless'], damage: '50' },
      ],
      weaknesses: [{ type: 'Fighting' }],
      retreatCost: ['Colorless'],
    });
    expect(s.attacks.map((a) => [costToLetters(a.cost), a.damage])).toEqual([
      ['L', false],
      ['LLC', true],
    ]);
    expect([s.type, s.weakness, s.resistance, s.retreat]).toEqual(['lightning', 'fighting', null, 1]);
  });
});

describe('energy letters', () => {
  it('round-trips and ignores unknown letters', () => {
    expect(costToLetters(lettersToCost('llc x'))).toBe('LLC');
  });
});

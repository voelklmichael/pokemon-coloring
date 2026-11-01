export const ENERGY_TYPES = [
  'grass',
  'fire',
  'water',
  'lightning',
  'psychic',
  'fighting',
  'darkness',
  'metal',
  'fairy',
  'dragon',
  'colorless',
] as const;

export type EnergyType = (typeof ENERGY_TYPES)[number];

/** Official TCG one-letter abbreviations, used in the attack cost editor. */
export const ENERGY_LETTERS: Record<EnergyType, string> = {
  grass: 'G',
  fire: 'R',
  water: 'W',
  lightning: 'L',
  psychic: 'P',
  fighting: 'F',
  darkness: 'D',
  metal: 'M',
  fairy: 'Y',
  dragon: 'N',
  colorless: 'C',
};

export type Stage = 'basic' | 'stage1' | 'stage2';

export interface Attack {
  cost: EnergyType[];
  damage: boolean;
}

/** Everything the base layout needs to know about a card; all text and numbers are left out on purpose. */
export interface CardStructure {
  stage: Stage;
  type: EnergyType | null;
  abilities: number;
  attacks: Attack[];
  weakness: EnergyType | null;
  resistance: EnergyType | null;
  retreat: number;
}

export const DEFAULT_STRUCTURE: CardStructure = {
  stage: 'basic',
  type: null,
  abilities: 0,
  attacks: [{ cost: ['colorless'], damage: true }],
  weakness: null,
  resistance: null,
  retreat: 1,
};

export function costToLetters(cost: EnergyType[]): string {
  return cost.map((t) => ENERGY_LETTERS[t]).join('');
}

/** Parses e.g. "LLC" into energy types; unknown letters are ignored. */
export function lettersToCost(letters: string): EnergyType[] {
  const byLetter = Object.fromEntries(ENERGY_TYPES.map((t) => [ENERGY_LETTERS[t], t]));
  return [...letters.toUpperCase()].flatMap((ch) => (byLetter[ch] ? [byLetter[ch] as EnergyType] : []));
}

/** Maps database type names like "Lightning" to energy types. */
export function energyFromName(name: unknown): EnergyType | null {
  const t = String(name ?? '').toLowerCase();
  return (ENERGY_TYPES as readonly string[]).includes(t) ? (t as EnergyType) : null;
}

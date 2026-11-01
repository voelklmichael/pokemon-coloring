/** Rectangle in fractions (0..1) of the card's width/height. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Text areas of a modern (Scarlet & Violet era) card: the name/HP bar at the
 * top and the attack/ability/weakness block below the artwork.
 * Other card eras and full-art cards differ; use text mode "edges" for those.
 */
export const TEXT_REGIONS: Region[] = [
  { x: 0.05, y: 0.03, w: 0.9, h: 0.075 }, // name + HP
  { x: 0.05, y: 0.483, w: 0.9, h: 0.502 }, // info strip, attacks, abilities, weakness/retreat, flavor text, copyright
];

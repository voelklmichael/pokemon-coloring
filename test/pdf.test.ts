import { describe, expect, it } from 'vitest';
import { CARD_MM, computeGrid, PAPER_MM } from '../src/pdf';

describe('computeGrid', () => {
  it('fits 3 × 3 cards on A4 and centers them', () => {
    const grid = computeGrid('a4', 2);
    expect([grid.cols, grid.rows]).toEqual([3, 3]);
    expect(grid.marginX).toBeCloseTo(8.5);
    expect(grid.marginY).toBeCloseTo(14.5);
    const last = grid.slots[8];
    expect(last.x + CARD_MM.w).toBeCloseTo(PAPER_MM.a4.w - grid.marginX);
    expect(last.y + CARD_MM.h).toBeCloseTo(PAPER_MM.a4.h - grid.marginY);
  });

  it('fits 3 × 3 cards on Letter with a small gap', () => {
    const grid = computeGrid('letter', 2);
    expect([grid.cols, grid.rows]).toEqual([3, 3]);
    expect(grid.marginY).toBeGreaterThanOrEqual(5);
  });

  it('drops a row when the gap gets too large', () => {
    expect(computeGrid('letter', 5).rows).toBe(2);
  });
});

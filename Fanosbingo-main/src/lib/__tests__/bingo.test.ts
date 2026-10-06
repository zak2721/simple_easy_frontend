import { describe, it, expect } from 'vitest';
import { detectWin, columnFor } from '../bingo';

// column-major 5x5, centre free (0 placeholder)
const card: number[][] = [
  [1, 2, 3, 4, 5],       // B
  [16, 17, 18, 19, 20],  // I
  [31, 32, 0, 34, 35],   // N (centre free)
  [46, 47, 48, 49, 50],  // G
  [61, 62, 63, 64, 65],  // O
];

describe('75-ball win detection', () => {
  it('no win with nothing called', () => {
    expect(detectWin(card, [])).toBeNull();
  });

  it('top row', () => {
    const w = detectWin(card, [1, 16, 31, 46, 61]);
    expect(w?.kind).toBe('row');
  });

  it('B column', () => {
    const w = detectWin(card, [1, 2, 3, 4, 5]);
    expect(w?.kind).toBe('column');
    expect(w?.description).toBe('B column');
  });

  it('middle row uses the free centre', () => {
    // row index 2 across columns: 3, 18, FREE, 48, 63
    const w = detectWin(card, [3, 18, 48, 63]);
    expect(w?.kind).toBe('row');
  });

  it('diagonal ↘ through the free centre', () => {
    const w = detectWin(card, [1, 17, 49, 65]); // (0,0)(1,1)(2,2 free)(3,3)(4,4)
    expect(w?.kind).toBe('diagonal');
  });

  it('four corners', () => {
    const w = detectWin(card, [1, 5, 61, 65]);
    expect(w?.kind).toBe('fourCorners');
  });

  it('columns map correctly', () => {
    expect(columnFor(1)).toBe(0);
    expect(columnFor(15)).toBe(0);
    expect(columnFor(16)).toBe(1);
    expect(columnFor(45)).toBe(2);
    expect(columnFor(75)).toBe(4);
  });
});

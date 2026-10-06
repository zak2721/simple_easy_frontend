import { describe, expect, it } from 'vitest';
import { generateBingoCard, checkWin, initialMarkedCells } from '../bingo-card-generator';

describe('generateBingoCard', () => {
  it('uses correct 75-ball column ranges with FREE center', () => {
    for (let i = 0; i < 200; i++) {
      const card = generateBingoCard();
      const ranges: Array<[number, number]> = [
        [1, 15],
        [16, 30],
        [31, 45],
        [46, 60],
        [61, 75],
      ];
      ranges.forEach(([lo, hi], col) => {
        card[col].forEach((n, row) => {
          if (col === 2 && row === 2) {
            expect(n).toBe(0); // FREE
          } else {
            expect(n).toBeGreaterThanOrEqual(lo);
            expect(n).toBeLessThanOrEqual(hi);
          }
        });
      });
    }
  });

  it('never repeats a number within the same column', () => {
    for (let i = 0; i < 100; i++) {
      const card = generateBingoCard();
      for (const col of card) {
        expect(new Set(col).size).toBe(5);
      }
    }
  });

  it('generates different cards on successive calls (not deterministic by position)', () => {
    const a = generateBingoCard();
    const b = generateBingoCard();
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});

describe('checkWin', () => {
  const called = (nums: number[]) => new Set(nums);

  it('detects a completed row', () => {
    const card = [
      [1, 2, 3, 4, 5],
      [16, 17, 18, 19, 20],
      [31, 32, 0, 34, 35],
      [46, 47, 48, 49, 50],
      [61, 62, 63, 64, 65],
    ];
    const marked = initialMarkedCells();
    const win = checkWin(card, marked, called([3, 18, 48, 63])); // row index 2 across all columns, FREE auto-marked
    expect(win?.type).toBe('row');
  });

  it('does not report a win for an incomplete card', () => {
    const card = [
      [1, 2, 3, 4, 5],
      [16, 17, 18, 19, 20],
      [31, 32, 0, 34, 35],
      [46, 47, 48, 49, 50],
      [61, 62, 63, 64, 65],
    ];
    const marked = initialMarkedCells();
    const win = checkWin(card, marked, called([3, 18])); // only 2 of 4 needed
    expect(win).toBeNull();
  });

  it('detects a diagonal', () => {
    const card = [
      [1, 2, 3, 4, 5],
      [16, 17, 18, 19, 20],
      [31, 32, 0, 34, 35],
      [46, 47, 48, 49, 50],
      [61, 62, 63, 64, 65],
    ];
    const marked = initialMarkedCells();
    // diagonal ↘: (0,0)=1 (1,1)=17 (2,2)=FREE (3,3)=49 (4,4)=65
    const win = checkWin(card, marked, called([1, 17, 49, 65]));
    expect(win?.type).toBe('diagonal');
  });

  it('detects four corners', () => {
    const card = [
      [1, 2, 3, 4, 5],
      [16, 17, 18, 19, 20],
      [31, 32, 0, 34, 35],
      [46, 47, 48, 49, 50],
      [61, 62, 63, 64, 65],
    ];
    const marked = initialMarkedCells();
    const win = checkWin(card, marked, called([1, 5, 61, 65]));
    expect(win?.type).toBe('corners');
  });

  describe('configurable winning patterns', () => {
    // Column-major card; row 0 fully called.
    const card = [
      [1, 2, 3, 4, 5],
      [16, 17, 18, 19, 20],
      [31, 32, 0, 34, 35],
      [46, 47, 48, 49, 50],
      [61, 62, 63, 64, 65],
    ];
    const none = Array.from({ length: 5 }, () => [false, false, false, false, false]);
    const rowCalled = new Set([1, 16, 31, 46, 61]);

    it('a row does not win in a full-house-only game', () => {
      expect(checkWin(card as never, none, rowCalled, new Set(['full_house']))).toBeNull();
    });

    it('full house wins only when every cell is covered', () => {
      const all = new Set(card.flat());
      expect(checkWin(card as never, none, all, new Set(['full_house']))?.type).toBe('full_house');
    });

    it('default allowed set still recognises a row (existing behaviour)', () => {
      expect(checkWin(card as never, none, rowCalled)?.type).toBe('row');
    });
  });
});

import { describe, it, expect } from 'vitest';
import { withinCartelaLimit, remainingCartelas } from '../bingo';

/**
 * Phase 51 — the 4-cartela TOTAL rule (GLOBAL across both rooms).
 * Mirrors the SQL check in eds_select_cartela (v_current + 1 > v_max).
 */
describe('4-cartela total limit', () => {
  it('allows buying up to 4', () => {
    expect(withinCartelaLimit(0, 1)).toBe(true);
    expect(withinCartelaLimit(1, 1)).toBe(true);
    expect(withinCartelaLimit(2, 1)).toBe(true);
    expect(withinCartelaLimit(3, 1)).toBe(true);
  });

  it('rejects the 5th', () => {
    expect(withinCartelaLimit(4, 1)).toBe(false);
  });

  it('owns 3, tries to buy 2 -> reject', () => {
    expect(withinCartelaLimit(3, 2)).toBe(false);
  });

  it('owns 2, tries to buy 2 -> pass', () => {
    expect(withinCartelaLimit(2, 2)).toBe(true);
  });

  it('2 ETB5 + 2 ETB10 counts as 4 total -> pass, no more', () => {
    const owned = 2 /* etb5 */ + 2; /* etb10 */
    expect(withinCartelaLimit(owned, 1)).toBe(false);
    expect(remainingCartelas(owned)).toBe(0);
  });

  it('4 ETB5 then 1 ETB10 -> reject (limit is total, not per room)', () => {
    expect(withinCartelaLimit(4, 1)).toBe(false);
  });

  it('remaining slots', () => {
    expect(remainingCartelas(0)).toBe(4);
    expect(remainingCartelas(3)).toBe(1);
    expect(remainingCartelas(4)).toBe(0);
    expect(remainingCartelas(9)).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { prizeSplit } from '../bingo';

/**
 * 80/20 split (spec §20-22, §48). Computed from the actual pot. Multi-winner
 * remainder goes to WINNERS (deterministic), house stays EXACTLY 20%.
 */
describe('80/20 prize split', () => {
  it('ETB 1000 pot -> 800 winner / 200 house', () => {
    const r = prizeSplit(1000);
    expect(r.payouts).toEqual([800]);
    expect(r.house).toBe(200);
  });

  it('spec §21 example: ETB 500 pot, 2 winners -> 200 + 200, house 100', () => {
    const r = prizeSplit(500, 80, 2);
    expect(r.winnerPool).toBe(400);
    expect(r.payouts).toEqual([200, 200]);
    expect(r.house).toBe(100);
  });

  it('spec §48: ETB 2000 pot, 2 winners -> 800 + 800, house 400', () => {
    const r = prizeSplit(2000, 80, 2);
    expect(r.payouts).toEqual([800, 800]);
    expect(r.house).toBe(400);
  });

  it('spec §30: ETB5 x10 + ETB10 x10 = 150 pot, 1 winner -> 120 / 30', () => {
    const r = prizeSplit(150);
    expect(r.payouts).toEqual([120]);
    expect(r.house).toBe(30);
  });

  it('3 winners, pool not divisible: remainder to first winners, house EXACTLY 20%', () => {
    // pot 1000 -> pool 800, /3 = 266 r2 -> [267, 267, 266]
    const r = prizeSplit(1000, 80, 3);
    expect(r.payouts).toEqual([267, 267, 266]);
    expect(r.payouts.reduce((a, b) => a + b)).toBe(800); // whole pool to winners
    expect(r.house).toBe(200); // exactly 20%
  });

  it('4 winners', () => {
    const r = prizeSplit(1000, 80, 4);
    expect(r.payouts).toEqual([200, 200, 200, 200]);
    expect(r.house).toBe(200);
  });

  it('house is always exactly 20% and winners exactly 80% for any multiple-of-5 pot', () => {
    for (let pot = 5; pot <= 3000; pot += 5) {
      for (const n of [1, 2, 3, 4, 5]) {
        const r = prizeSplit(pot, 80, n);
        const paid = r.payouts.reduce((a, b) => a + b, 0);
        expect(paid).toBe(r.winnerPool);          // winners get the whole pool
        expect(paid).toBe(Math.round(pot * 0.8)); // == 80% exactly (pot % 5 == 0)
        expect(r.house).toBe(pot - paid);
        expect(r.house).toBe(Math.round(pot * 0.2)); // == 20% exactly
        expect(Math.max(...r.payouts) - Math.min(...r.payouts)).toBeLessThanOrEqual(1);
        r.payouts.forEach((p) => expect(Number.isInteger(p)).toBe(true));
      }
    }
  });

  it('winners never receive more than the 80% pool (spec §20)', () => {
    for (let pot = 5; pot <= 2000; pot += 5) {
      for (const n of [1, 2, 3, 4]) {
        const r = prizeSplit(pot, 80, n);
        expect(r.payouts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(r.winnerPool);
      }
    }
  });
});

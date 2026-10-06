/*
  የኛ — pure Bingo + money rules.

  These mirror the authoritative backend (SQL) rules. The backend is always the
  source of truth; this module exists for client rendering and is unit-tested so
  the two stay in sync.
*/

export type WinKind = 'row' | 'column' | 'diagonal' | 'fourCorners';
export interface WinningPattern {
  kind: WinKind;
  description: string;
  cells: [number, number][];
}

/** card is column-major: card[col][row], 5x5, centre (col 2,row 2) is FREE. */
export function detectWin(card: number[][], called: Iterable<number>): WinningPattern | null {
  const set = called instanceof Set ? called : new Set(called);
  const hit = (c: number, r: number) => (c === 2 && r === 2) || set.has(card[c][r]);

  for (let r = 0; r < 5; r++) {
    if ([0, 1, 2, 3, 4].every((c) => hit(c, r))) {
      return { kind: 'row', description: `Row ${r + 1}`, cells: [0, 1, 2, 3, 4].map((c) => [c, r]) };
    }
  }
  for (let c = 0; c < 5; c++) {
    if ([0, 1, 2, 3, 4].every((r) => hit(c, r))) {
      return { kind: 'column', description: `${'BINGO'[c]} column`, cells: [0, 1, 2, 3, 4].map((r) => [c, r]) };
    }
  }
  if ([0, 1, 2, 3, 4].every((i) => hit(i, i))) {
    return { kind: 'diagonal', description: 'Diagonal ↘', cells: [0, 1, 2, 3, 4].map((i) => [i, i]) };
  }
  if ([0, 1, 2, 3, 4].every((i) => hit(i, 4 - i))) {
    return { kind: 'diagonal', description: 'Diagonal ↗', cells: [0, 1, 2, 3, 4].map((i) => [i, 4 - i]) };
  }
  if (hit(0, 0) && hit(4, 0) && hit(0, 4) && hit(4, 4)) {
    return { kind: 'fourCorners', description: 'Four corners', cells: [[0, 0], [4, 0], [0, 4], [4, 4]] };
  }
  return null;
}

/** 75-ball column for a number. */
export function columnFor(num: number): number {
  return Math.min(4, Math.floor((num - 1) / 15));
}

/**
 * The GLOBAL 4-cartela limit: a player's cartelas across BOTH rooms plus the
 * requested amount must not exceed max.
 */
export function withinCartelaLimit(currentTotal: number, requested: number, max = 4): boolean {
  return currentTotal + requested <= max;
}

export function remainingCartelas(currentTotal: number, max = 4): number {
  return Math.max(0, max - currentTotal);
}

/**
 * 80 / 20 prize split — mirrors the SQL `payout_winners()`.
 *
 * The game pot is always a multiple of 5 (cartelas cost 5 or 10 ETB), so
 * `pot * 80 / 100` and `pot * 20 / 100` are always exact integers: the house
 * gets EXACTLY 20%, winners get EXACTLY the 80% pool.
 *
 * The only rounding is splitting the winner pool between N winners. The
 * remainder (`pool mod N`) is distributed as +1 ETB to the first
 * `remainder` winners (deterministic, ordered) so the winners collectively
 * receive the whole pool and nothing is lost or created.
 *
 * Returns `payouts` = the amount each winner gets, in order.
 */
export function prizeSplit(pot: number, winnerPercentage = 80, winners = 1) {
  const winnerPool = Math.floor((pot * winnerPercentage) / 100);
  const n = Math.max(0, winners);
  const base = n > 0 ? Math.floor(winnerPool / n) : 0;
  const remainder = n > 0 ? winnerPool - base * n : 0;
  const payouts = Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
  const paidToWinners = payouts.reduce((a, b) => a + b, 0);
  return {
    pot,
    winnerPool,
    /** base per-winner amount (some winners may get +1 — see `payouts`) */
    winnerEach: base,
    payouts,
    house: pot - paidToWinners,
  };
}

import * as crypto from 'crypto';

/**
 * 75-ball Bingo card generator.
 *
 * CONFLICT RESOLUTION (documented in PRODUCTION_MIGRATION_REPORT.md):
 * the previous Supabase implementation used a deterministic seeded LCG keyed
 * by card NUMBER, so "card #147" always had the exact same layout in every
 * game. The migration spec explicitly says "Do NOT use predictable
 * deterministic card generation" and "regenerated cards must not simply
 * reproduce the same deterministic cards" — a direct conflict. Per the
 * spec's own tiebreaker rule ("preserve the implementation that matches the
 * explicit business rules in this prompt"), this generator uses Node's CSPRNG
 * (crypto.randomInt) and is called fresh on every purchase/regeneration, not
 * looked up from a per-number table.
 *
 * Standard column ranges: B 1-15, I 16-30, N 31-45, G 46-60, O 61-75.
 * Center cell (row 2, col 2) is FREE (represented as 0).
 */
export type BingoCard = number[][]; // 5 columns x 5 rows, column-major to match the existing frontend shape

const COLUMN_RANGES: Array<[number, number]> = [
  [1, 15],
  [16, 30],
  [31, 45],
  [46, 60],
  [61, 75],
];

function secureShuffleTake(min: number, max: number, count: number): number[] {
  const pool: number[] = [];
  for (let n = min; n <= max; n++) pool.push(n);
  // Fisher-Yates with crypto.randomInt (CSPRNG) — not Math.random().
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

export function generateBingoCard(): BingoCard {
  const columns: number[][] = COLUMN_RANGES.map(([lo, hi]) => secureShuffleTake(lo, hi, 5));
  columns[2][2] = 0; // N column, center row = FREE
  return columns;
}

export function cardHash(card: BingoCard): string {
  return crypto.createHash('sha256').update(JSON.stringify(card)).digest('hex');
}

/** Marked-cell matrix matching the card shape, with FREE (col 2, row 2) pre-marked. */
export function initialMarkedCells(): boolean[][] {
  return [0, 1, 2, 3, 4].map((c) => [0, 1, 2, 3, 4].map((r) => c === 2 && r === 2));
}

export type WinningPattern = { type: string; description: string; cells: [number, number][] };

/** Checks a card against called numbers for any standard win: row, column, diagonal, four corners. */
export const WINNING_PATTERN_TYPES = ['row', 'column', 'diagonal', 'corners', 'full_house'] as const;
export type WinningPatternType = (typeof WINNING_PATTERN_TYPES)[number];
export const DEFAULT_WINNING_PATTERNS: WinningPatternType[] = ['row', 'column', 'diagonal', 'corners'];

/** Unique, known, non-empty — throws a user-readable Error otherwise. */
export function validatePatternList(patterns: string[]): string[] {
  const unique = [...new Set(patterns.map((p) => p.trim()).filter(Boolean))];
  if (unique.length === 0) throw new Error('Choose at least one winning pattern');
  const unknown = unique.filter((p) => !(WINNING_PATTERN_TYPES as readonly string[]).includes(p));
  if (unknown.length) throw new Error(`Unknown winning pattern(s): ${unknown.join(', ')}. Allowed: ${WINNING_PATTERN_TYPES.join(', ')}`);
  return unique;
}

/** "row,column,..." (the WINNING_PATTERNS setting) -> validated list, or null if empty/invalid. */
export function parseWinningPatterns(raw: string): string[] | null {
  try {
    return validatePatternList(raw.split(','));
  } catch {
    return null;
  }
}

/**
 * `allowed` = the game's configured winning patterns (games.winning_patterns);
 * omitted = the historical default set. Patterns not allowed are never
 * reported, so a claim on e.g. a row in a full-house-only game is a false claim.
 */
export function checkWin(
  card: BingoCard,
  marked: boolean[][],
  calledNumbers: Set<number>,
  allowed: ReadonlySet<string> = new Set(DEFAULT_WINNING_PATTERNS),
): WinningPattern | null {
  const isMarked = (c: number, r: number) => marked[c][r] || (c === 2 && r === 2) || calledNumbers.has(card[c][r]);

  if (allowed.has('full_house')) {
    const all: [number, number][] = [];
    for (let c = 0; c < 5; c++) for (let r = 0; r < 5; r++) all.push([c, r]);
    if (all.every(([c, r]) => isMarked(c, r))) return { type: 'full_house', description: 'Full house', cells: all };
  }
  for (let r = 0; r < 5 && allowed.has('row'); r++) {
    if ([0, 1, 2, 3, 4].every((c) => isMarked(c, r))) {
      return { type: 'row', description: `Row ${r + 1}`, cells: [0, 1, 2, 3, 4].map((c) => [c, r]) };
    }
  }
  for (let c = 0; c < 5 && allowed.has('column'); c++) {
    if ([0, 1, 2, 3, 4].every((r) => isMarked(c, r))) {
      return { type: 'column', description: `Column ${c + 1}`, cells: [0, 1, 2, 3, 4].map((r) => [c, r]) };
    }
  }
  if (allowed.has('diagonal') && [0, 1, 2, 3, 4].every((i) => isMarked(i, i))) {
    return { type: 'diagonal', description: 'Diagonal ↘', cells: [0, 1, 2, 3, 4].map((i) => [i, i]) };
  }
  if (allowed.has('diagonal') && [0, 1, 2, 3, 4].every((i) => isMarked(4 - i, i))) {
    return { type: 'diagonal', description: 'Diagonal ↙', cells: [0, 1, 2, 3, 4].map((i) => [4 - i, i]) };
  }
  const corners: [number, number][] = [
    [0, 0],
    [4, 0],
    [0, 4],
    [4, 4],
  ];
  if (allowed.has('corners') && corners.every(([c, r]) => isMarked(c, r))) {
    return { type: 'corners', description: 'Four corners', cells: corners };
  }
  return null;
}

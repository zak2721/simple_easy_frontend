import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Audit finding SEC-9 (Medium): this app is "secure by convention" — every
 * controller today correctly declares `@UseGuards(...)` or `@Public()`, but
 * nothing enforces that for the NEXT controller someone adds. A full
 * "default-deny" global guard refactor was considered and rejected here: it
 * would touch every existing controller's guard stack (real regression risk
 * across ~19 files) for a benefit this cheaper static check already
 * delivers — catching a genuinely unauthenticated route at CI time, before
 * it ships, rather than at runtime.
 *
 * This is deliberately a source-text scan, not a reflection-based check
 * against Nest's internal `__guards__` metadata key — that key isn't part of
 * Nest's public API and could change across major versions; grepping for the
 * decorators developers actually type is more stable and just as effective
 * for what this test needs to catch.
 */
function findControllerFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      findControllerFiles(full, out);
    } else if (entry.endsWith('.controller.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('every controller declares an explicit auth stance', () => {
  const srcDir = join(__dirname, '..', 'src');
  const controllerFiles = findControllerFiles(srcDir);

  it('found at least the known controllers (sanity check the scan itself works)', () => {
    expect(controllerFiles.length).toBeGreaterThanOrEqual(18);
  });

  for (const file of controllerFiles) {
    const relative = file.split('backend')[1] ?? file;
    it(`${relative} has @UseGuards(...) and/or @Public() somewhere in the file`, () => {
      const source = readFileSync(file, 'utf8');
      const hasGuard = /@UseGuards\(/.test(source);
      const hasPublic = /@Public\(\)/.test(source);
      expect(
        hasGuard || hasPublic,
        `${relative} has neither @UseGuards(...) nor @Public() anywhere — ` +
          `every route in it is either unintentionally unauthenticated or ` +
          `needs an explicit @Public() to document that it's deliberate.`,
      ).toBe(true);
    });
  }
});

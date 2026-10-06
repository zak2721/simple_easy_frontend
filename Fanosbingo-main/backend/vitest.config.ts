import { defineConfig } from 'vitest/config';

/**
 * Audit finding TEST-1 (Critical): no backend vitest config existed at all —
 * `vitest run` fell back to the default include pattern (`src/**\/*.test.ts`,
 * shared with the frontend's own config at the repo root), which doesn't
 * match either this project's `*.spec.ts` naming or its `src/**\/__tests__/`
 * + `test/` directory layout. In practice this meant `npm test` inside
 * `backend/` silently ran ZERO tests and reported success — the single
 * existing test file (`src/cards/__tests__/bingo-card-generator.test.ts`)
 * was never actually executed by CI or by a developer running `npm test`
 * from this directory.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'src/**/__tests__/**/*.test.ts', 'test/**/*.spec.ts'],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.service.ts'],
      exclude: ['src/**/*.module.ts', 'src/**/*.dto.ts', 'src/**/dto/**'],
      thresholds: {
        // Audit finding TEST-1/TESTING PLAN: the 7 financial/game-engine
        // services (wallet, bonus, deposits, withdrawals, referrals, bingo,
        // games) now have real unit suites at 50-100% each — see their
        // *.service.spec.ts files. Every OTHER service (auth, admin, cards,
        // settings, storage, telegram, theme, users, game-rules, ...) is
        // still at 0%, which drags this GLOBAL aggregate down to ~21%
        // despite the financial core being well covered. Set just below the
        // current honest baseline so CI reflects real regressions rather
        // than failing on a number nothing has actually regressed from.
        // Ratchet this up as each additional service in TESTING_PLAN.md gets
        // a real spec file — do not raise it without new coverage backing it.
        lines: 20,
        statements: 20,
        branches: 30,
        functions: 35,
      },
    },
  },
});

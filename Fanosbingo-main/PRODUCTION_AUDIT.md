# YEGNA BINGO PRODUCTION AUDIT

*Audited: 2026-10-02 — codebase at commit d13bbd8 (main)*

---

## Overall Assessment

The codebase is structurally sound and architecturally mature: DB-level immutability triggers, Row-Level Security, two-factor admin auth, timing-safe secret comparison, and 19 spec files covering all critical services are all in place. No old "Fanosbingo" / "Edusoccer" branding survives in any user-visible surface. Two issues stand out as pre-launch blockers: prize-pool arithmetic operates on JavaScript `Number` (float64) after converting Prisma `Decimal`, and Redis is provisioned in the production stack but no backend module actually uses it — dead infrastructure that widens the attack surface without delivering a benefit.

---

## CRITICAL BLOCKERS

*(items that would cause data loss, security breach, or silent money errors in production)*

### C-1 — Prize-pool arithmetic on JS `Number` (float64)

**File**: `backend/src/bingo/bingo.service.ts`, line 117

```ts
const totalPot = Number(game.total_pot);   // Prisma.Decimal → float64
// ...
const winnerPool = Math.floor((totalPot * winnerPct) / 100);   // line 148
```

`game.total_pot` is stored as `DECIMAL(14,2)` and arrives as a `Prisma.Decimal` object. Calling `Number()` on it converts to IEEE-754 float64 before the `Math.floor` multiply. Because ETB prices are currently always integer values (5 ETB, 10 ETB), and float64 is exact for integers below 2^53, in practice this has not caused a mis-payout. However, the pattern is structurally unsafe: if a fractional price or a room price change is introduced without updating this code path, rounding errors will silently under- or over-pay players with no DB-level detection.

**Also affected**:
- `backend/src/games/games.service.ts`, lines 154–155, 496, 710 — `Number(game.totalPot)`, `Number(g.totalPot)` used in game serialization and refund path
- `backend/src/bingo/bingo.service.ts`, line 139 — `Number(c.entryPrice)` in the notification payload (display only, not money movement)
- `backend/src/bonus/bonus.service.ts`, line 106 — `Math.round(amount * wageringMultiplier)` where `amount` is already a `Decimal`

**Recommendation** (audit only — do not fix here): Use `Prisma.Decimal` arithmetic or convert only at the final serialization boundary, not before arithmetic.

---

### C-2 — ALLOW_UNVERIFIED_TELEGRAM present in code with frontend path to trigger it

**Files**:
- `backend/src/telegram/telegram.service.ts`, line 55
- `src/lib/session.tsx`, line 61–62
- `backend/src/auth/dto/auth.dto.ts`, line 9

The flag is gated behind `=== 'true'` and the prod compose hard-codes `ALLOW_UNVERIFIED_TELEGRAM: "false"` (not an env-var substitution, so it cannot accidentally be overridden by a shell variable). However, `VITE_DEV_TELEGRAM_USER` is a **build-time** variable baked into the JS bundle by Vite. If the production Docker image is ever built with that variable set in the build environment (e.g., a CI runner that has `.env` on disk), the dev bypass JSON object will be present in the minified bundle and visible to any player who inspects the network response.

**Current risk level**: CRITICAL only if build env has `VITE_DEV_TELEGRAM_USER` set. Without it the frontend guard at `src/lib/session.tsx:64` (`if (!initData && !devUser)`) throws and the path is unreachable. Confirm the production build pipeline does **not** set this variable.

---

## HIGH PRIORITY

*(items that need fixing before public launch)*

### H-1 — Redis provisioned but unused — dead infrastructure

**Files**: `docker-compose.prod.yml`, `backend/.env.example` (line 74–81)

Redis is defined as a service in both `docker-compose.yml` and `docker-compose.prod.yml`, with a healthcheck and a `REDIS_URL` env var wired into the backend. The `.env.example` itself documents this as a finding: *"NOTHING in backend/src actually uses a Redis client today."* The five files that import `cache`/`redis` keywords (`admin/finance.service.ts`, `operators/operators.service.ts`, `storage/storage.controller.ts`, `theme/theme.service.ts`, `wallet/wallet.service.ts`) contain those keywords only as comments or coincidental matches — no `RedisModule`, `IORedis`, or `ioredis` import exists in any source file.

Consequence: the Redis container is an exposed, unauthenticated service running in the production network with no password set (neither `docker-compose.prod.yml` nor the compose volumes configure a `requirepass`). It consumes memory and is a lateral-movement target if any other service in the Docker network is compromised.

**Action**: Either wire Redis in (rate limiting, session store, pub/sub for game state) or remove the service and `REDIS_URL` from the prod compose before go-live.

---

### H-2 — Telegram HTML injection via admin rejection reason (SEC-10)

**File**: `backend/src/telegram/telegram.service.ts`, lines 17–29

The service documents its own finding: every outbound message uses `parse_mode: 'HTML'`, and an admin's free-text `rejectionReason` is embedded raw into the HTML-mode Telegram message sent to the affected player. An admin (or compromised admin account) could embed `<a href="…">Click here</a>` styled to appear as an official platform link. The escape helper `escapeTelegramHtml()` is defined on line 27 but call sites in `deposits.service.ts` and `withdrawals.service.ts` must be verified to actually use it — the comment says they do not as of the audit.

**Action**: Audit every call to `sendMessage` with `parse_mode: 'HTML'` that includes dynamic content; wrap all non-hardcoded strings through `escapeTelegramHtml()`.

---

## MEDIUM PRIORITY

*(items to fix before or shortly after launch)*

### M-1 — `PLATFORM_ENCRYPTION_KEY` optional but silently a no-op

**File**: `docker-compose.prod.yml`, line 81: `PLATFORM_ENCRYPTION_KEY: ${PLATFORM_ENCRYPTION_KEY:-}`

The `:-` default makes this silently empty. If a second operator is onboarded and given their own bot token, the token is encrypted at rest with this key. If the key is empty the encryption step will fail (or use a zero key depending on the AES-GCM implementation) at the moment the admin sets the bot token, not at deploy time. The operator flow will be broken with an opaque error.

**Action**: Add a startup check in `operators.service.ts` that warns at boot (log level WARN) when `PLATFORM_ENCRYPTION_KEY` is unset, and document in onboarding that it must be set before adding a second operator.

---

### M-2 — `Math.round(amount * wageringMultiplier)` on Decimal in bonus service

**File**: `backend/src/bonus/bonus.service.ts`, line 106

Same class of float-coercion issue as C-1. The `amount` arriving here is likely already a `number` (passed from the caller), but the pattern should be consistent with however C-1 is resolved.

---

### M-3 — games.service.spec.ts does not cover cartela-per-player limit

**File**: `backend/src/games/games.service.spec.ts`

The spec mocks `MAX_GAMES_PER_DAY` and `MAX_ACTIVE_PLAYERS` but does not test that `maxCartelasPerPlayer` from `SettingsService.getGameConfig()` is enforced. The enforcement lives in `backend/src/cards/cards.service.ts` (lines 62 and 66), but there is no dedicated spec for the cards service. Any refactor of `cards.service.ts` is unguarded by tests.

---

### M-4 — `finance.service.ts` balance reconciliation uses float arithmetic for reporting

**File**: `backend/src/admin/finance.service.ts`, line 264

```ts
const diff = Math.round((actual - expected) * 100) / 100;
```

`actual` and `expected` are derived from `Number(r._sum.amount ?? 0)` aggregations of `Decimal` wallet entries. The reconciliation diff is display-only (not a money movement), but showing a false diff to an operator auditing their books is a compliance problem.

---

### M-5 — `PUBLIC_STORAGE_PATH` volume persistence (already documented in compose, verify on deploy)

**File**: `docker-compose.prod.yml`, lines 89–94

This was a historical finding (DEVOPS-1) that has been patched: `public_storage_data` volume is now defined and mounted at `/app/storage/public`. Verify that the volume survives `docker compose down && up` on the target host and that its bind path is included in backup procedures.

---

## LOW PRIORITY / WARNINGS

### L-1 — Redis has no password in docker-compose.prod.yml

Even with Redis unused today (see H-1), if it is ever wired in without adding `requirepass`, any container on the internal Docker network can connect to it without authentication.

### L-2 — SENTRY_DSN optional but unset means zero error visibility

**File**: `backend/.env.example`, line 63

`SENTRY_DSN` is documented as optional. Without it, unhandled exceptions in production are logged to container stdout only. For a money-handling service, Sentry (or an equivalent) should be considered mandatory.

### L-3 — `vitest.config.ts` at root has no coverage threshold

**File**: `vitest.config.ts` (root)

There is no `coverageThreshold` configured. CI will pass even if coverage drops to zero. With 19 spec files this is currently fine, but a threshold guards against future regressions.

### L-4 — `bcryptjs` and `argon2` both present in backend

**File**: `backend/package.json`, lines 36 and 37

Two password-hashing libraries are installed. This is not a security vulnerability (both are strong), but dead code (`bcryptjs`) should be removed to reduce the dependency surface.

### L-5 — `MIGRATE_DATABASE_URL` default in backend/.env.example uses `postgres:postgres`

**File**: `backend/.env.example`, line 20: `MIGRATE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/yena_bingo`

The placeholder default for the superuser URL uses `postgres:postgres`. Any operator who copies `.env.example` to `.env` without changing this will run migrations with the default Postgres password. The `docker-compose.prod.yml` correctly uses `:?` forcing it to be set, but the backend-only `.env.example` does not.

---

## AUDIT BY AREA

### Branding

| Search term | src/ | public/ | Result |
|---|---|---|---|
| `Fanosbingo` / `fanosbingo` | 0 hits | 0 hits | Clean |
| `Edusoccer` / `edusoccer` | 0 hits | 0 hits | Clean |
| `yena-bingo` (package name) | — | — | Correct (package.json `name`) |
| `yena_bingo` (DB name) | — | — | Correct (compose + .env.example) |

`index.html` title: `"የኛ bingo"`. `public/manifest.webmanifest` description correct. No user-visible old brand names remain.

---

### Security / Dev Bypasses

| Bypass | Location | Prod-safe? |
|---|---|---|
| `ALLOW_UNVERIFIED_TELEGRAM` | `backend/src/telegram/telegram.service.ts:55` | Yes — hard-coded `"false"` in prod compose |
| `VITE_DEV_TELEGRAM_USER` | `src/lib/session.tsx:61` | Build-time — must verify CI build env has it unset (C-2) |
| `devTelegramUserId` DTO field | `backend/src/auth/dto/auth.dto.ts:9` | Backend gate works; ALLOW_UNVERIFIED_TELEGRAM blocks it |
| Webhook secret validation | `backend/src/telegram/telegram-bot.controller.ts:64` | Enforced, timing-safe (good) |

---

### Financial Safety

| Pattern | File | Line | Risk |
|---|---|---|---|
| `Number(game.total_pot)` before `Math.floor` | `bingo/bingo.service.ts` | 117, 148 | C-1 — float conversion before prize math |
| `Number(game.totalPot)` in refund | `games/games.service.ts` | 710 | C-1 — same class |
| `Math.round(amount * wageringMultiplier)` | `bonus/bonus.service.ts` | 106 | M-2 |
| `Math.round((actual - expected) * 100) / 100` | `admin/finance.service.ts` | 264 | M-4 — reporting only |
| `houseShare + distributedToWinners === totalPot` invariant | `bingo/bingo.service.ts` | 160–161 | Already fixed (GAME-2) — pot never lost |
| `DECIMAL(14,2)` for all money columns | `backend/prisma/schema.prisma` | 228, 312–314, 396–400, 535, 577, 620, 658 | Good — DB is safe |
| `{ increment: perWinner }` Prisma atomic update | `bingo/bingo.service.ts` | 167 | Good — integer increment |

Minimum enforced values (from settings service, not hardcoded):
- `minDepositEtb` = 30 ETB (default per `deposits.service.spec.ts:47`)
- `minWithdrawalEtb` = 200 ETB (default per `withdrawals.service.spec.ts:41`)
- Cartela limit: `config.maxCartelasPerPlayer` (global) AND `room.maxPerPlayer` (per-room), both enforced in `cards/cards.service.ts:62,66`

---

### Database Constraints

- `wallet_ledger` immutability: `BEFORE UPDATE OR DELETE` trigger `wallet_ledger_immutable` created in `backend/prisma/migrations/20260919032018_ledger_immutability/migration.sql`.
- `audit_logs` immutability: same trigger function, separate trigger on `audit_logs`.
- Indexes: comprehensive — `wallet_ledger` has 5 indexes including `(entry_type, created_at)` and `(operator_id, created_at)`; `game_cartelas` has composite unique on `(game_id, room_id, cartela_number)`.
- Money columns: all `DECIMAL(14,2)` — no `FLOAT` or `REAL` in the schema.
- `MIGRATE_DATABASE_URL` / `directUrl` correctly separates migration superuser from runtime `app_runtime` role with RLS.
- No missing critical indexes identified.

---

### Docker & Deployment

**`backend/Dockerfile`**:
- Multi-stage build (node:22-alpine) — good
- Non-root `app` user — good
- Healthcheck on `/api/health` — good
- `chmod +x docker-entrypoint.sh` and `chown -R app:app /app` — good
- Prisma `generate` runs in build stage — correct

**`docker-compose.prod.yml`**:
- Postgres and Redis have no exposed `ports:` — internal-only — good
- All critical env vars use `:?` (fail-fast if unset) — good
- `ALLOW_UNVERIFIED_TELEGRAM: "false"` hard-coded — good
- `public_storage_data` volume present — DEVOPS-1 resolved
- Redis password not set — see L-1
- Redis unused — see H-1

**`Caddyfile`**:
- Automatic TLS (Let's Encrypt) — correct for Telegram Mini App HTTPS requirement
- HSTS header present — good
- gzip/zstd encoding — good
- No issues found

---

### Environment Variables

**Root `.env.example`** — all required variables documented; `VITE_DEV_TELEGRAM_USER` defaults to blank (correct for production).

**`backend/.env.example`** — complete. Notable:
- `TELEGRAM_WEBHOOK_SECRET` documented and required — good
- `PLATFORM_ENCRYPTION_KEY` documented as optional but carries a critical data-loss warning — see M-1
- `REDIS_URL` documented as provisioned but unused — see H-1
- `SENTRY_DSN` optional — see L-2
- `MIGRATE_DATABASE_URL` default uses `postgres:postgres` placeholder — see L-5

---

### Test Coverage

19 spec files found under `backend/src/`:

| Area | Spec file |
|---|---|
| Admin finance | `admin/finance.service.spec.ts` |
| Audit | `audit/audit.service.spec.ts` |
| Auth security | `auth/auth-security.spec.ts` |
| Bingo (prize calc) | `bingo/bingo.service.spec.ts` |
| Bonus | `bonus/bonus.service.spec.ts` |
| TOTP | `common/crypto/totp.spec.ts` |
| Tenant / operator scope | `common/tenant/operator-scope.spec.ts` |
| Deposits | `deposits/deposits.service.spec.ts` |
| Game rules | `game-rules/game-rules.service.spec.ts` |
| Games | `games/games.service.spec.ts` |
| Notifications | `notifications/notifications.service.spec.ts` |
| Approvals | `operator-management/approvals.service.spec.ts` |
| Rooms | `operator-management/rooms.service.spec.ts` |
| Staff | `operator-management/staff.service.spec.ts` |
| Referrals | `referrals/referrals.service.spec.ts` |
| FAQ | `support/faq.service.spec.ts` |
| Support | `support/support.service.spec.ts` |
| Wallet | `wallet/wallet.service.spec.ts` |
| Withdrawals | `withdrawals/withdrawals.service.spec.ts` |

No spec file for `cards.service.ts` (cartela selection / per-player limit enforcement) — see M-3.

`bingo.service.spec.ts` explicitly tests the pot-invariant (`houseShare + perWinner * n === totalPot`) at lines 162–189 — correctly catches GAME-2 class of bugs.

---

### API Security

- Telegram webhook: timing-safe comparison via `crypto.timingSafeEqual` — `telegram.service.ts:79–85`
- Webhook fails closed: `if (!expected) return false` — `telegram.service.ts:78`
- Admin routes: JWT + RBAC guard; ADMIN_KEY bootstrap is one-time use
- `CORS_ALLOWED_ORIGINS` locked to `https://${DOMAIN}` in prod compose
- Helmet middleware present (`backend/package.json`)
- `@nestjs/throttler` present (rate limiting module available)
- Telegram HTML injection via rejection reason (SEC-10) — see H-2

---

## CONCLUSION

**Ready for staging. Not ready for public launch without addressing C-1 and H-1.**

Must-fix before production traffic:
1. **C-1** — replace `Number(game.total_pot)` with `Prisma.Decimal` arithmetic in `bingo.service.ts` and `games.service.ts` to eliminate float64 exposure on prize calculations.
2. **H-1** — either wire Redis into a concrete use (rate limiting, pub/sub) or remove it from the prod compose to eliminate the unauthenticated internal service.
3. **C-2** — confirm production Docker build pipeline has `VITE_DEV_TELEGRAM_USER` unset; add a CI check.
4. **H-2** — verify that all `sendMessage` calls with `parse_mode: 'HTML'` that embed dynamic admin input pass through `escapeTelegramHtml()`.

Recommended before launch:
5. **M-1** — add a startup warning when `PLATFORM_ENCRYPTION_KEY` is unset.
6. **M-3** — add a spec for `cards.service.ts` covering the cartela-per-player limit.
7. **L-1** — add `requirepass` to the Redis service (even if H-1 removes it today; defence-in-depth if it returns).

Everything else (L-2 through L-5) is clean-up that can follow the first stable release.

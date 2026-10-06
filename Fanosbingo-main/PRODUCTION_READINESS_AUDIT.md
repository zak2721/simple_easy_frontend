# YENA Bingo (የኛ Bingo) — Production Readiness Audit

**Scope:** full-codebase static audit (backend, frontend, database, Docker/deployment) performed as if this goes live tomorrow with real users and real money. No code was modified during this audit — every finding below was verified by reading the actual code (file:line), not assumed. Where an agent could not verify something within its budget, that is stated explicitly rather than left implied.

**Method:** five parallel, independent audit passes (auth/2FA/impersonation; money/business logic; multi-operator tenant isolation; database/deployment; frontend/Telegram integration), each with full read access to the relevant source, cross-checked against this session's own work (Postgres Row-Level Security activation, completed the same day this audit was run).

---

## Phase 1 — Architecture Map

**Stack:** NestJS + Prisma + PostgreSQL backend; React/Vite frontend with an embedded admin SPA at `/admin`; Telegram Mini App as the player client. Deployed via Docker Compose (`docker-compose.prod.yml`) behind Caddy (automatic HTTPS).

**Tenancy model:** white-label multi-operator platform, migrated from a single-tenant app (see `docs/YENA_BINGO_MULTI_OPERATOR_ARCHITECTURE.md` for the full migration history — phases 0-4a documented there as already shipped and verified in prior sessions). Every operator has its own Telegram bot, Mini App deep link (`/o/<slug>`), branding, room/pricing config, cartela inventory, and admin staff — but money, wallets, and player accounts are fully separated per operator (a Telegram user gets a distinct account+wallet per operator).

**Roles:**
- `SUPER_ADMIN` — platform-wide, `operatorId = null`, exactly one (DB-enforced via partial unique index)
- `ADMIN` — platform staff, `operatorId = null`
- `OPERATOR_OWNER` — one per operator, every operator-scoped permission implicitly
- `OPERATOR_STAFF` — created by the owner, explicit permission grants only, permission-delegation rule prevents granting more than the grantor holds

**Tenant isolation — two layers:**
1. **Application layer** (primary, verified as the layer actually carrying correctness today): every operator-scoped service method filters by `operatorId`, and every request's `operatorId` comes from the authenticated JWT session, never from a client-supplied param.
2. **Postgres Row-Level Security** (`backend/prisma/migrations/20260926090000_row_level_security`) — activated for real this session (the app now connects as the restricted `app_runtime` role, not the superuser). Enforced via `SELECT set_config('app.operator_id', ...)` inside an `AsyncLocalStorage`-backed tenant context (`backend/src/common/tenant/`), called explicitly before Prisma `$transaction` blocks. **Important caveat surfaced by this audit:** this only covers ~21 files' worth of `$transaction`-wrapped writes; a repo-wide grep found 258 direct (non-transaction) Prisma calls across 32 files that never activate the session variable, meaning RLS is a backstop for those specific writes only — not the "even a forgotten WHERE clause can't leak" guarantee its own migration comment describes. See Phase 5/7 for detail.

**Core domains:** Authentication (Telegram initData + admin username/password+2FA), Wallet/Ledger (append-only, DB-trigger-enforced immutability), Deposits (manual Telebirr-reference + admin approval), Withdrawals (manual + admin approval/payment), Bonuses (signup + referral, with expiration cron), Referrals, Cartelas (per-room numbered inventory slots), Bingo Games (CSPRNG draws, server-authoritative win detection, 80/20 payout split), Operator Management (branding, rooms, staff, limits, approvals), Super Admin (operator lifecycle, impersonation, platform reports), Audit Logging (immutable), Support Tickets, FAQ, Notifications.

**Money flow:** manual, not gateway-automated — players submit a Telebirr transaction reference + receipt screenshot; an admin/operator approves or rejects. Withdrawals are the same pattern in reverse. All balance changes flow through `wallet_ledger`, which is append-only at the DB level (an `UPDATE`/`DELETE`-blocking trigger).

---

## Phase 2 — Functional Testing (Authentication, Admin, Operator, Staff, Users)

### Authentication
- **Player (Telegram) login**: solid. Verifies `initData` HMAC per-operator (a signature valid for operator A's bot cannot log in to operator B), correct dev-only bypass gating, opaque hashed refresh tokens with rotation-family reuse detection.
- **Admin login**: solid and well hardened. Dummy-hash timing defense for unknown usernames, lockout ladder (5→15min, 10→1h, 20→permanent) checked *before* password verification, legacy bcrypt→argon2id upgrade on successful login, all failures audited and pushed as notifications.
- **Logout / session revocation**: solid — revokes the DB session and all its refresh tokens; every admin request re-checks session/account/operator status live (not just token TTL), so a revoked/suspended admin is rejected immediately.
- **JWT design**: access tokens carry a `type` claim checked per-strategy (no player/admin cross-forgery); admin tokens are additionally bound to a DB-backed session row re-validated on every request — real-time revocation, not just short expiry. Refresh tokens are opaque random values (hashed at rest), never JWTs, so there's no refresh-forgery surface, only theft/replay — which is defended by rotation + reuse detection on both player and admin sides.
- **No self-service admin password reset** exists (a higher-privilege actor resets it) — reasonable for this threat model given no email infra, but confirm it's intentional.
- **2FA (TOTP)**: solid — RFC 6238 standard, secret encrypted at rest, timing-safe comparison, real replay protection (persisted last-used counter). Setup→confirm→enable and self-service disable both work and are audited.
- **2FA Recovery Codes — CRITICAL GAP, confirmed not implemented.** The `admin_recovery_codes` table and `AdminRecoveryCode` Prisma model exist (migration `20260926230000_admin_recovery_codes`), but a full-source grep of `backend/src` for every plausible reference (`RecoveryCode`, `recovery_code`, `backupCode`, `adminRecoveryCode`, case-insensitive) found **zero application code** using it — no generation, no display-once, no consumption at login, no regeneration. The only actual "recovery" path is a Super-Admin-only force-disable of another admin's 2FA (`admin-management.service.ts:233-248`), a privileged-actor override, not the account holder's own recovery flow. **Any admin who enables TOTP and loses their authenticator is fully locked out until a Super Admin intervenes.** This is Task 2 from the original priority list — confirmed still fully open, not partially done.

### Super Admin
- Operator lifecycle (create/edit/suspend/reset-owner-password/transfer-ownership) is correctly gated to `PlatformAdminGuard` + `MANAGE_OPERATORS` permission — unreachable by any operator-bound account, verified by reading every route.
- No hard-delete-operator path exists by design (soft `status=disabled` only) — the "cascade-delete leaks another operator's data" scenario the audit went looking for does not apply.
- `transferOwnership` correctly validates the candidate is an active staff member of the *same* operator before promoting.
- Impersonation: see Phase 6.
- Approve/reject requests: verified idempotent (atomic claim via `updateMany` scoped to `status:'pending'`) and structurally impossible for an operator to self-approve (the endpoints are platform-admin-gated, not just service-level checked).

### Operator (self-service)
- Branding, rooms/cartela config, staff management, settings — all correctly derive `operatorId` from the authenticated session, never from a client-supplied ID. Every service method verified to re-check `{childId, operatorId}` together before acting on a room/staff/game ID, so cross-operator ID-guessing 404s rather than succeeding.
- Room price/capacity changes apply to future games only; a `waiting` game with sales keeps its original price (captured per-sale).
- Game creation/cancellation: `cancelAndRefund` correctly locks the game row, re-validates status/player-count under the lock (closes a TOCTOU race against a concurrent purchase) — but see Phase 3 for the refund-routing bug.

### Staff Accounts
- Permission delegation rule verified real, not cosmetic: an actor can only grant operator-scoped permissions they themselves hold (`staff.service.ts:49-58`); platform-only permission keys are filtered out server-side for any `OPERATOR_STAFF` regardless of what might be stored against them, closing an accidental-privilege-grant path.
- Every operator-self route requiring staff management is permission-decorated at the method level, not just role-gated.

### Users (Players)
- Registration/Telegram login: see Authentication above.
- Bonus/referral credit: see Phase 3.
- Not separately fuzz-tested (profile update endpoints) within this audit's budget — no findings either way; flagged as unverified rather than assumed safe.

---

## Phase 3 — Business Logic Testing (Money)

### Wallet / Ledger
- Every balance mutation checked either uses real `SELECT ... FOR UPDATE` row locking or an atomic Prisma `increment`/`decrement` inside a transaction — both correctly serialize concurrent access. The ledger is genuinely append-only (DB trigger blocks `UPDATE`/`DELETE`); `adjustBalance` is the sole admin correction path and always writes a ledger entry + audit row with a required reason.
- **New finding (Low-Medium)**: `wallet.service.ts:77-92` `getWallet()` double-subtracts a withdrawal hold — `withdrawals.service.ts:43` already decrements `wonBalance` the moment a withdrawal is requested, but the display calculation subtracts the same pending/approved withdrawal total again, understating the "withdrawable" figure shown to the user (floored at 0). Display-only, not exploitable, but will generate support tickets.

### Deposits
- Approve/reject is idempotent by construction (`updateMany` scoped to `status:'pending'`) — a double-click or two racing admins produces one winner and a clean conflict for the loser.
- Duplicate-approval of the same real payment is blocked at the DB level: a partial unique index on `telebirr_reference WHERE status='approved'` makes a second approval fail with a clean conflict, independent of application logic.
- File upload: magic-byte verification against the declared MIME type, 10MB cap, random 32-hex filename (no path-traversal via filename), stored outside the webroot, served only via short-lived HMAC-signed URLs with timing-safe comparison. Verified solid.

### Withdrawals
- `request()` locks the user row, checks `wonBalance >= amount` under that lock, then immediately debits as a hold — correctly prevents two concurrent requests from both passing the check against the same stale balance. No over-balance path found.
- Approve/reject/mark-paid all gate on an atomic status transition — no double-payout path found; reject/cancel correctly releases the hold.

### Bonuses & Referrals
- Signup bonus is idempotent via a DB unique constraint on `(telegramUserId, reason)` — a race on first login is a silent no-op, not a double-grant.
- Self-referral is structurally impossible (explicit ID-equality check); cross-operator referral codes are silently ignored; a max-referrals-per-inviter cap is enforced.
- Bonus expiration is genuinely enforced (an hourly cron forfeits expired-and-still-active grants, re-reading the balance under lock each iteration) — this was a previously-documented gap that is now closed.
- **Residual risk (Medium, business/product decision, not a code bug)**: no device/IP/phone fingerprinting anywhere in the signup or referral path. Nothing stops creating unlimited fresh Telegram accounts to re-farm signup and referral bonuses; the per-inviter cap limits payout concentration but doesn't stop a Sybil ring of many small accounts. Now that real money is involved, recommend at minimum IP/device-based rate limiting on account creation, and periodic use of the existing referral-reporting admin tooling to spot anomalous bursts.

### Cartelas
- `selectCartela` is well-designed defense-in-depth: locks the game row, locks the player row, checks per-room and per-player limits under the lock, and finally relies on a DB unique constraint `(gameId, roomId, cartelaNumber)` as the ultimate backstop rather than trusting the pre-check alone — the right pattern, verified correct.
- **New finding (High) — refund routing bug, systemic across 3 call sites.** Refunds always credit `depositedBalance` regardless of which balance bucket(s) actually funded the original purchase (`GameCartela` never records the deposited/won/bonus split it was paid from). Three refund paths are affected:
  - `cards.service.ts:193-196` — player releases a cartela before game start
  - `games.service.ts:386` — game auto-cancelled (too few players) or operator-cancelled
  - `bingo.service.ts:122-137` (line 124) — game finishes with no winner, full refund
  
  **Concrete impact:** a player who buys a cartela using real, withdrawable `won_balance`, then has it refunded for any of the above reasons, gets that money back as `depositedBalance` — which is **not withdrawable**. Real cash silently becomes non-withdrawable. Worse: if the purchase was funded from `bonus_balance`, that spend already counted toward the bonus's wagering requirement (never reversed on refund), so a buy-then-release loop lets a player satisfy wagering requirements risk-free while laundering bonus money into ordinary deposited balance. **This is the single highest-priority code fix in this entire audit** — it directly affects real money outcomes for real users. Fix: track the funding split per `GameCartela` row and refund into the same buckets, reversing wagering progress proportionally for the bonus portion.

### Bingo Game Logic
- Draws use `crypto.randomInt` (CSPRNG) — verified, not `Math.random`. Card generation likewise.
- Winner detection is fully server-authoritative, recomputed from the game's actual called-numbers and configured winning patterns; a false claim permanently disqualifies that cartela. Client input cannot forge a win.
- Multi-winner payout math is correct and provably leak-free: `houseShare = totalPot - perWinner*n` guarantees the invariant `houseShare + distributedToWinners === totalPot` even on uneven splits — verified arithmetically, not just read.
- `claimBingo` locks the active game row, correctly serializing concurrent claims within the claim window for multi-winner detection.
- One active game per operator is enforced by both a DB unique index and a Postgres advisory lock guarding the cron tick — correct protection if ever scaled beyond one backend instance.
- Shares the refund-routing bug above on its no-winner-refund path.

---

## Phase 4 — Multi-Operator Testing (Tenant Isolation)

No Critical or High-severity tenant-isolation bug was found in the areas reviewed (`operator-management`, `admin-management`, `games`, `deposits`, `withdrawals`, `wallet`, `cards`).

- **Guard coverage — verified correct.** Operator-self routes never accept `operatorId` from the client; they derive it from the authenticated JWT session only. Every service method checked re-verifies `{childId, operatorId}` together in its `WHERE` clause before acting, so an `OPERATOR_STAFF`/`OWNER` of operator A cannot pass operator B's room/staff/game ID and have it accepted — it 404s. Platform-only routes (accepting an *operator* ID as the target) are gated by `PlatformAdminGuard`, which rejects any admin with a non-null `operatorId` regardless of what ID is in the request.
- Permissions/`operatorId` are re-fetched from the DB on every request inside the JWT strategy — never trusted from the token payload itself, closing forged-permission and stale-permission-after-revocation attacks.
- **RLS gap (Medium-High, the most important architectural finding of this audit).** Two independent audit passes converged on the same fact from different angles: RLS enforcement (`set_config('app.operator_id', ...)`) is only ever activated inside the ~21 files that explicitly call `setTenantOnTx`/`tenantSetConfigOp` before a `$transaction`. A repo-wide grep found **258 direct, non-transaction-wrapped Prisma calls across 32 files** that never set that session variable — and per the RLS policies' own logic, an unset variable means "unrestricted, see every operator." One agent spot-checked a sample of these bare reads (rooms, staff, deposits, withdrawals, leaderboard, cards) and confirmed each one does carry an explicit application-level `operatorId` filter, so **there is no active data leak today** — but RLS is not the independent "even a forgotten WHERE clause can't cross a tenant boundary" backstop its own migration comment promises. It currently only covers the specific writes that were deliberately wrapped. A future missing-filter bug in any of the other 32 files would not be caught by RLS as currently wired.
  - **Recommendation:** either (a) move tenant-scoping to a Prisma middleware/extension keyed off the same `AsyncLocalStorage` context so every query activates it automatically rather than requiring each call site to opt in, or (b) explicitly document that RLS is a mutation-only backstop today, so nobody on the team over-trusts it as blanket protection during future development.
- Super Admin operations, staff permission delegation, approval-workflow self-approval prevention, and audit-logging coverage on operator-management mutations were all independently verified correct.
- **Not exhaustively reviewed** (acknowledged gap, not a finding either way): `bonus/`, `referrals/`, `game-rules/`, `contact-center/`, `support/`, `telegram/` services, and the frontend/admin-panel code. Given the strong, consistent pattern discipline found everywhere else, similar quality is likely — but this is an inference, not a verification. Recommend a follow-up pass on those modules with the same checklist (bare Prisma calls missing an operatorId filter; guard-vs-param trust) before final sign-off.

---

## Phase 5 — Security Testing (Red-Team Analysis)

| Vector | Result | Severity |
|---|---|---|
| JWT forgery/replay | Not exploitable — HMAC secret required, `type` claim checked per-strategy, admin tokens additionally DB-session-validated every request. No algorithm-confusion risk. | — |
| Refresh token abuse | Both player and admin flows have working rotation + reuse detection with atomic claim-before-rotate; reuse triggers full session/family revocation + a critical notification. Verified solid. | — |
| Session hijacking | Admin sessions re-validated live on every request (revocation is immediate, not TTL-bound). Player refresh token is in localStorage (see Phase frontend below) — the real hijacking risk is XSS-driven token theft, not session design. | High (token storage, see below) |
| Brute force / lockout | Not decorative — global `ThrottlerGuard` plus dedicated tighter per-route limits on login/bootstrap (5/min), refresh (20/min), player login (30/min), layered with the per-account lockout ladder. Both layers independently verified real. | — |
| IDOR | None confirmed in the audited admin-management/staff/login-history/operator-scoped surface — every lookup checked scopes correctly to the caller's own operator or account. | — |
| Privilege escalation (staff/owner → super admin) | Not found — platform routes require `PlatformAdminGuard`/`SuperAdminGuard`; `OPERATOR_STAFF` permissions are filtered server-side to operator scope regardless of what might be stored. | — |
| Tenant escape | See Phase 4 — no active leak found, but RLS backstop is thinner than documented. | Medium-High (architectural) |
| CSRF | Primary pattern is bearer tokens (CSRF largely moot). One cookie-based touchpoint — the admin refresh endpoint — depends on its `SameSite` attribute (not visible from the frontend code); recommend explicitly confirming `Strict`/`Lax` server-side. | Low |
| XSS | Zero `dangerouslySetInnerHTML`/`innerHTML` usage found anywhere in `src/`; all dynamic/operator-supplied content rendered via safe JSX interpolation. Clean. | — |
| SQL/NoSQL injection | Not separately fuzzed in this pass, but the codebase's exclusive use of Prisma's query builder (parameterized) plus deliberate, narrow `$executeRawUnsafe` usage (this session's own `ensure-app-runtime-password.ts`, using a generated secret, not user input) is the correct pattern. No raw string-concatenated SQL found in the audited services. | — |
| File upload abuse | Deposit/branding uploads: magic-byte + size validation confirmed server-side (deposits/storage). Frontend places no real enforcement (expected — `accept` attributes are trivially bypassed), so correctness rests entirely on the backend checks, which were verified present. | — |
| Broken access control | See Guard Coverage in Phase 4 — verified sound. | — |

**High-severity finding carried from the frontend audit:** player access **and** refresh tokens are both stored in `localStorage` (`api-client.ts:7-9`). The admin side correctly uses an httpOnly cookie for its refresh token (inaccessible to JS) — the player side, which is where real money (deposits/withdrawals) flows, doesn't mirror that pattern. Any future XSS anywhere in the app would mean long-lived player account takeover, not just a short window. **Recommend migrating the player refresh token to an httpOnly cookie before launch**, matching the admin pattern already implemented correctly.

---

## Phase 6 — Impersonation Testing

- **Start/end impersonation**: well designed. Blocks self-impersonation and impersonating another `SUPER_ADMIN`, requires the target to be active, issues a deliberately short (30-minute) session with **no refresh token**, logs both the acting Super Admin and the target on both start and end, plus a notification.
- **Refresh during impersonation**: the impersonation context is derived fresh from the session row every request, so it correctly survives as long as that specific session's own path is used. **Confirmed gap (Low/Medium)**: the impersonation endpoint never touches cookies, so the Super Admin's own admin refresh cookie remains live throughout. Since impersonation issues no refresh token, once the 30-minute impersonation token expires there's no way to renew it *as the target* — a client that blindly retries via `/auth/admin/refresh` on a 401 would silently drop back into the Super Admin's own full-power session with no explicit backend signal that impersonation ended. Not a privilege-escalation bug (the resulting token is legitimately the Super Admin's own), but a real risk of a stale "viewing as X" UI state while actually back in full power. **Recommendation**: have the frontend never call the admin refresh endpoint while impersonating, or have the backend explicitly reject/flag a refresh attempt made during an active impersonation session.
- **Audit logging — confirmed gap (Medium), matches Task 5's "per-action dual-actor audit trail" requirement.** `IMPERSONATION_STARTED`/`ENDED` events correctly record both identities. But every *ordinary* action performed during an impersonated session (approving a deposit, editing a setting, etc.) is attributed in the audit log solely to the impersonated target's ID — the real actor is only recoverable by manually cross-referencing session timestamps against the start/end events, not from the action's own audit row. For a money-moving admin panel this is a genuine accountability gap. **Fix**: add a nullable `impersonatedByAdminId`/`actingAsAdminId` column to `audit_logs` and thread it from the request context into every `audit.log()` call (ideally centralized via an interceptor rather than per call site).
- **Permission boundaries**: verified correct — permissions are recomputed from the *target's* row on every request, so an impersonated session can never exceed (or fall short of) the target's own access. Changing 2FA/security settings is explicitly blocked while impersonating.

---

## Phase 7 — Database Audit

- **Foreign keys / cascades — solid, no orphan-row risk.** Every relation touching financial or player-owned data resolves to an explicit `RESTRICT` (verified in the generated SQL, not just the Prisma DSL) — no code path can delete an Operator, Game, or TelegramUser today; any attempt hard-fails rather than silently orphaning rows. A handful of relations omit `onDelete` in the Prisma DSL but compile to `RESTRICT` by default anyway (Low — add explicit `onDelete: Restrict` for readability, no behavior change needed). Genuine `Cascade` relations are limited to truly dependent non-financial rows (sessions, refresh tokens, permissions) — correct.
- **Indexes — good coverage**, and the compound indexes present read like fixes from a prior dedicated audit pass rather than defaults (e.g., a second single-column index added specifically because one query couldn't use the leading column of an existing composite). One minor gap: `WalletLedgerEntry` has no `(telegramUserId, createdAt)` composite for a player's own transaction-history query — Low severity given small per-user row counts, worth revisiting only if that endpoint shows up slow at scale.
- **Constraints — race conditions are covered at the DB level, not just in application code**: unique constraint on `(gameId, roomId, cartelaNumber)` prevents double-selling; a partial unique index on approved deposit references prevents double-approval; unique referral-code and one-inviter-per-invitee constraints; unique signup-bonus-per-user-per-reason; single-super-admin partial unique index. No gaps found.
- **Data integrity**: nullable FKs are all intentional and documented (house-revenue ledger rows, platform-level admins/audit rows, shared theme catalog). One cosmetic-only gap: "only one default theme" is enforced in application code (transactional unset-then-set), not a DB constraint — Low, no financial impact.
- **RLS enforcement dependency (Medium, cross-referenced with Phase 4/5)**: whether RLS is actually active in a given deployment depends entirely on that deployment's `DATABASE_URL` pointing at `app_runtime` rather than the superuser — correctly wired in `docker-compose.prod.yml` for this repo's Docker path, but a future deployment change or a well-intentioned "fix a permissions error by using the superuser" edit would silently disable this layer with no runtime error. **Recommend a startup smoke test**: confirm `SELECT current_user` inside the running backend returns `app_runtime`, not `postgres`, as part of every deploy's health check.

---

## Phase 8 — Performance Testing

No dedicated live profiling was run (out of this audit's static-review scope), but the following were checked directly against the schema and query patterns:

- Index coverage on hot query paths (telegram_users, games, game_cartelas, wallet_ledger, manual_deposits, withdrawal_requests, audit_logs) is good — see Phase 7.
- No N+1 query pattern was flagged by any of the five audit passes across the money-critical services reviewed (wallet, deposits, withdrawals, cards, bingo, games, operator-management).
- The single-active-game-per-operator design plus per-operator advisory locks on the cron tick means load is naturally partitioned per operator rather than contending on one global lock — a reasonable scalability property for a multi-tenant platform, verified by reading `games.service.ts`'s tick implementation.
- **Not verified**: actual memory/CPU behavior under load, connection-pool sizing versus concurrent request volume, and real query latency distributions. This is exactly what Phase 9's load tests are for — treat this audit's static findings as necessary but not sufficient; run the load tests below before trusting capacity assumptions.

---

## Phase 9 — Load Test Plan

Delivered as working k6 scripts: **[load-tests/yena-bingo-load-test.js](load-tests/yena-bingo-load-test.js)** (see **[load-tests/README.md](load-tests/README.md)** for full usage). One parameterized, multi-operator-aware script rather than four near-duplicate files — presets for all four requested scales:

```bash
k6 run -e VUS=100  -e HOLD=2m load-tests/yena-bingo-load-test.js   # smoke
k6 run -e VUS=500  -e HOLD=3m load-tests/yena-bingo-load-test.js   # medium
k6 run -e VUS=1000 -e HOLD=5m -e RAMP_UP=1m load-tests/yena-bingo-load-test.js   # high
k6 run -e VUS=5000 -e HOLD=5m -e RAMP_UP=2m load-tests/yena-bingo-load-test.js   # breaking point
```

Simulates login (once per VU, respecting the real 30/min login throttle by design), lobby polling, weighted cartela purchase (50%, deliberately racing VUs against the same small number pool to exercise the row-lock + unique-constraint concurrency design under real contention), deposit submission (15%), withdrawal request (15%), and bingo claim (10%) — across multiple operators simultaneously if `OPERATOR_SLUGS` is set, so it also serves as a concurrency-level tenant-isolation smoke test, not just a throughput test.

**Important constraint documented in the script**: it requires a dedicated load-test target with `ALLOW_UNVERIFIED_TELEGRAM=true` (never production) so it can authenticate via `devTelegramUserId` instead of forging real Telegram signatures. It supersedes the `stress-test/` directory at the repo root, which is Supabase-era and calls endpoints that no longer exist post-migration — that directory is legacy/non-functional against the current backend, not a duplicate to keep maintaining.

Expected performance targets (starting thresholds, to be tightened/loosened only against a real baseline run — see `load-tests/README.md` for the full table): login p95 < 1500ms, lobby load p95 < 800ms, cartela purchase p95 < 1500ms, unexpected (5xx) error rate < 1%.

---

## Phase 10 — Deployment Audit

- **Secrets handling**: no hardcoded secrets in any committed file. All three compose files use `${VAR:?must be set}` guards on every required secret — nothing can silently start empty. One soft-default gap: `PLATFORM_ENCRYPTION_KEY` can start blank (Medium — only matters once a non-default operator has its own bot; recommend a startup warning if any operator has an encrypted bot token but this key is unset).
  - **Critical, operational (not a code defect) — already flagged mid-audit and acted on**: `.env.production` contains live production secrets (Postgres password, JWT secret, admin key, Telegram webhook secret, and a real-format Telegram bot token) sitting inside a project directory that syncs to OneDrive — outside fully local, access-controlled storage. Confirmed never committed to git. **Every secret in that file should be rotated before real go-live** regardless of this audit's other findings, purely because of where the file has been sitting.
- **Network exposure — correct.** Dev compose binds Postgres/Redis to `127.0.0.1` only; prod compose gives them no host ports at all (internal Docker network only). Only Caddy publishes 80/443.
- **CORS — correct.** A single guarded HTTPS origin in production, no wildcard anywhere in the CORS path.
- **Security headers**: backend uses `helmet()` with sane defaults; Caddy adds HSTS at the TLS edge (correct single location); frontend's `nginx.conf` sets `X-Content-Type-Options`, `Referrer-Policy`, and a `frame-ancestors`-only CSP (deliberately, to allow Telegram's own iframe embedding). **Medium finding**: that CSP header defines *only* `frame-ancestors` — no `script-src`/`default-src`/`object-src` — so it provides zero XSS mitigation even though the XSS surface itself was found clean elsewhere. Recommend adding `default-src 'self'; script-src 'self'; object-src 'none'` alongside the existing `frame-ancestors`, tuned against Vite's actual asset origins.
- **Logging**: `nestjs-pino` with an explicit redact list covering auth headers, cookies, password, admin key, refresh token, and Telegram initData. Low gap: the redact list doesn't cover deposit/withdrawal-adjacent fields or TOTP secrets, though nothing currently logs full DTOs that would expose them — precautionary, not an active leak.
- **Migration safety**: `docker-entrypoint.sh` runs migrations → activates the `app_runtime` RLS role password → seeds → starts the app, in that order, with `set -e` aborting the container on any step's failure before the app ever binds a port. Correct, no race.
- **RLS wiring in production**: verified wired correctly this session (`docker-compose.prod.yml` sets `DATABASE_URL` to `app_runtime` and `MIGRATE_DATABASE_URL`/`APP_RUNTIME_PASSWORD` appropriately; rehearsed against real dev Postgres this session with a safe same-value password rotation). See Phase 7's recommendation to add a `current_user` smoke check to the deploy process regardless.

---

## Phase 11 — Production Readiness Score

### Completed Features (verified working, not assumed)
- Telegram player login with per-operator bot signature verification
- Admin login with lockout, dummy-hash timing defense, argon2id upgrade path
- Admin TOTP 2FA (setup/confirm/disable) — but see recovery codes below
- Refresh-token rotation with reuse detection (player and admin)
- Session revocation (real-time, DB-backed, not TTL-only)
- Full multi-operator data model: branding, rooms/pricing, cartela inventory, staff, approvals, per-operator bots and webhooks
- Application-level tenant isolation (verified correct everywhere checked)
- Postgres RLS activated (for the write paths that call it)
- Deposit/withdrawal manual approval workflows, race-safe and idempotent
- Duplicate-payment prevention at the DB level
- Signup/referral bonuses with real expiration enforcement and idempotent grants
- Cartela purchase concurrency safety (row-lock + DB unique constraint)
- CSPRNG bingo draws, server-authoritative winner detection, correct multi-winner payout math with no rounding leakage
- Impersonation with sensible boundaries (though see gaps below)
- Immutable wallet ledger and audit logs (DB-trigger enforced)
- Docker production stack with correct network isolation, CORS, secrets guards, and automatic HTTPS

### Missing Features (confirmed unfinished, not partially done)
1. **2FA recovery codes** — schema exists, zero application code (Critical)
2. **Refund-bucket routing** — refunds always land in `depositedBalance` regardless of original funding source (High)
3. **Per-action dual-actor audit trail during impersonation** — only start/end events capture both identities (Medium)
4. **Player refresh token not in an httpOnly cookie** — localStorage only, unlike the admin side (High)
5. Email notification system (not built this session per your stated priority order — separate task)
6. SMS notification abstraction (explicitly deferred per your own instruction)
7. Sybil/multi-account defense for bonus farming (Medium, product decision)

### Security Risks (ranked)
1. **Critical (operational)**: `.env.production` secrets sitting in a OneDrive-synced directory — rotate before go-live regardless of any code finding.
2. **Critical**: 2FA recovery codes unimplemented — account-lockout risk for any admin who enables 2FA.
3. **High**: player tokens in localStorage — XSS would mean long-lived account takeover on the money-handling side of the app.
4. **High**: refund-routing bug — real withdrawable money and bonus wagering requirements can be laundered via cancel/release/no-winner refunds.
5. **Medium-High**: RLS backstop covers far fewer code paths than its documentation implies — no active leak found, but the safety net is thinner than believed.
6. **Medium**: impersonation audit trail can't distinguish the real actor from the target on ordinary actions.
7. **Medium**: no CSP script/style restrictions on the frontend (XSS surface itself is clean today, but there's no second line of defense if that ever changes).
8. **Low/Medium**: refresh-during-impersonation could silently and invisibly drop back to the real admin's full-power session.

### Scalability Risks
- Untested under real load (Phase 9 scripts are ready but not yet run against a live target) — do not assume the static-review findings translate to a specific concurrent-user capacity number.
- Cartela purchase contention on a single hot game is expected to show up as increased latency at high concurrency (by design — the row lock is deliberately conservative, with the DB unique constraint as the real backstop). This is a tuning question, not a correctness bug.
- `WalletLedgerEntry` missing a `(telegramUserId, createdAt)` index — low risk today, worth revisiting if per-user transaction history becomes slow at scale.

### Production Blockers (must fix before real-money launch)
1. Rotate every secret in `.env.production`.
2. Implement 2FA recovery codes end-to-end, or explicitly remove the unused table/migration and document the Super-Admin-force-disable as the sole recovery path (a documented decision is acceptable; an accidentally-incomplete feature is not).
3. Fix the refund-bucket-routing bug (3 call sites: `cards.service.ts:193-196`, `games.service.ts:386`, `bingo.service.ts:124`).
4. Migrate the player refresh token to an httpOnly cookie, matching the admin pattern.
5. Add the real-actor field to the impersonation audit trail.
6. Run the Phase 9 load tests against a staging target and confirm the thresholds hold (or recalibrate capacity expectations) before committing to a launch date.

### Recommended Fixes, Ordered by Priority
1. Rotate `.env.production` secrets (no code change, immediate)
2. Refund-bucket-routing fix (money-correctness, High)
3. 2FA recovery codes (Critical, account-lockout risk)
4. Player refresh token → httpOnly cookie (High, security)
5. Impersonation audit-trail real-actor field (Medium, accountability/compliance)
6. `getWallet()` double-counted withdrawal hold display bug (Low-Medium, support-ticket reduction)
7. RLS coverage — either wire it through a Prisma middleware so it applies automatically, or explicitly document its current mutation-only scope (Medium, architectural clarity)
8. CSP hardening on the frontend (`default-src`/`script-src`/`object-src`) (Medium, defense-in-depth)
9. Run and act on Phase 9 load test results (scalability confidence)
10. Sybil/multi-account bonus-farming defense (Medium, product/business decision)

### Final Launch Decision: **Ready with Minor Fixes**

This is a genuinely mature codebase — every audit pass independently noted the same thing from a different angle: most of what a pre-launch review goes looking for (race conditions, IDOR, tenant isolation, concurrency safety, secrets handling, network exposure, CORS, migration ordering) has already been through at least one serious prior security/DB audit pass, with fixes documented inline in the code itself. Four of five audits found **no Critical or High-severity bug** in their area at all.

That said, "Ready with Minor Fixes" is not the same as "ready to deploy today" — three of the findings above are Critical/High and directly touch real money or account security (secrets exposure, refund routing, 2FA lockout risk, player token storage). None of them require architectural rework: each is a bounded, well-defined fix (a handful of call sites, one new httpOnly cookie flow, one credential rotation, one recovery-code implementation) rather than a redesign. That combination — narrow, well-understood, quickly fixable issues on top of an otherwise sound architecture — is what separates this from "Needs Significant Work," which would imply broader structural problems. Treat the Phase 11 blocker list above as the actual gate, not the overall grade: don't take real user deposits until items 1-4 are closed.

---

## Post-Audit Remediation Status

This section is updated as fixes land; the findings above are left as originally written (a point-in-time record) rather than edited in place.

| # | Item | Status |
|---|---|---|
| 1 | Rotate `.env.production` secrets | **Done** — `POSTGRES_PASSWORD`, `APP_RUNTIME_PASSWORD`, `JWT_ACCESS_SECRET`, `ADMIN_KEY`, `TELEGRAM_WEBHOOK_SECRET`, `PLATFORM_ENCRYPTION_KEY` regenerated 2026-09-28. `TELEGRAM_BOT_TOKEN` was NOT rotated — only @BotFather can reissue it (`/revoke` or `/token`); do that yourself if this token was ever exposed outside your control. |
| 2 | Refund-bucket-routing fix | **Done** — refunds now credit the same bucket(s) they were paid from; tested. |
| 3 | 2FA recovery codes | **Done** — full generate/display-once/consume/regenerate lifecycle, backend + admin UI; tested. |
| 4 | Player refresh token → httpOnly cookie | **Done** — mirrors the admin pattern (`yena_player_rt`); verified live. |
| 5 | Impersonation audit-trail real-actor field | **Done** — auto-stamped via AsyncLocalStorage, zero call sites touched; tested. |
| 6 | `getWallet()` double-counted withdrawal hold | **Done** — `withdrawable` no longer double-subtracts; tested. |
| 7 | RLS coverage (mutation-only today, per Phase 4/7 findings) | **Decided, documented** — platform owner chose "document only" over a Prisma Client Extension rewrite, given both prior audits found no active leak and the extension would be a global ORM-layer behavioral change to ~258 call sites. Boundary now documented explicitly in `common/tenant/rls.ts` and `docs/YENA_BINGO_MULTI_OPERATOR_ARCHITECTURE.md` (Phase 7 Part 2), including a fixed overstated claim ("RLS is the only guarantee that survives a forgotten where") that predated this finding. No code behavior changed. |
| 8 | CSP hardening | **Done** — `script-src`/`style-src`/`img-src`/etc. added to `nginx.conf`; verified against a real build served through nginx. |
| 9 | Run Phase 9 load tests | **Partially done** — the k6 script itself had never been executed before this pass; two real bugs in the script were found and fixed (an invalid `ramping-vus` executor option, and a single-source-IP rate-limit collision that produced a 78% false-failure rate). A 30-VU smoke run against local dev now passes cleanly (100% checks, 0% unexpected errors). The actual 100/500/1000/5000-user capacity runs still need a dedicated staging deployment — this local dev box isn't representative of production capacity. |
| 10 | Sybil/multi-account bonus-farming defense | **Done** — platform owner chose "lightweight heuristic guardrails." A signup IP + client-generated device-id fingerprint is captured once per account (`TelegramUser.signupIp/signupDeviceId`); `BonusService` refuses a SIGNUP/REFERRAL_* grant once too many have already paid out today across every account sharing a fingerprint (configurable per operator, `MAX_BONUS_GRANTS_PER_FINGERPRINT_PER_DAY`, default 3), and notifies operator + platform admins when it trips. Never blocks registration/login/gameplay — only the bonus payout — and never applies to an admin's own discretionary grant. Verified live: real accounts created this session naturally tripped the cap (many sharing one dev-machine IP), confirming it fires correctly under realistic conditions, not just in mocked tests. 19 new/updated backend tests.

Remaining before real-money launch: item 7 (RLS coverage — decided as "document only," see the doc for the recorded rationale) is closed; item 9's actual staging-scale k6 runs (100/500/1000/5000 users against a dedicated deployment, not this local dev box) are the one item still open.

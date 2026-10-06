# የኛ bingo — Supabase Removal Migration Report (PHASE 1: AUDIT ONLY)

**Date:** 2026-09-18
**Status:** Audit only. No application code has been modified as part of this report.
**Scope of this document:** everywhere the current codebase depends on Supabase, what each dependency does, and what it would take to replace it with NestJS + Prisma + PostgreSQL, per the migration spec.

> **Read this before Phase 2.** The honest scale assessment and the open questions at the end matter more than the tables — this is not a weekend job.

---

## 1. Scale assessment (read this first)

This app is **not** "a frontend that calls a few Supabase tables." It is built as a **database-centric** application:

- **123 migrations**, of which ~20 form the current live business-logic core (the rest are historical iteration, including an entire prior crypto/BNB-payments system that was already ripped out once — see `docs/YENA_BINGO_MIGRATION_AUDIT.md`).
- **32 `eds_*` PostgreSQL functions** carry the actual business logic — atomic cartela purchase with row locks, atomic multi-winner Bingo claims, the 80/20 payout split, wallet ledger writes, admin RBAC checks, deposit/withdrawal review. This is not thin CRUD; it's stored-procedure-driven.
- **20 Supabase Edge Functions** (Deno) are thin HTTP wrappers around those SQL functions — most edge functions are 30-80 lines that validate input, call one `eds_*` RPC, and format the response.
- **26 RLS policies** currently gate direct table access (mostly irrelevant to a NestJS rewrite, since a NestJS API would hold its own authorization logic instead of relying on Postgres RLS — but it means the *only* thing standing between "anyone with the anon key" and the data today is RLS, so removing Supabase also removes RLS and shifts 100% of that authorization burden onto the new API layer).
- **1 pg_cron job** (`call-bingo-numbers`, every 4 seconds) drives the live number-calling — this has no NestJS equivalent out of the box; it needs a scheduler (e.g. a `setInterval`/BullMQ repeatable job or a `node-cron` process) inside the new backend.
- **Supabase Realtime** (`postgres_changes` channels) is how the lobby, game room, and admin dashboard get live updates today. Replacing this means either polling-only (simplest, already partially used as a fallback — see below) or standing up WebSockets/SSE in NestJS.
- **Supabase Storage** (private `receipts` bucket) holds deposit/withdrawal proof images, uploaded **server-side only** (edge functions accept base64, validate, then upload — the browser never talks to Storage directly). This is the easiest piece to replace since nothing client-facing needs to change shape.

**Bottom line:** the actual rewrite is closer to "reimplement 32 stored procedures as NestJS service methods with Prisma transactions, plus rebuild the realtime and scheduling layers" than "swap an SDK." The admin panel's data layer (`src/admin/adminApi.ts`) and the player API layer (`src/lib/api.ts`) are already clean REST-shaped wrappers around edge functions — **those two files barely change**. The work is almost entirely on the backend/database side.

---

## 2. Current architecture

```
Telegram User
  → Telegram Mini App (React 18 + Vite, single SPA, /admin path-routed)
  → src/lib/api.ts / src/admin/adminApi.ts  (fetch() to Edge Functions, Bearer anon key)
  → Supabase Edge Functions (Deno, 20 functions, supabase/functions/*)
  → Supabase Postgres  (32 eds_* functions, RLS, pg_cron, Realtime, Storage)
```

Also two **direct-from-browser** Supabase touchpoints that bypass edge functions entirely:
- `supabase.rpc('eds_lobby', ...)` and `supabase.rpc('eds_get_or_create_cartela_layout', ...)` — called directly from the frontend using the anon key (no edge function involved).
- `supabase.channel(...).on('postgres_changes', ...)` — Realtime subscriptions, also direct from the browser.

This matters: **these are the two things a REST-only NestJS backend can't do the same way.** A direct RPC call becomes a normal `GET`/`POST`; a Realtime subscription needs a genuinely different mechanism (WebSocket/SSE/polling).

---

## 3. Frontend files with Supabase usage

| File | Current Supabase usage | Purpose | Replacement | Migration risk |
|---|---|---|---|---|
| `src/lib/supabase.ts` | `createClient()`, exports `supabase` client + `FUNCTIONS_BASE`, all shared TS types (`Game`, `Player`, `Wallet`, `YenaBingoConfig`) | Central client + type definitions | Replace with `src/lib/api-client.ts` (Axios instance, base URL from `VITE_API_BASE_URL`), keep the TS interfaces (they're backend-agnostic) | **Low** — types survive untouched, only the client construction changes |
| `src/lib/api.ts` | `callFn()` wraps `fetch()` to edge functions (already REST-shaped); `supabase.rpc('eds_lobby', ...)` and `supabase.rpc('eds_get_or_create_cartela_layout', ...)` called directly | Player-facing API surface: lobby snapshot, cartela select/release/claim, deposits, withdrawals | `callFn` → Axios call, near-identical. The two direct `.rpc()` calls need real REST endpoints (`GET /api/games/lobby`, `GET /api/games/cartela-layout`) since there's no more RPC passthrough | **Low-Medium** — mechanical for `callFn`, needs 2 new endpoints for the RPCs |
| `src/admin/adminApi.ts` | `call()` wraps `fetch()` to edge functions — 100% already REST-shaped, zero direct client/RPC/Realtime usage | Admin dashboard, deposits/withdrawals review, ledger, audit log | Swap base URL + auth header scheme (Bearer JWT instead of `X-Admin-Token`), otherwise unchanged | **Low** — cleanest file in the whole app |
| `src/lib/useLobby.ts` | `supabase.channel('eds-lobby').on('postgres_changes', {table: 'games'\|'players'}, ...)` + a 4s `setInterval` poll as backup | Live lobby updates (game state, taken cartelas) | Keep the polling (`pollMs=4000`) as the primary mechanism — it already runs even with Realtime connected, so removing Realtime and keeping only the poll is a **safe, low-risk simplification**, not a regression, if 4s latency is acceptable. If sub-second updates are required, add SSE/WebSocket | **Low if polling-only is accepted; Medium if true realtime is required** |
| `src/App.tsx` | `supabase.channel('eds-active-game')` + one-off `supabase.from(...)` queries on mount | Detect if a game is already active/joined on load | Same pattern as above — replace with a `GET /api/games/active` call + optional poll | **Low** |
| `src/screens/BingoScreen.tsx` | `supabase.rpc('ensure_waiting_game_exists')` | Lazily creates the next `waiting` game if none exists | New endpoint `POST /api/games/ensure-waiting` calling the equivalent Prisma logic | **Low** |
| `src/components/GameRoom.tsx` | `supabase.channel('eds-game-${gameId}').on('postgres_changes', {table: 'games'\|'players'})` + 3s poll fallback | Live game board: called numbers, other players' status | Same polling-is-already-the-fallback pattern as `useLobby.ts` | **Low-Medium** — this is the most latency-sensitive screen (live number calling), worth the most scrutiny if you drop Realtime |

**Key finding:** every Realtime subscription in this app already has a polling fallback running in parallel (`setInterval`, 3-4 second intervals). This was very likely a deliberate defensive pattern by whoever built it, and it means **dropping Realtime entirely and keeping only the polling is not a hypothetical fallback path — it's already-proven, already-running code.** This meaningfully de-risks the migration: you may not need a WebSocket layer in NestJS at all for v1.

---

## 4. Edge Functions inventory (→ NestJS module mapping)

| Edge Function | Purpose | Calls (SQL) | Target NestJS module |
|---|---|---|---|
| `player-session` | Verifies Telegram `initData`, issues player token | `eds_ensure_player` | `auth/` (Telegram strategy) |
| `select-card` | Purchase a cartela (room, price, 4-max global limit, balance check) | `eds_select_cartela` | `cards/` |
| `deselect-card` | Release/refund a held cartela | `eds_refund_cartela` | `cards/` |
| `claim-bingo` | Validate a Bingo claim, disqualify false claims, compute winner(s) | (atomic claim logic) | `bingo/` |
| `force-finish-game` | Admin/cron-triggered game finalization | — | `games/` |
| `submit-deposit` | Player submits a Telebirr deposit + receipt (base64 → Storage) | `eds_submit_deposit` | `deposits/` |
| `request-withdrawal` | Player requests a withdrawal | `eds_request_withdrawal` | `withdrawals/` |
| `cancel-request` | Player cancels a pending deposit/withdrawal | `eds_cancel_deposit` / `eds_cancel_withdrawal` | `deposits/` + `withdrawals/` |
| `my-finance` | Player's wallet + history | `eds_my_finance`, `eds_wallet` | `wallet/` |
| `get-receipt` | Signed URL for a receipt image | Storage signed URL | `storage/` |
| `admin-auth` | Admin bootstrap/login/logout/me | `eds_admin_login`, `eds_admin_bootstrap`, `eds_admin_from_token` | `auth/` (admin strategy) |
| `admin-finance` | Dashboard, cartelas, deposit/withdrawal review, ledger, audit — **one function, 8 actions dispatched by an `action` field** | `eds_admin_dashboard`, `eds_review_deposit`, `eds_review_withdrawal`, `eds_audit`, etc. | Split into `admin/` controller with 8 real REST routes (this is the biggest single-file → multi-endpoint expansion) |
| `update-settings` | Admin edits `settings` table (Telebirr account, room prices, game URL) | direct table write | `admin/settings` |
| `set-language` | Player language preference | `eds_set_language` | `users/` |
| `telegram-bot-webhook` | Telegram bot command handling (`/start`, `/play`, `/balance`, etc.) | various | `telegram/` |
| `setup-telegram-webhook` | One-time webhook registration with Telegram | — | `telegram/` (bootstrap script, not a runtime endpoint) |

**Note on `admin-finance`:** this single edge function is a dispatcher (`{action: 'dashboard'|'cartelas'|'list_deposits'|'review_deposit'|...}` → different SQL call). The spec's REST design (`POST /api/admin/deposits/:id/approve`, etc.) is objectively better than this — expanding it into real REST routes in `admin/` is recommended, not just a mechanical port.

---

## 5. Database schema — live vs. legacy

### Live tables (actively used by current `eds_*` functions)
```
games, players, card_layouts (per-room via eds_get_or_create_cartela_layout)
settings                         — key/value runtime config (room prices, Telebirr account, ADMIN_KEY-adjacent)
admin_users, admin_sessions      — custom admin auth (NOT Supabase Auth)
wallet_ledger                    — the financial ledger (see §6, this is the most important table)
manual_deposits, withdrawal_requests
audit_logs
telegram_users
```

### Archived / legacy (kept for history, not written to by current code)
```
deposit_transactions, bnb_withdrawal_requests   — old BSC/BNB crypto payment tables, marked ARCHIVED via
                                                    COMMENT ON TABLE in migration 20260906131200 ("crypto_teardown")
bank_sms_messages, user_sms_submissions          — old SMS-auto-credit system, triggers DROPped, tables kept
balance_transfers, referral_bonuses              — from an earlier player-to-player transfer feature (status unclear — verify before Phase 2)
game_state_snapshots, player_sessions, game_events — from an abandoned "WebSocket era" (docs call this out explicitly: a `game-server-ws` edge function was planned but never built)
```

**Migration decision needed:** does "ZERO Supabase dependency" also mean **dropping the archived crypto/SMS tables**, or does it mean **migrating their historical rows into the new Postgres database** for record-keeping? The spec says "preserve useful existing business data" (§29) but these specific tables were already explicitly marked as dead history by a prior migration. Recommend: migrate `wallet_ledger`, `manual_deposits`, `withdrawal_requests`, `audit_logs`, `games`, `players`, `admin_users` (the live ones) — and make an explicit decision on whether the archived crypto/SMS tables are worth carrying over or can be dropped, since they contain no logic the new app needs, only historical rows.

---

## 6. The financial ledger (`wallet_ledger`) — highest-risk area

This is already an immutable-style ledger (matches spec §13/§30 almost exactly): every balance change writes a row via `eds_ledger_write()`, rather than the app trusting a `balance` column directly. Entry types already match the spec's list closely: `MANUAL_TELEBIRR_DEPOSIT`, `GAME_ENTRY`, `WINNING_CREDIT`, `HOUSE_REVENUE`, `WITHDRAWAL_HOLD`, `WITHDRAWAL_PAID`, `REFUND`.

This is good news: **the ledger design doesn't need to be invented, only ported.** The risk is entirely in faithfully reproducing the concurrency guarantees:
- `eds_select_cartela` uses `SELECT ... FOR UPDATE` / `FOR UPDATE SKIP LOCKED` to prevent two players buying the same cartela.
- The Bingo claim logic has a windowed simultaneous-claim check (multiple winners within ~1 second all win, split the prize) — this is stateful, time-windowed, and easy to get subtly wrong in a rewrite.
- Deposit/withdrawal approval must be idempotent (admin double-clicking Approve must not double-credit) — currently enforced by the SQL functions checking status transitions atomically.

**Every one of these needs an equivalent Prisma `$transaction` with explicit row locking (`SELECT ... FOR UPDATE` via `$queryRaw`, since Prisma's high-level API doesn't expose row locks) or a Postgres advisory lock.** This is the part of the migration where subtle bugs would cost real money — it deserves dedicated test coverage before go-live, not just a port-and-hope.

---

## 7. What's genuinely NOT Supabase-specific (low risk, ports easily)

- 75-ball Bingo card generation/validation logic
- The 80/20 payout math
- Telegram `initData` verification algorithm (HMAC-SHA256 per Telegram's spec — already correctly implemented, just needs to move from Deno to Node)
- All 4-language i18n content (`src/i18n/*`) — completely frontend-only, zero backend coupling
- Frontend UI components — none of them know they're talking to Supabase; they only know `api.ts` / `adminApi.ts`

---

## 8. Environment variables — current vs. target

| Current (Supabase) | Target (spec §50) |
|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | `VITE_API_BASE_URL` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (edge fn env, implicit) | `DATABASE_URL` |
| `ADMIN_KEY` | `ADMIN_KEY` (unchanged) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `YENA_BINGO_APP_URL` | unchanged |
| — (no JWT today; admin uses opaque tokens in `admin_sessions`, players use a custom signed token) | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (new) |
| `ALLOW_UNVERIFIED_TELEGRAM` (dev only) | unchanged, still needed for local dev |

---

## 9. Migration risk summary

| Area | Risk | Why |
|---|---|---|
| Admin panel data layer | **Low** | Already REST-shaped, zero Realtime/RPC coupling |
| Player API layer | **Low-Medium** | Mostly REST-shaped; 2 direct RPC calls need new endpoints |
| Realtime → polling-only | **Low** | Polling fallback already exists and already runs in parallel today |
| Financial ledger & concurrency | **High** | Money-correctness bugs are the worst-case outcome; needs explicit row-locking strategy + dedicated tests, not a mechanical port |
| Bingo claim window (simultaneous winners) | **Medium-High** | Time-windowed, stateful, easy to subtly change behavior during rewrite |
| pg_cron number-calling job | **Medium** | No direct NestJS equivalent; needs a scheduler process design decision |
| File storage (receipts) | **Low** | Already server-side-only upload; swap Supabase Storage SDK for local disk / S3-compatible client |
| RLS removal | **Medium** | RLS is currently the *only* enforcement on direct table access; since NestJS won't have RLS, 100% of that authorization logic must be correctly reimplemented in guards/services — a gap here is a real vulnerability, not just a code-quality issue |
| Legacy/archived tables (crypto, SMS) | **Low risk, but needs a decision** | Dead code, but "keep history or drop" is a business decision, not a technical one |

---

## 10. Open questions before Phase 2 (please confirm)

1. **Pacing.** This is realistically **1-3 weeks of focused engineering work** for one person to do properly (32 stored procedures to reimplement with correct concurrency, a new auth system, a new realtime/scheduling story, full test coverage, Docker/deploy). Do you want this executed **phase-by-phase with checkpoints** (recommended — matches how the *previous* migration on this same codebase was run, per `docs/YENA_BINGO_MIGRATION_AUDIT.md`), or driven end-to-end with less check-in?
2. **Realtime.** Given every current Realtime subscription already has a working polling fallback — is 3-4 second update latency acceptable for launch, deferring a real WebSocket layer? This changes the Phase 3 backend scope significantly (removes an entire subsystem).
3. **Legacy data.** Keep the archived crypto/SMS tables' historical rows in the new database for record-keeping, or is it acceptable to leave them behind (only migrate the live tables in §5)?
4. **Deployment target.** The spec asks for Docker Compose (Postgres + Redis + backend + frontend). Is this self-hosted on a VPS, or a specific cloud target? This affects the Storage decision (local disk vs. S3-compatible) and the Postgres backup strategy (§54).
5. **This workspace has no live production data** — everything running is the local dev database we stood up together this session. Confirm there's no separate production Supabase project with real user/financial data that this migration needs to account for.

---

*Next step per your instruction: do not modify files until this report is reviewed. Phase 2 (Prisma schema design) is ready to start once the above is confirmed.*

# የኛ bingo — Migration Audit (Phase 1 + 2)

**Date:** 2026-09-06
**Source project:** `Fanosbingo-main/Fanosbingo-main` (GitHub — "Fanos Bingo")
**Target:** የኛ bingo — Telegram Mini App + Bot + Admin Panel, manual Telebirr deposits/withdrawals, 600-cartela two-room model, 4-cartela player limit, 80/20 prize split.

> **STATUS: AUDIT ONLY. No application code has been modified.**
> This document is the deliverable for implementation-plan Phases 1 and 2. Read the "Blockers / decisions needed" section at the end before starting Phase 3.

---

## 1. Current architecture

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite 5 + TailwindCSS 3 | Single-page app. No router — `view` state machine (`lobby` \| `game` \| `admin`) in `src/App.tsx`; `/admin` detected from `window.location.pathname`. |
| Telegram Mini App | `@twa-dev/sdk` | `src/utils/telegram.ts` → `initTelegram()` reads `Telegram.WebApp.initDataUnsafe.user`. The Mini App **is** the player frontend. |
| Wallet / crypto | `wagmi` 3, `viem` 2, `@reown/appkit` + `@reown/appkit-adapter-wagmi` | Whole app wrapped in `<WagmiProvider>` + `<QueryClientProvider>` in `App.tsx`. BSC (Binance Smart Chain) only. |
| Backend | Supabase Edge Functions (Deno) | 25 functions in `supabase/functions/*`. No separate Node/Express server. |
| Realtime | Supabase Realtime (`postgres_changes` channels) + polling fallbacks | **No dedicated WebSocket server is deployed.** `instruction/read.md` describes a `game-server-ws` edge function, but **it does not exist in the repo.** Realtime = Postgres change feeds + `setInterval` polling (3–10 s) in every component. |
| Scheduled jobs | `pg_cron` | `bingo-auto-caller` invoked ~every 3–4 s to draw numbers (migrations `20251110041730`, `20251213082204`). |
| Database | Supabase PostgreSQL + RLS | ~118 migrations, heavily iterative (many "fix_" patches). |
| Storage | **None used.** `public/` contains only `sw.js`. No Supabase Storage bucket configured. | Relevant: deposit receipts have nowhere to be stored yet. |
| Auth (players) | Telegram initData (unverified in code) OR wallet-address registration (`get_or_create_wallet_user` RPC). | No JWT/session table for players. RLS on game tables is effectively public. |
| Auth (admin) | Single shared **access key** → POSTed to `update-settings` edge fn which compares to `ADMIN_KEY` env var. | README claims TOTP/2FA — **not implemented**. No roles, no RBAC, no admin users table. |
| Tests | **None.** No vitest/jest/playwright. Only `stress-test/` k6 load scripts. | `npm run` has `dev/build/lint/typecheck` + `stress:*`. |
| Config | `.env` (Vite `VITE_*`) + `settings` DB table (key/value) for runtime config. | `.env` currently holds **placeholder** Supabase creds — the app cannot connect to a real backend in this workspace. |
| Deployment | Not in repo (no Dockerfile, no CI). Vite build → static host; Supabase hosted; Telegram webhook set via `setup-telegram-webhook` fn. | `vite.config.ts` has compression + visualizer plugins. |

### Entry points / routing
- `src/main.tsx` → `<App/>`
- `src/App.tsx` `AppContent`: renders `Lobby`, `GameRoom`, or lazy `Admin` based on `view` + `gameId`/`gameStarted`.
- Session persisted in `localStorage` (`gameId`, `playerId`, `darkMode`).

### Frontend files
```
src/App.tsx                       view router, telegram+wallet registration, join-game handler
src/main.tsx                      bootstrap
src/lib/supabase.ts               supabase client + Game/Player TS types
src/lib/walletConfig.ts           CRYPTO — createAppKit(BSC), DEPOSIT_CONTRACT_ABI
src/components/Lobby.tsx          (1007) card grid 1–400, single selection, countdown, wallet gate
src/components/GameRoom.tsx       (779) live board, BingoCard, BINGO claim, winner modal
src/components/BingoCard.tsx      5x5 card render
src/components/Admin.tsx          (1045) access-key login, dashboard/users/deposits/withdrawals/settings
src/components/AccountantDashboard.tsx   EMPTY FILE (0 bytes)
src/components/WalletConnect.tsx          CRYPTO
src/components/WalletDepositModal.tsx (384) CRYPTO — BNB deposit via contract + tx hash
src/components/BnbWithdrawalModal.tsx (803) CRYPTO — BNB withdrawal, signature flow
src/components/BnbWithdrawalManagement.tsx (628) CRYPTO admin
src/components/DepositManagement.tsx (173) admin — BNB deposit_transactions review
src/components/BankDepositModal.tsx (236) BANK — Ethiopian bank/Telebirr SMS deposit (partial manual model)
src/components/BankWithdrawalModal.tsx (402) BANK — bank withdrawal request
src/components/NetworkQualityIndicator.tsx, Toast*.tsx
src/hooks/*                        realtime/connection/offline/network hooks
src/utils/bingoUtils.ts           75-ball card gen + checkWin + getWinningPattern (client copy)
src/utils/telegram.ts             Telegram Mini App SDK wrapper
src/utils/formatBalance.ts        formatBnb() — note: labelled "Bnb"
src/utils/cardLayoutCache.ts, networkOptimization.ts, cardLayoutCache
```

---

## 2. Existing Bingo architecture (PRESERVE)

Solid and worth keeping almost entirely:

- **75-ball, standard columns** B 1–15 / I 16–30 / N 31–45 / G 46–60 / O 61–75, centre = FREE. Correct in `bingoUtils.ts`, `card_layouts` generator, `GameRoom.tsx`, `claim-bingo`.
- **Winning patterns:** any row, any column, either diagonal, four corners. (`getWinningPattern`, DB `check_player_win`.)
- **Card layouts:** `card_layouts` table pre-generates a permanent deterministic 5×5 layout per **card number 1–400** (`get_or_create_card_layout`, `generate_seeded_bingo_card`, seeded LCG). Migration `20251227080930_pregenerate_all_card_layouts` seeds all 400.
- **Card selection:** `select_card_atomic()` RPC — `SELECT ... FOR UPDATE` on game row + `FOR UPDATE SKIP LOCKED` on card, atomic insert into `players`, structured error codes (`GAME_NOT_WAITING`, `SELECTION_CLOSED`, `CARD_TAKEN`, `INSUFFICIENT_BALANCE`, `USER_NOT_FOUND`). Called via `select-card` edge fn. **Concurrency-safe.**
- **Selection cutoff:** `games.selection_closed_at` auto-set 5 s before `starts_at` (trigger), 2 s grace, `allow_late_joins` flag.
- **Number drawing:** `bingo-auto-caller` edge fn on `pg_cron`, never repeats within a round, hard stop at 75 (`20251214082433_fix_75_call_limit`).
- **Claim / winner validation:** `atomic_claim_bingo()` RPC — 1 s simultaneous-claim window (`games.claim_window_start`), server-side pattern check against `called_numbers`, **false BINGO → `players.is_disqualified = true`**, supports **multiple winners** with equal split (`winner_ids`, `winner_prize_each`). `claim-bingo` edge fn finalises game after the window.
- **Auto win detection:** trigger checks all non-disqualified players after each draw (`20251213162934_add_automatic_win_detection`).
- **Single active game:** DB constraint — only one game `waiting`/`playing` at a time (`20251214092236_enforce_single_active_game`); new `waiting` game auto-created on finish.
- **Spectator mode:** late arrivals + disqualified players watch; everyone returns to lobby together (`games.return_to_lobby_at`).
- **Server time sync:** `get_server_timestamp_ms()` RPC; NTP-style offset in `Lobby`/`GameRoom`.

### Bingo tables
- `games` — `id, code, game_number, status(waiting|playing|finished), current_number, called_numbers int[], winner_id/winner_ids[], winner_prize, winner_prize_each, stake_amount, total_pot, pot_amount, house_pot_amount, paid_out, starts_at, selection_closed_at, started_at, finished_at, return_to_lobby_at, claim_window_start, allow_late_joins`
- `players` — `id, game_id, telegram_user_id, name, card jsonb, card_numbers jsonb, marked_cells jsonb, selected_number int (ONE per player), stake_paid, has_won, is_disqualified, winning_pattern jsonb, joined_at, telegram_username/first/last`
- `card_layouts` — `card_number(1–400) PK, layout jsonb`
- `game_state_snapshots`, `player_sessions`, `game_events` — WebSocket-era infra (`20251219090840`); `game_events` is the closest thing to an audit log but game-scoped only.

---

## 3. Existing payment architecture

Two parallel money paths exist today:

### A. Crypto / BNB (PRIMARY, user-facing) — to be REMOVED from UX
- Deposit: user connects wallet → sends BNB to `FanosBingoDeposit` contract → submits tx hash → `submit-deposit` edge fn queries BSC RPC (`eth_getTransactionReceipt`), parses the `Deposit` event log, waits for N confirmations → inserts `deposit_transactions` → trigger `process_confirmed_deposit()` credits `telegram_users.deposited_balance`.
- Withdrawal: `bnb_withdrawal_requests` + `bnb_withdrawal_limits_tracking` (daily 5 / weekly 10 BNB). `process_bnb_withdrawal_request()` deducts `won_balance` and creates a signed request; admin/edge relays on-chain via shared contract (`manage-bnb-withdrawal`, `record-withdrawal`, `credit-win-to-contract`, `claim-winnings-to-contract`, `get-withdrawal-wallet-info`).
- `settings` rows: `deposit_contract_address`, `deposit_bsc_rpc_url`, `deposit_conversion_rate` (1 BNB = 100000 credits), `deposit_required_confirmations`, `deposit_contract_chain_id`, `withdrawal_contract_address`, `withdrawal_contract_private_key`, `withdrawal_credits_to_bnb_rate`, `withdrawal_min_bnb`, `withdrawal_max_daily_bnb`, `withdrawal_max_weekly_bnb`, `withdrawal_low_balance_threshold`.
- `20260214120304_remove_balance_checks_for_testnet` — `deduct_stake_from_balance` currently **skips deduction when total balance < stake** (testnet hack). Must be reverted for real ETB play.

### B. Ethiopian bank / Telebirr SMS (SECONDARY, partial) — REUSE as base for manual Telebirr
- `bank_options` table — **already seeded with a `Telebirr` row** (`0972779234`, "Mamaru", Amharic instructions). Also BOA / CBE placeholders (inactive).
- `withdrawal_bank_options` — bank list for withdrawals.
- `bank_sms_messages` — inbound bank SMS (via `receive-bank-sms` edge fn / forwarder).
- `user_sms_submissions` — user pastes SMS text; trigger `match_user_sms()` auto-matches to a `bank_sms_messages` row by amount+time; `auto_credit_matched_deposit()` **auto-credits** `deposited_balance`. Admin fallback: `manual-sms-entry`, `manual-sms-verification`.
- `withdrawal_requests` — **this is close to the target withdrawal model**: `id, telegram_user_id, amount numeric(10,2), status(pending|processing|completed|rejected), requested_at, processed_at, processed_by_admin, rejection_reason, bank_name, account_number, account_name, admin_notes`. `get_available_balance()` = `won_balance − pending`. Processed by `process-withdrawal` edge fn (`ADMIN_KEY` gated), which on `complete` deducts `won_balance` + notifies via Telegram.

### Money model (`telegram_users`)
- `balance` int — legacy total, kept in sync (deprecated).
- `deposited_balance` int — from deposits, **not withdrawable**, used for stakes first.
- `won_balance` int — from winnings, **only this is withdrawable**.
- `total_spent, total_won, total_deposited, total_withdrawn, win_count` counters.
- **All money is stored as `integer` whole ETB** (except `withdrawal_requests.amount` and `deposit_transactions.*` which are `numeric`). Prize math in DB uses `FLOOR(pot * 0.80)`. No floating point in the money-critical DB paths, but the *frontend* `GameRoom.tsx` does `Math.floor(game.total_pot * 0.80)` as a display fallback.

### Prize split
- `settings.commission_rate` default **20** (`20251227071701`). Winner = 80%, house = 20%. DB computes `winner_prize` / `winner_prize_each`; house share tracked via `house_pot_amount` / `total_pot − winner_prize`. Frontend labels already say "80%" / "Derash (80%)".

---

## 4. Crypto files (inventory)

**Remove entirely (Phase 18):**
```
src/lib/walletConfig.ts
src/components/WalletConnect.tsx
src/components/WalletDepositModal.tsx
src/components/BnbWithdrawalModal.tsx
src/components/BnbWithdrawalManagement.tsx
src/components/DepositManagement.tsx           (BNB deposit_transactions admin view)
get-wallet-address.js
get-wallet-address.mjs
contracts/FanosBingoDeposit.sol
contracts/README.md
supabase/functions/submit-deposit/            (BSC RPC tx verification)
supabase/functions/monitor-deposits/
supabase/functions/credit-win-to-contract/
supabase/functions/claim-winnings-to-contract/
supabase/functions/record-withdrawal/
supabase/functions/manage-bnb-withdrawal/
supabase/functions/get-withdrawal-wallet-info/
```

**Heavily edit (strip crypto, keep shell):**
```
src/App.tsx                 remove WagmiProvider/QueryClientProvider-for-wallet, wallet registration effect
src/components/Lobby.tsx     remove useAccount / "Connect BNB Wallet" gate / BNB deposit+withdraw buttons
src/components/Admin.tsx     replace BNB deposit/withdrawal pages with Telebirr ones
src/utils/formatBalance.ts   rename formatBnb → formatEtb (or keep name, relabel)
```

---

## 5. Crypto dependencies (`package.json`)

Remove after Phase 18: `@reown/appkit`, `@reown/appkit-adapter-wagmi`, `wagmi`, `viem`.
Keep: `@supabase/supabase-js`, `@tanstack/react-query` (still useful for data fetching — decide), `@twa-dev/sdk`, `react`, `react-dom`, `lucide-react`.
Dev: no crypto-specific dev deps. `k6` is a stray dep (`^0.0.0`) — harmless, leave.

---

## 6. Crypto database tables / fields

| Object | Disposition |
|---|---|
| `deposit_transactions` (table) | Archive/rename → not used by new flow. Keep rows for history (Phase 19 strategy). |
| `bnb_withdrawal_requests` (table) | Archive. |
| `bnb_withdrawal_limits_tracking` (table) | Drop (BNB-specific limits). |
| `telegram_users.wallet_address` | Keep column (used for wallet-login fallback) OR drop with login path. Decide. |
| `telegram_users.total_withdrawn` | **Keep** — generic. |
| `settings` rows `deposit_*`, `withdrawal_*bnb*`, `withdrawal_contract_*` | Delete rows (Phase 19). Replace with `TELEBIRR_*`. |
| Functions: `check_bnb_withdrawal_limits`, `process_bnb_withdrawal_request`, `refund_bnb_withdrawal`, `complete_bnb_withdrawal`, `get_bnb_withdrawal_stats`, `process_confirmed_deposit` | Drop in Phase 19 migration. |
| `deduct_stake_from_balance` testnet variant (`20260214120304`, `20260216113940`) | **Revert** — must enforce real balance. |

---

## 7. Crypto API endpoints (edge functions)

Delete: `submit-deposit`, `monitor-deposits`, `credit-win-to-contract`, `claim-winnings-to-contract`, `record-withdrawal`, `manage-bnb-withdrawal`, `get-withdrawal-wallet-info`.
Keep + adapt: `process-withdrawal` (already ETB + Telegram notify — extend to hold/mark-paid model), `submit-deposit` name may be reused for the Telebirr deposit submission (new implementation).
Keep untouched: `select-card`, `deselect-card`, `claim-bingo`, `bingo-auto-caller`, `mark-cell`, `mark-cells-batch`, `force-finish-game`, `get-card-layouts`, `telegram-bot-webhook`, `telegram-notify`, `setup-telegram-webhook`, `update-settings`, `transfer-balance`, `manage-bank-options`.
Review: `receive-bank-sms`, `manual-sms-entry`, `manual-sms-verification` — SMS auto-match flow; the spec wants **manual admin approval with receipt upload**, so these are superseded (keep for now, disable auto-credit).

---

## 8. Crypto frontend components

See §4. User-facing crypto surfaces to eliminate:
- `Lobby.tsx`: `useAccount()`, `WalletConnect`, "Connect Your BNB Wallet to Play" banner, "Crypto (BNB) Deposits & Withdrawals" card, `Deposit BNB` / `Withdraw BNB` buttons, `formatBnb` labels.
- `App.tsx`: `WagmiProvider`, wallet auto-registration, `WalletDepositModal` mounts.
- `Admin.tsx`: "BNB Deposit Management", "BNB Withdrawal Management" pages, `BNB` columns in Users table, "House Cut … BNB" stat suffixes.
- `index.html`: title "Fanos Bingo - Multiplayer Game", favicon `/vite.svg` (missing file).

---

## 9. Crypto environment variables

`.env`: `VITE_REOWN_PROJECT_ID` (remove), `VITE_APP_URL` (keep). `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (keep).
Edge-fn env (Supabase dashboard, not in repo): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_KEY`, `TELEGRAM_BOT_TOKEN`, plus crypto ones in `settings` table (see §6).

---

## 10. Crypto tests

None. `stress-test/k6-*.js` exercise `select-card` / lobby only — no crypto. No test changes required for removal; new tests are net-new (Phase 21).

---

## 11. Files to REMOVE

See §4 (crypto files) and §7 (crypto edge functions). Plus:
- `contracts/` directory (whole)
- `get-wallet-address.{js,mjs}`
- Root docs that describe the old product (rewrite, not delete): `README.md`, `REALTIME_ARCHITECTURE.md`, etc. — keep as history or move to `docs/legacy/`.
- `src/components/AccountantDashboard.tsx` — 0 bytes, dead. Remove or implement.

## 12. Files to PRESERVE (do not rewrite)

```
src/utils/bingoUtils.ts, src/components/BingoCard.tsx
src/components/GameRoom.tsx  (edit only: labels, prize display, multi-cartela rendering)
src/hooks/*
supabase/functions/select-card, deselect-card, claim-bingo, bingo-auto-caller,
  mark-cell, mark-cells-batch, force-finish-game, get-card-layouts,
  telegram-notify, setup-telegram-webhook, update-settings
supabase/migrations/*  (all existing — never edit; only ADD new migrations)
card_layouts system, select_card_atomic, atomic_claim_bingo, check_player_win,
  get_or_create_card_layout, get_server_timestamp_ms, single-active-game constraint
```

## 13. Files to MODIFY

| File | Change |
|---|---|
| `index.html` | Title → "የኛ bingo", favicon, meta, preconnect URL. |
| `src/App.tsx` | Remove Wagmi; add room-aware join flow; keep Telegram init. |
| `src/lib/supabase.ts` | Extend `Game`/`Player` types (room, cartelas array). |
| `src/components/Lobby.tsx` | Two rooms (ETB 5 / ETB 10), multi-select up to 4 total, "X / 4" counter, remove wallet gate. |
| `src/components/GameRoom.tsx` | Render multiple cartelas for the player; relabel BNB→ETB; prize display from backend only. |
| `src/components/Admin.tsx` | New nav: Dashboard, Players, Wallets, Deposits, Withdrawals, Games, Cartelas, Winners, Transactions, House Revenue, Audit, Settings. Telebirr deposit/withdrawal review. |
| `src/utils/formatBalance.ts` | ETB formatting. |
| `supabase/functions/select-card` | Enforce room + price + `MAX_CARTELAS_PER_PLAYER = 4` global; allow multiple rows per player per game. |
| `supabase/functions/telegram-bot-webhook` | Rebrand strings, remove hard-coded bolt.host URL + "Multiplayer Bingo", add deposit/withdraw/cartela commands, enforce 4-cartela limit. |
| `supabase/functions/process-withdrawal` | Hold → approve → mark-paid model, Telebirr reference required on mark-paid, payment proof. |

## 14. Database migration strategy

- **Never edit existing migrations.** Add new timestamped migrations only.
- New migrations needed:
  1. `rooms` config + `games.room_type` (`etb5` \| `etb10`) + `games.entry_price`, or a `rooms` table. Two permanent rooms; cartela numbers restart per room (ETB5 #1–400, ETB10 #1–200).
  2. `players` → allow **multiple rows per (game, telegram_user_id)**; drop/replace any unique constraint on `(game_id, telegram_user_id)` if present (verify). Add `players.room_type`, keep `selected_number` as the cartela number **within its room**.
  3. `select_card_atomic` v2 — count player's existing cartelas **across both rooms for the active game/session**, reject if `current + requested > 4`, validate room/price/balance, still `FOR UPDATE`.
  4. Revert testnet balance bypass — real `deduct_stake_from_balance`.
  5. `deposits` table (manual Telebirr) — see §21 of the spec (fields: `telebirr_transaction_reference`, `receipt_file_id`, `receipt_file_type`, `status pending|approved|rejected|cancelled`, `reviewed_by`, `reviewed_at`, `rejection_reason`, `admin_note`). Or extend `user_sms_submissions` → not recommended; cleaner to add `manual_deposits`.
  6. `withdrawals` — extend `withdrawal_requests`: add `APPROVED` + `PAID` statuses, `telebirr_account`, `paid_at`, `telebirr_transaction_reference`, `payment_proof_file_id`, `payment_method = MANUAL_TELEBIRR`. Add **withdrawal hold** ledger semantics.
  7. `wallet_ledger` (transaction ledger) — types: `MANUAL_TELEBIRR_DEPOSIT, GAME_ENTRY, WINNING_CREDIT, WITHDRAWAL_HOLD, WITHDRAWAL_PAID, WITHDRAWAL_RELEASE, REFUND, HOUSE_REVENUE`. Every balance change writes a row. (Today there is no unified ledger — only counters + `balance_transfers`/`referral_bonuses`.)
  8. `audit_logs` — `admin_user_id, action, entity_type, entity_id, previous_state jsonb, new_state jsonb, reason, created_at`.
  9. `admin_users` + roles (RBAC) — replace single `ADMIN_KEY`.
  10. Money type review: consider `numeric(14,2)` for new money columns; keep existing `integer` columns as-is (whole-ETB) to avoid a risky mass migration — **document the decision**.
  11. Archive strategy for `deposit_transactions` / `bnb_withdrawal_requests`: keep tables, add `archived_at`, stop writing, exclude from UI. Do **not** drop historical rows.
  12. `games` 80/20 breakdown columns already exist (`total_pot`, `winner_prize`, `house_pot_amount`) — add explicit `winner_prize_amount` / `house_share_amount` if clearer; compute from **actual participating cartelas** (sum of `players.entry_price` for the game).

## 15. Risks

1. **Git repo root is `C:/Users/zekio`** (the user's home directory). The project has **no own `.git`**. `git status` shows unrelated deleted files from another project. Creating the `yena_bingo-manual-telebirr` branch / "logical commits" as the spec asks would commit into the home-dir repo. **Must resolve before Phase 3** (see Blockers).
2. **No live backend.** `.env` has placeholder Supabase creds; migrations can't be applied and E2E can't run here without real project credentials + `supabase` CLI link. Automated Phase 21/22 testing will be limited to unit-level (pure functions) + SQL logic review unless credentials are provided.
3. **`players` may have a unique constraint on `(game_id, telegram_user_id)`** (single-card-per-player assumption is baked into `Lobby.tsx` and possibly the schema). Multi-cartela requires schema + heavy `Lobby`/`GameRoom`/`select_card_atomic` changes — highest-risk change.
4. **Cartela numbering collision.** Today cards are global 1–400. New model: ETB5 #1–400 AND ETB10 #1–200 (numbers restart). `card_layouts` PK is `card_number` with `CHECK 1..400`. Need room-scoped layouts (`(room_type, card_number)`) or a mapping — touches the pre-generation system.
5. **No unified ledger / audit log today.** Financial correctness (no double-credit, atomic approve) must be built, not adapted.
6. **Admin auth is a single shared key** with no rate limiting; every admin edge fn re-checks `ADMIN_KEY`. RBAC is a real build.
7. **Realtime is Postgres-change-feed + polling**, not a true socket server. Fine to keep, but "WebSocket" events in the spec map to Realtime broadcasts; multi-cartela live updates need the player's *set* of cartelas subscribed.
8. **`instruction/read.md` references components that don't exist** (`LobbyWS`, `GameRoomWS`, `game-server-ws`, `websocketManager.ts`). Do not chase them.
9. **Logo not supplied in the workspace** (see Blockers).
10. **Amharic content** already present in `bank_options` seed — keep locale-aware.
11. Frontend still contains a client-side `checkWin` (`bingoUtils.ts`) — backend is authoritative (`atomic_claim_bingo`), but ensure no client path can self-declare a prize.

## 16. Recommended implementation sequence

Follows the spec's 23 phases, with these adjustments up front:

- **P3 (git):** resolve repo situation first — `git init` a dedicated repo in `Fanosbingo-main/Fanosbingo-main` (recommended) or get direction. Then branch `yena_bingo-manual-telebirr`.
- **P4 Rebrand** — low risk, do early: `index.html`, `walletConfig` metadata (until removed), bot strings, `README.md`, docs. ~14 "Fanos" hits + generic "Multiplayer Bingo" strings + bolt.host URL.
- **P5 Logo** — place at `public/logo.png` (+ `public/favicon.png`, `public/icon-192.png`, `public/icon-512.png`, optional `public/manifest.webmanifest`); reference from `index.html` and a shared `<Logo/>`. Document exact paths (see Blockers).
- **P6 600-cartela / two-room model** — new migration: `rooms`, `games.room_type` + `entry_price`, room-scoped `card_layouts`. Config in `settings` (`ETB5_ROOM_PRICE=5`, `ETB5_ROOM_CAPACITY=400`, `ETB10_ROOM_PRICE=10`, `ETB10_ROOM_CAPACITY=200`, `MAX_STANDARD_CARTELAS=600`, `MAX_CARTELAS_PER_PLAYER=4`, `WINNER_PERCENTAGE=80`, `HOUSE_PERCENTAGE=20`).
- **P7 4-cartela TOTAL limit** — `select_card_atomic` v2 (authoritative, atomic, cross-room count), + `Lobby` client guard, + bot guard.
- **P8 Simultaneous ETB5+ETB10** — `players` multi-row per game; `Lobby`/`GameRoom` render both rooms; join flow creates participation rows for every selected cartela; winner validation per specific cartela.
- **P9–P12 Manual Telebirr deposits/withdrawals + admin verification** — `manual_deposits` table, Supabase Storage bucket `receipts` (private, signed URLs, MIME+signature+size validation), `wallet_ledger`, `audit_logs`, atomic approve (single credit), withdrawal hold/approve/mark-paid.
- **P13 80/20** — compute from actual participating cartelas; store `game_pot`, `winner_prize_amount`, `house_share_amount`; frontend read-only.
- **P14–P17 Frontend + bot + admin** rework.
- **P18–P19 Remove crypto** — only after Telebirr flow works + tests pass; archive migration for `deposit_transactions` / `bnb_withdrawal_requests`.
- **P20 Security/RBAC** — `admin_users` + roles, per-action audit.
- **P21–P22 Tests** — add vitest for pure logic (prize math, limit math, file validation); SQL-level tests for `select_card_atomic` v2 / deposit approve / withdrawal hold via a local Supabase or pgTAP; E2E script for the full journey (needs live creds).
- **P23 Production readiness.**

---

## Blockers / decisions needed before Phase 3

1. **Git.** No project-level repo; the enclosing repo is your home directory. Recommend `git init` inside `Fanosbingo-main/Fanosbingo-main` and work there. Confirm.
2. **የኛ logo image.** Not present anywhere in this workspace (`public/` has only `sw.js`; no PNG/SVG/JPG anywhere in the repo). Provide the file, or I will proceed with all other work and leave a documented placeholder at:
   - `public/logo.png` (primary, used in welcome/login/lobby/loading/winner/admin)
   - `public/favicon.png` (or `.ico`)
   - `public/icon-192.png`, `public/icon-512.png` (PWA/manifest)
3. **Live Supabase project.** `.env` is placeholder. To apply migrations and run real E2E tests I need: real `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`, the Supabase project ref + access token (or `supabase` CLI already linked), and the edge-fn `ADMIN_KEY` / `TELEGRAM_BOT_TOKEN`. Without these, Phases 21–22 will be limited to unit + static/SQL review.
4. **Telebirr account details.** Will use `settings` / env placeholders (`TELEBIRR_ACCOUNT_NAME`, `TELEBIRR_ACCOUNT_NUMBER`, `TELEBIRR_INSTRUCTIONS`) — real values supplied later by the operator. (Existing `bank_options` "Telebirr" seed row: `0972779234` / "Mamaru" — confirm keep or replace.)
5. **Scope confirmation.** This is a large multi-week migration (23 phases). Confirm you want it executed end-to-end autonomously, committing per phase, or phase-by-phase with checkpoints.
6. **`@tanstack/react-query`** — keep for data fetching or remove with the rest of the wallet stack? (It's currently only wired for Wagmi.)

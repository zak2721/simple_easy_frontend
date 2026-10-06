# የኛ bingo — final audit (verification pass)

Date: 2026-09-06 · Branch: `yena_bingo-manual-telebirr`

This audit **re-verifies the actual repository** after the crypto→Telebirr
migration and a hardening pass. It supersedes nothing in
[`YENA_BINGO_MIGRATION_AUDIT.md`](YENA_BINGO_MIGRATION_AUDIT.md) (the original
codebase audit) — it records the state *now*.

Method: full-repo `grep` sweeps + reading every edge function, every
`20260906*` migration, and the Mini App / admin source.

---

## 1. Current architecture

| Layer | Now |
|---|---|
| Player frontend | React 18 + Vite + Tailwind SPA, dark mobile-first. `SessionProvider` → `player-session` edge fn (verified Telegram `initData` HMAC → signed player token). 9 screens + `GameRoom`. No router; `/admin` path → `AdminApp`. |
| Admin | `/admin` SPA view, RBAC (owner/finance/support/viewer), bcrypt + 12h sessions. |
| Backend | Supabase Postgres + **20 Deno edge functions** + Realtime change-feeds + `pg_cron` number caller. |
| Realtime | Supabase Realtime (`postgres_changes`) + polling. No standalone socket server (never existed). DB is the source of truth for all money/results. |
| Storage | Private `receipts` bucket (no public policies) — reached only via `submit-deposit` / `get-receipt` / `admin-finance` (service role + authz). |
| Money | `wallet_ledger` (append-only, unique idempotency index) is the ONLY balance mover via `eds_ledger_write`. `audit_logs` for every admin action. |
| Config | `settings` table + `eds_config()`; `.env` for `VITE_*` only. |
| Tests | 28 vitest unit tests + `supabase/tests/yena_bingo_verification.sql` (transactional, staging). |

## 2. Bingo engine (unchanged, preserved)

75-ball (B/I/N/G/O 1-15…61-75, free centre), row/col/diag/four-corners,
`card_layouts` seed generator, `atomic_claim_bingo` (1s window, false-BINGO
disqualification, multiple winners), `bingo-auto-caller` cron, single-active-game,
spectator mode, server-time sync. `select_card_atomic` still exists but is
**superseded** by `eds_select_cartela` (the only path the app calls).

## 3. Cartela model

One active game; a cartela = a `players` row with `room_type` ('etb5'/'etb10') +
`entry_price`. `cartela_layouts (room_type, cartela_number)`: **ETB 5 #1-400**,
**ETB 10 #1-200** (numbers restart per room). `players` uniqueness is now
`(game_id, room_type, selected_number)`; the old `(game_id, telegram_user_id)`
unique constraint was dropped to allow multi-cartela. Config asserted at install:
`400 + 200 = 600`, `80 + 20 = 100`, `max per player = 4`.

## 4. 4-cartela limit — VERIFIED in code

`eds_select_cartela()`:
- locks the `telegram_users` row `FOR UPDATE` for the whole call
- counts the player's cartelas **across both rooms** for the game
- rejects when `current + 1 > MAX_CARTELAS_PER_PLAYER` (`LIMIT_REACHED`)
- cartela availability via `FOR UPDATE SKIP LOCKED`
Because the user row is locked, two concurrent buys serialise → the final state
can never exceed 4. Frontend (`BingoScreen`) also guards; the bot sells no
cartelas. Unit-tested (`cartelaLimit.test.ts`, 7 cases incl. cross-room + 5th
rejected); SQL-tested (`yena_bingo_verification.sql` §4-9).

## 5. Simultaneous rooms — VERIFIED in code

`BingoScreen` renders both room boards; selection builds one pending set across
rooms; confirm creates one `players` row per cartela. `GameRoom` shows a tab per
cartela, all auto-marked from `called_numbers`, each with its own claim.
`eds_lobby` returns `my_cartelas` + per-room counts + combined total.

## 6. Payments — MANUAL TELEBIRR ONLY

Deposit: `submit-deposit` (file magic-byte + size validation → private bucket) →
`eds_submit_deposit` (`pending`) → `admin-finance` `review_deposit` →
`eds_review_deposit` (single idempotent `MANUAL_TELEBIRR_DEPOSIT` credit / reject
with reason). Withdrawal: `eds_request_withdrawal` (`WITHDRAWAL_HOLD` debits
`won_balance`) → approve → **`mark_paid` requires the Telebirr reference** →
`WITHDRAWAL_PAID` settle. Reject/cancel → `WITHDRAWAL_RELEASE`.

## 7. 80/20 + multi-winner — FIXED this pass

`payout_winners()` (BEFORE UPDATE trigger, status→finished):
`winner_pool = FLOOR(pot*80/100)` (exact, pot is always a multiple of 5);
`house_share = pot - winner_pool` = **exactly 20%**. The pool is split
`base = pool div N`, and the remainder (`pool mod N`) is given as **+1 ETB to the
first `remainder` winners** (ordered by id) so winners collectively get the whole
pool — nothing lost or created. Per-winner amounts stored in
`games.winner_payouts`. `WINNING_CREDIT` per winner keyed `<game>:<player>`
(idempotent — re-finish never double-pays); one `HOUSE_REVENUE` keyed `<game>`.
Integrity guard raises if paid > pool. Unit-tested (`prize.test.ts`, 8 cases incl.
3/4-winner remainder + exhaustive `house == 20%`); SQL-tested (§13-14, incl.
`6,5,5` remainder).

## 8. Ledger completeness — VERIFIED

Full-repo sweep for `balance = balance ±`, `deposited_balance = …`,
`won_balance = …` in **live code** (`supabase/functions/**`,
`supabase/migrations/20260906*`): **zero direct balance mutations** — every one
goes through `eds_ledger_write`.

Legacy direct-mutation paths and their disposition:

| Path | Status |
|---|---|
| `deduct_stake_from_balance` / `deduct_stake_on_join` triggers | trigger dropped (`20260906130000`); function inert |
| `update_game_pot` / `refund_player_stake` triggers | dropped (`20260906130000`); superseded by `eds_select_cartela` / `eds_refund_cartela` |
| `payout_winners()` | **replaced** with ledger version (`130600`, then `131300`) |
| `process_confirmed_deposit`, `auto_credit_matched_deposit`, `match_user_sms` | **dropped** (`131200`) — no SMS/crypto auto-credit |
| `handle_referral_bonus` | **rewritten** to use `eds_ledger_write` (`131300`) |
| `transfer_balance` | **disabled** — always refuses (`131300`); bot `/transfer` removed |
| `eds_ensure_player` signup bonus | goes through `eds_ledger_write` |

## 9. Crypto / SMS — ZERO in executable code

Full-repo sweep of `src/` + `supabase/functions/` for `binance|bnb|blockchain|
wagmi|viem|reown|walletconnect|usdt|bsc|smart contract|wallet address|tx_hash|
sms|bank_sms|auto.?credit|automatic (deposit|payment|credit)|payment (webhook|
callback|listener|worker)`: **no matches** (the only `crypto` hits are
`crypto.randomUUID` / `crypto.subtle` — the Web Crypto API, used for HMAC).

- Frontend crypto files, hooks, `contracts/`, `get-wallet-address.*` — deleted.
- Deps `wagmi/viem/@reown/*/@tanstack/react-query` — removed (`npm i` pruned 291).
- Edge functions deleted (this pass + prior): `monitor-deposits`,
  `credit-win-to-contract`, `claim-winnings-to-contract`, `record-withdrawal`,
  `manage-bnb-withdrawal`, `get-withdrawal-wallet-info`, `process-withdrawal`,
  `receive-bank-sms`, `manual-sms-entry`, `manual-sms-verification`,
  `get-card-layouts`, `manage-bank-options`, `transfer-balance`.
- DB (`131200`): crypto functions/triggers/settings dropped;
  `deposit_transactions` / `bnb_withdrawal_requests` **archived** (history kept,
  `archived_at`); SMS auto-match triggers dropped; `bnb_withdrawal_limits_tracking`
  dropped.
- Crypto in `docs/` is historical/audit context only.

## 10. Remaining edge functions (16)

`_shared` · `admin-auth` · `admin-finance` · `cancel-request` · `claim-bingo` ·
`deselect-card` · `force-finish-game` · `get-receipt` · `my-finance` ·
`player-session` · `request-withdrawal` · `select-card` · `setup-telegram-webhook`
· `submit-deposit` · `telegram-bot-webhook` · `update-settings`

Deleted in the owner-setup pass: `bingo-auto-caller` (the pg_cron job runs the
SQL function `call_next_bingo_number()` directly — the edge fn was never called),
`telegram-notify` (unauthenticated + unused — replaced by `_shared/notify.ts`),
`mark-cell` / `mark-cells-batch` (the new `GameRoom` auto-marks from called
numbers). `force-finish-game` kept as an `ADMIN_KEY`-gated safety valve.

**Notifications** now go via `_shared/notify.ts` (best-effort, reads the bot
token, direct `sendMessage`): `admin-finance` notifies the player on deposit
approve/reject and withdrawal approve/reject/mark-paid; `claim-bingo` notifies
each winner with their exact payout after the claim window finalises.

## 11. What is NOT verified (BLOCKED)

- **No migration has been applied** and **no SQL has run** against Postgres —
  no staging project available. `supabase db push` + `yena_bingo_verification.sql`
  must run on staging. Highest risk: interaction with the many legacy
  `games`/`players` triggers (`create_next_game_after_finish`,
  `ensure_waiting_game_exists`, selection-cutoff, `check_and_declare_winner`),
  trigger firing order around `payout_winners`, and `generate_seeded_bingo_card`
  accepting the ETB10 seed offset.
- **Full E2E** (Telegram + Mini App + admin) — needs a live project + bot.
- **Logo** — placeholder SVGs; real art not supplied.
- **Telebirr account** — `settings` placeholders.

## 12. Minor follow-ups (non-blocking)

- `mark-cell` / `mark-cells-batch` edge fns unused by the new client.
- `stress-test/analyze-results.ts` + `generate-test-users.ts` may reference
  pre-የኛ columns (k6 payloads were updated).
- No CI pipeline.
- `session.tsx` triggers a react-refresh eslint *warning* (Provider + hook in one
  file) — cosmetic.

# የኛ bingo — migration report

Branch: `yena_bingo-manual-telebirr` (in a repo `git init`-ed inside
`Fanosbingo-main/Fanosbingo-main`; `main` = untouched snapshot of the original).

> **Environment limits during this migration:** no live Supabase project was
> available, and the የኛ logo image was not provided. Consequences are
> called out under "Not verified" and "Manual steps".

---

## 1. Existing architecture discovered

React 18 + Vite SPA (Telegram Mini App via `@twa-dev/sdk`), Supabase backend
(Postgres + ~118 migrations, 25 Deno edge functions, Realtime change-feeds +
polling, `pg_cron` number caller), **BNB / Binance Smart Chain** crypto payments
(wagmi/viem/reown + a Solidity deposit contract) plus a partial Ethiopian-bank
SMS deposit path. Single admin access key (no RBAC, no TOTP despite the README).
No test suite. Full detail in [`YENA_BINGO_MIGRATION_AUDIT.md`](YENA_BINGO_MIGRATION_AUDIT.md).

## 2. What was preserved

- The 75-ball Bingo engine: columns, patterns (row/col/diag/four-corners), free
  centre, `card_layouts` generator, `select_card_atomic`'s locking approach,
  `atomic_claim_bingo` (1-second simultaneous-claim window, false-BINGO
  disqualification, multiple winners), `bingo-auto-caller` cron, single-active-game
  lifecycle, spectator mode, server-time sync.
- `BingoCard` component, `bingoUtils`, the `games` / `players` / `telegram_users`
  / `settings` / `withdrawal_requests` tables, the Telegram bot's referral +
  balance-transfer features, `telegram-notify`, `update-settings`,
  `setup-telegram-webhook`, `manage-bank-options`.
- Every original migration file is untouched; all የኛ schema changes are
  new additive migrations (`20260906130000`–`20260906131200`).

## 3. What was changed

Rebrand → የኛ bingo; a new two-room / 600-cartela model with a global
4-cartela player limit and simultaneous ETB 5 + ETB 10 play; a unified wallet
ledger + audit log; manual Telebirr deposits (receipt upload + admin approval)
and withdrawals (hold → approve → mark-paid); 80/20 prize payout through the
ledger with a recorded house share; verified Telegram Mini App sessions;
role-based admin panel; complete removal of the crypto payment layer; a new
mobile-first Mini App frontend and a new admin panel; unit tests + a SQL
verification script.

## 4. Crypto functionality removed

- **Frontend:** `walletConfig.ts`, `WalletConnect`, `WalletDepositModal`,
  `BnbWithdrawalModal`, `BnbWithdrawalManagement`, `DepositManagement`,
  `BankDepositModal`, `BankWithdrawalModal`, `AccountantDashboard` (empty),
  `NetworkQualityIndicator`, 5 network/offline hooks, `utils/networkOptimization`,
  `utils/cardLayoutCache`, `utils/formatBalance`, `get-wallet-address.*`,
  `contracts/`. `App.tsx` no longer mounts `WagmiProvider`.
- **Dependencies:** `wagmi`, `viem`, `@reown/appkit`,
  `@reown/appkit-adapter-wagmi`, `@tanstack/react-query` removed
  (`npm install` pruned 291 packages).
- **Edge functions deleted:** `monitor-deposits`, `credit-win-to-contract`,
  `claim-winnings-to-contract`, `record-withdrawal`, `manage-bnb-withdrawal`,
  `get-withdrawal-wallet-info`, `process-withdrawal`, `receive-bank-sms`,
  `manual-sms-entry`, `manual-sms-verification`.
- **Database (`20260906131200`):** dropped `process_confirmed_deposit`,
  `check_bnb_withdrawal_limits`, `process_bnb_withdrawal_request`,
  `refund_bnb_withdrawal`, `complete_bnb_withdrawal`, `get_bnb_withdrawal_stats`,
  `auto_credit_matched_deposit`, `match_user_sms` and their triggers; deleted all
  `deposit_*` / `withdrawal_*bnb*` / `withdrawal_contract_*` `settings` rows;
  dropped `bnb_withdrawal_limits_tracking`. `deposit_transactions` and
  `bnb_withdrawal_requests` are **archived, not deleted** (history preserved).
- **Service worker** (`public/sw.js`) — it faked offline `{success:true}`
  responses for edge-function POSTs and replayed them; replaced with a
  self-unregistering stub.
- No user-facing "crypto", "BNB", "blockchain", "wallet address", "tx hash"
  terminology remains in the Mini App or bot.

## 5. Telebirr functionality added

`manual_deposits` table + `receipts` private storage bucket; `eds_submit_deposit`
/ `eds_review_deposit` / `eds_cancel_deposit` / `eds_telebirr_account`;
`withdrawal_requests` extended with `approved`/`paid`/`cancelled`,
`telebirr_account`, `paid_at`, `telebirr_transaction_reference`,
`payment_proof_file_path`; `eds_request_withdrawal` (hold) /
`eds_review_withdrawal` (approve/reject/mark_paid) / `eds_cancel_withdrawal`.
Edge functions: `submit-deposit` (rewritten — file validation + storage),
`request-withdrawal`, `my-finance`, `get-receipt` (owner/admin-authorized signed
URL), `cancel-request`, `admin-finance`. Bot `/deposit` + `/withdraw` commands.

## 6. የኛ branding changes

`index.html` title/meta/manifest/theme-color; `src/config/brand.ts` (single
source); shared `<Logo>/<LogoMark>/<Wordmark>`; `public/manifest.webmanifest`;
Mini App logo on splash / home / profile / game / admin; bot welcome + button +
command strings; dropped the hard-coded `multiplayer-bingo-*.bolt.host` URL;
`README.md` rewritten; `package.json` name → `yena-bingo`.

## 7. Logo integration

Placeholder SVGs (`public/logo.svg`, `logo-mark.svg`, `favicon.svg`) are wired to
the exact paths the real artwork must replace — see
[`YENA_BINGO_LOGO_PLACEMENT.md`](YENA_BINGO_LOGO_PLACEMENT.md). **Manual step:** drop
in the official PNG/SVG files and `icon-192/512.png`.

## 8–11. Cartela architecture / rooms / 600 config

One active game; a cartela is a `players` row carrying `room_type` +
`entry_price`. `cartela_layouts (room_type, cartela_number)` holds permanent
layouts: **ETB 5 #1–400** (reuses the legacy seed), **ETB 10 #1–200** (seed
offset). Config in `settings`, surfaced by `eds_config()`:
`ETB5_ROOM_PRICE=5 / ETB5_ROOM_CAPACITY=400 / ETB10_ROOM_PRICE=10 /
ETB10_ROOM_CAPACITY=200 / MAX_STANDARD_CARTELAS=600 / MAX_CARTELAS_PER_PLAYER=4 /
WINNER_PERCENTAGE=80 / HOUSE_PERCENTAGE=20`. The migration asserts
`400 + 200 = 600` and `80 + 20 = 100` at install.

## 12. 4-cartela TOTAL limit

`eds_select_cartela()` locks the `telegram_users` row `FOR UPDATE`, counts the
player's cartelas across **both rooms** for the game, and rejects when
`current + 1 > 4` (`LIMIT_REACHED`). Because the user row is locked for the whole
call, concurrent buys cannot race past 4 — the final DB state can never exceed 4.
Frontend also guards selection; the bot doesn't sell cartelas so it can't bypass.
Legacy `players` unique constraint `(game_id, telegram_user_id)` was dropped;
uniqueness is now `(game_id, room_type, selected_number)`.

## 13. Simultaneous ETB 5 + ETB 10

Both room boards render in the Bingo lobby; selection builds one pending set
across rooms; confirm creates one `players` row per cartela. `GameRoom` shows a
tab per cartela, all auto-marked from the called numbers, each with its own BINGO
claim. `eds_lobby` / `my_cartelas` split counts by room but the limit is the
combined total.

## 14. Deposit flow

See [`YENA_BINGO_FINANCIAL_FLOW.md`](YENA_BINGO_FINANCIAL_FLOW.md). Player submits
amount + Telebirr reference + receipt → `pending` → admin approves (single
idempotent credit) or rejects (reason required).

## 15. Withdrawal flow

Request debits `won_balance` as a `WITHDRAWAL_HOLD` → admin approves → admin
sends Telebirr manually → `mark_paid` with the Telebirr reference (required) →
`paid`. Reject/cancel releases the hold.

## 16. 80/20 prize flow

`payout_winners()` trigger (game → `finished`): `winner_prize_amount =
FLOOR(pot*80/100)`, split equally between winners, `house_share_amount = pot −
paid`. `WINNING_CREDIT` per winner (idempotent per game+player), one
`HOUSE_REVENUE` row. Integer ETB throughout.

## 17. Wallet / ledger changes

New `wallet_ledger` (append-only, unique idempotency index) + `eds_ledger_write`
as the sole balance mover + `eds_wallet` read model. `audit_logs` +
`eds_audit`.

## 18. Database migrations (new)

| File | Purpose |
|---|---|
| `20260906130000_yena_bingo_room_cartela_model` | config, room columns, drop multi-cartela block, `cartela_layouts`, remove legacy money triggers |
| `20260906130100_yena_bingo_wallet_ledger_and_audit` | `wallet_ledger`, `audit_logs`, `eds_ledger_write`, `eds_wallet` |
| `20260906130200_yena_bingo_select_cartela` | `eds_select_cartela`, `eds_refund_cartela`, `eds_player_cartela_count` |
| `20260906130300_yena_bingo_lobby` | `eds_lobby` |
| `20260906130400_yena_bingo_telebirr_deposits` | `manual_deposits`, `receipts` bucket, deposit RPCs |
| `20260906130500_yena_bingo_telebirr_withdrawals` | withdrawal_requests extension, withdrawal RPCs |
| `20260906130600_yena_bingo_prize_payout_ledger` | `payout_winners()` via ledger + house revenue |
| `20260906130700_yena_bingo_admin_rbac` | `admin_users`/`admin_sessions`, login/roles |
| `20260906130800_yena_bingo_admin_views` | dashboard / cartela / player aggregates |
| `20260906131000_yena_bingo_rls_hardening` | drop permissive public SELECT; `eds_my_finance` |
| `20260906131100_yena_bingo_player_bootstrap` | `eds_ensure_player` + signup bonus |
| `20260906131200_yena_bingo_crypto_teardown` | archive + drop crypto objects, disable SMS auto-credit |

## 19. API changes (edge functions)

New: `player-session`, `my-finance`, `request-withdrawal`, `cancel-request`,
`get-receipt`, `admin-auth`, `admin-finance`. Rewritten: `select-card`,
`deselect-card`, `submit-deposit`. Shared: `_shared/yena_bingo.ts` (cors, service
client, `requireAdmin` RBAC), `_shared/telegram.ts` (initData verification +
player tokens), `_shared/receipts.ts` (file validation + storage).

## 20. Frontend changes

New shell (`App.tsx` + `BottomNav`), `SessionProvider`, `useLobby`/`useFinance`,
9 screens (Home, Bingo, My Cartelas, Wallet, Deposit, Withdraw, History, Profile,
Help), `RoomBoard`, rewritten `GameRoom`, shared `Logo`/`Screen` components, ETB
formatting, dark mobile theme.

## 21. Telegram bot changes

የኛ strings; `/start` via `eds_ensure_player`; new `/deposit` `/withdraw`
commands; SMS auto-credit paste path removed; guarded web_app button when
`game_url` unset.

## 22. Admin changes

`/admin` route → `AdminApp` (RBAC login/bootstrap) with Dashboard, Deposits,
Withdrawals, Cartelas, Transactions, Audit views.

## 23. Security improvements

- Telegram `initData` HMAC verification + signed player tokens on financial
  endpoints (was: trusted `initDataUnsafe`).
- RBAC (owner/finance/support/viewer) + bcrypt passwords + 12h sessions +
  per-action audit (was: single shared key).
- Private receipt storage; access only via authorized signed URLs.
- Uploaded files validated by magic bytes + size, not filename.
- Financial tables: service-role-only RLS; player reads go through
  `eds_my_finance` keyed by verified id.
- Idempotent ledger — no double credit on deposit re-approve or game re-finish.
- Withdrawal hold prevents double-spend of pending funds.
- Unsafe offline-replay service worker removed.

## 24–25. Tests

- **Unit (vitest, 25 passing):** `src/lib/__tests__/` — 4-cartela limit
  (incl. cross-room, 5th rejected), 80/20 split (incl. multi-winner + no
  fractions), 75-ball win detection (rows/cols/diag/corners/free centre), ETB
  formatting.
- **SQL (staging):** `supabase/tests/yena_bingo_verification.sql` — transactional,
  rolls back; asserts config invariants, cartela range, buy-4-across-rooms,
  5th-rejected, balance debit + pot/80%, shared-cartela conflict, deposit
  single-credit + double-approve no-op, withdrawal hold/release/mark-paid +
  PENDING_EXISTS, winner payout ledger + house revenue + no double pay on
  re-finish.

## 26. Build status

`npm run typecheck` ✅ · `npm run test` ✅ (25/25) · `npm run build` ✅.
`npm run lint`: clean for all new `src/` files; **pre-existing** errors remain in
`stress-test/*` and `supabase/functions/manage-bank-options` (untouched original
code) — the original repo's lint was already red.

## 27. E2E status

**Not run** — needs a live Supabase project + Telegram bot. The manual script is
below.

## 28. Remaining issues / not verified

- **No migrations applied, no SQL executed.** The new migrations and RPCs are
  written to be correct and internally consistent but have **not** run against
  Postgres. Apply on staging and run `yena_bingo_verification.sql` before prod.
  Watch especially: interaction with the many legacy `games`/`players` triggers
  (`create_next_game_after_finish`, `ensure_waiting_game_exists`,
  `check_and_declare_winner`, selection-cutoff trigger), the
  `payout_winners` trigger firing order, and `generate_seeded_bingo_card`
  accepting the ETB10 seed offset (`n + 100000`).
- **Logo** placeholder — replace the art (§7).
- **Telebirr account** = `settings` placeholders until the operator provides real
  values.
- **`create_next_game_after_finish` / `ensure_waiting_game_exists`** still insert
  games with `stake_amount = 10`; harmless (pot is now per-cartela) but tidy up
  later. `BingoScreen` calls `ensure_waiting_game_exists` when no game exists.
- **Referral bonus** (`handle_referral_bonus`) still credits `balance`/
  `deposited_balance` directly, not through the ledger — works, but those credits
  won't appear in `wallet_ledger`. Route through `eds_ledger_write` in a
  follow-up if ledger completeness matters for reconciliation.
- **`/transfer`** bot command still uses the legacy `transfer_balance` RPC (not
  ledgered).
- **`stress-test/`** k6 scripts target the old `select-card` payload.
- **Amharic / i18n** — the Mini App is English-only; the legacy `bank_options`
  Amharic seed is now unused.
- No CI pipeline included.

## 29. Required environment variables

See [`YENA_BINGO_DEPLOYMENT.md`](YENA_BINGO_DEPLOYMENT.md). Frontend: `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, `VITE_APP_URL`. Edge secrets: `ADMIN_KEY`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `YENA_BINGO_APP_URL`
(`ALLOW_UNVERIFIED_TELEGRAM` dev-only). `settings` rows: `telegram_bot_token`,
`telegram_bot_username`, `game_url`, `TELEBIRR_ACCOUNT_NAME/NUMBER/INSTRUCTIONS`.

---

## Manual E2E (run on staging)

1. Bootstrap admin at `/admin`.
2. Bot `/start` → open Mini App → see የኛ branding + signup bonus.
3. Wallet → Deposit ETB 100 → shows the Telebirr account → submit reference +
   receipt → status PENDING.
4. Admin → Deposits → view receipt → Approve → wallet +100.
5. Bingo → select 2 ETB 5 + 2 ETB 10 cartelas → "4 / 4" → Confirm → all four
   appear in My Cartelas. Try a 5th → rejected.
6. Wait for the game to start → numbers broadcast → all 4 cartelas auto-mark →
   claim BINGO on a completed cartela → winner screen shows the 80% prize.
7. Winner screen → Withdraw → enter Telebirr number + amount → PENDING (held).
8. Admin → Withdrawals → Approve → send Telebirr manually → Mark paid with the
   reference → status PAID; player sees PAID in History.
9. Admin → Transactions shows GAME_ENTRY ×4, WINNING_CREDIT, HOUSE_REVENUE,
   MANUAL_TELEBIRR_DEPOSIT, WITHDRAWAL_HOLD, WITHDRAWAL_PAID; Audit log shows
   every admin action.

## Phase checklist

| Phase | State |
|---|---|
| 1–2 Audit + doc | ✅ |
| 3 Git branch | ✅ (repo `git init`-ed in the project dir) |
| 4 Rebrand | ✅ |
| 5 Logo | ✅ scaffolded (placeholder art — manual replace) |
| 6 600-cartela / rooms | ✅ code; ⏳ apply on DB |
| 7 4-cartela limit | ✅ code + unit tests; ⏳ SQL test on DB |
| 8 Simultaneous rooms | ✅ code; ⏳ E2E |
| 9–12 Telebirr deposits/withdrawals + admin | ✅ code; ⏳ E2E |
| 13 80/20 | ✅ code + unit tests; ⏳ SQL test |
| 14–17 Frontend / bot / admin | ✅ |
| 18–19 Remove crypto + migrations | ✅ code; ⏳ apply teardown migration |
| 20 Security / RBAC | ✅ |
| 21 Automated tests | ✅ unit; ✅ SQL script written; ⏳ run on DB |
| 22 Full E2E | ⏳ needs live project |
| 23 Production readiness | ⏳ after DB apply + E2E + logo + Telebirr details |

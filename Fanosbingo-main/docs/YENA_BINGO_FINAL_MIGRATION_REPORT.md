# የኛ bingo — final migration report

Branch `yena_bingo-manual-telebirr` · 18 commits · `main` = untouched original snapshot.

**Verification legend:** `PASS` = verified in code + automated test · `CODE` =
implemented and statically verified (typecheck/build), no runtime test possible
here · `BLOCKED` = needs a live Supabase project / bot / logo that this
environment does not have.

Remaining blocker: **የኛ logo image not provided** — placeholder SVGs in place.

---

## ✅ Ran end-to-end on a real Supabase stack (2026-09-06)

`supabase start` (local Docker stack, 10 containers) → **all 134 migrations
applied cleanly** (118 original + 16 የኛ + 1 fix found below).

| Check | Result |
|---|---|
| `supabase/tests/yena_bingo_verification.sql` (15 sections) | **`ALL የኛ CHECKS PASSED`** — psql exit 0 |
| `stress-test/eds-e2e.mjs` (HTTP, real edge functions) | **29 passed, 0 failed** |
| Frontend (`npm run dev` → local stack), Mini App + admin, driven with headless Chrome | Home / Bingo (both room grids) / Wallet / My Cartelas / admin dashboard all render with live data; **selected ETB5 #7 + ETB10 #3 → "Confirm 2 cartelas · 15 ETB" → 2/4, both cartelas appear**; admin dashboard shows house 8 / winner payouts 32 / deposits 500 / withdrawals 20 + the full ledger; **zero JS errors** |

Bugs found by actually running it (all fixed + committed):

| Bug | Fix |
|---|---|
| `eds_select_cartela` / `eds_refund_cartela` write `games.pot_amount` / `house_pot_amount` — **columns never existed** (legacy functions referenced them on dead paths). Returned `INTERNAL_ERROR: column "pot_amount" does not exist`. | `20260906131700` adds the columns |
| verification script: `RAISE NOTICE` `%`-escaping, a below-minimum withdrawal test amount, stale pot assertions | fixed in the script |
| admin panel inputs rendered dark (global `color-scheme: dark` bled into the light admin surface) | `.eds-admin { color-scheme: light }` |
| `X-Player-Token` / `X-Admin-Token` missing from `Access-Control-Allow-Headers` | added to `_shared` + `select-card` + `deselect-card` |

Live-verified: config invariants, cartela range, **4-cartela limit across BOTH
rooms**, 5th rejected (either room), deposited-first debit + 4 `GAME_ENTRY` rows,
**deposit single-credit + double-approve no-op**, **withdrawal hold → release /
approve → mark-paid (reference required)**, `PENDING_EXISTS`, **single +
multi-winner 80/20** (remainder `6,5,5` to winners, house **exactly 20%**),
**no-winner full refund**, no double-pay on re-finish, cross-player cartela theft
blocked, and the whole thing through the actual Mini App + admin UI.

---

## Owner-setup hardening pass (latest)

Full env/config audit → `YENA_BINGO_OWNER_SETUP_REQUIREMENTS.md` +
`YENA_BINGO_TELEGRAM_SETUP.md` / `_LOCAL_SETUP` / `_PRODUCTION_SETUP` /
`_GO_LIVE_CHECKLIST`. Fixes found and applied:

| Finding | Fix |
|---|---|
| Real bot token committed in git history (`20251213115718`) + `settings` table publicly readable (anon key could read it) | `20260906131400`: drop public read on `settings`, blank the seeded token, `eds_public_settings()` for the safe subset. **Owner must `/revoke` the token.** |
| `update-settings` let any key be written with just `ADMIN_KEY`, no validation | owner-only RBAC (`settings.manage`) + key allow-list + business-invariant re-check with rollback + audit |
| No-winner game did not refund stakes (legacy `refund_player_stake` was dropped) | `20260906131500`: `payout_winners()` refunds every cartela's `entry_price` (REFUND ledger, idempotent) when `winner_ids` is empty; house takes nothing |
| **`deduct_stake_on_player_join`** (legacy BEFORE-INSERT trigger from `20251213125251`) was never dropped by any original migration → it would DOUBLE-charge `eds_select_cartela` and bypass the ledger | `20260906131600`: drop it + every other legacy stake/pot/refund trigger name on `players` (idempotent) + a hard guard that fails the migration if any non-Realtime `players` trigger still touches `telegram_users`/`games`. Audited the games-side triggers too — payouts all route through the single idempotent `payout_winners()` |
| Custom header `X-Player-Token` not in `Access-Control-Allow-Headers` → browser preflight would fail | added to `_shared` + `select-card` / `deselect-card` CORS |
| `claim-bingo` computed a (wrong, equal-floor) `winner_prize_each` in JS | removed — the `payout_winners()` trigger is the only prize math; uses `EdgeRuntime.waitUntil` for finalisation + notifies each winner their exact payout |
| Game/deposit/withdrawal notifications orphaned (`telegram-notify` never called) | `_shared/notify.ts` → `admin-finance` (deposit/withdrawal outcomes) + `claim-bingo` (winner) |
| 4 dead edge functions (`bingo-auto-caller`, `telegram-notify`, `mark-cell`, `mark-cells-batch`) | deleted → 16 functions |
| No CI | `.github/workflows/ci.yml` (typecheck + test + build; `supabase start` + `yena_bingo_verification.sql`) + `supabase/config.toml` |
| stress-test analysis flagged legit multi-cartela as "duplicates" | fixed: room-scoped keys, only >4 is a violation |

`yena_bingo_verification.sql` extended with the no-winner refund case (§15).
typecheck + build + **28 unit tests** + eslint (`src/**` clean) all pass.

---

## 1. What was found during this verification pass

- The prior migration's crypto/SMS removal held up: **zero** `binance|bnb|
  blockchain|wagmi|viem|sms|bank_sms|auto-credit` references remain in `src/` or
  `supabase/functions/` (only `crypto.randomUUID`/`crypto.subtle` — Web Crypto).
- **Two live direct-balance-mutation paths were still active** and are now fixed:
  `handle_referral_bonus` (called by the bot `/start` referral flow) and
  `transfer_balance` (bot `/transfer`).
- **The multi-winner split was wrong**: remainder went to the house, so the house
  could keep more than 20% and winners less than 80%. Fixed.
- Three edge functions were dead crypto/SMS/transfer leftovers still in the tree.

## 2. What was already correct (kept)

75-ball engine, `card_layouts`, atomic claim, multi-winner detection,
disqualification, cron caller, single-active-game, spectator mode, server time;
`eds_select_cartela` 4-cartela limit + concurrency; the wallet ledger +
`eds_ledger_write`; manual Telebirr deposit/withdrawal RPCs + edge functions;
RBAC; receipt storage + validation + signed URLs; audit log; the whole Mini App
+ admin frontend; the prior crypto removal.

## 3. What was changed this pass

| Area | Change |
|---|---|
| Prize | `payout_winners()` rewritten: exact 20% house, winner-pool remainder distributed to winners (largest-remainder), per-winner amounts in `games.winner_payouts`, integrity guard |
| Referral | `handle_referral_bonus()` → ledger (`ADJUSTMENT`, idempotent), amounts + 20-cap from `settings` |
| Transfer | `transfer_balance()` disabled (always refuses); bot `/transfer` + state machine + inline callbacks removed |
| Edge fns | deleted `transfer-balance`, `get-card-layouts`, `manage-bank-options` |
| Frontend | `prizeSplit` returns per-winner `payouts[]`; `GameRoom` shows the player's own `winner_payouts` amount |
| Tests | `prize.test.ts` +5 cases (3/4-winner remainder, exhaustive house==20%, winners never exceed pool); `yena_bingo_verification.sql` §14 multi-winner (`4,4,4` and `6,5,5`) |
| Stress | k6 payloads → `eds_lobby` + room-aware `select-card` |
| Migration | `20260906131300_yena_bingo_final_hardening.sql` |
| Docs | this report + `YENA_BINGO_FINAL_AUDIT.md`; `YENA_BINGO_FINANCIAL_FLOW.md` prize section rewritten with the remainder rule + table |

## 4. Binance / BNB / crypto — removed (§62 zero-trace)

`src/` + `supabase/functions/` sweep for
`binance|bnb|blockchain|web3|wagmi|viem|reown|walletconnect|usdt|btc|eth|bsc|
smart contract|wallet address|tx_hash|txhash` → **no matches** (only
`crypto.randomUUID`/`crypto.subtle`). Frontend crypto components/hooks/`contracts/`
deleted; `wagmi/viem/@reown/*` deps removed. Edge fns deleted:
`monitor-deposits`, `credit-win-to-contract`, `claim-winnings-to-contract`,
`record-withdrawal`, `manage-bnb-withdrawal`, `get-withdrawal-wallet-info`,
`process-withdrawal`. DB (`131200`): crypto functions/triggers/settings dropped;
`deposit_transactions` / `bnb_withdrawal_requests` **archived** (history kept);
`bnb_withdrawal_limits_tracking` dropped. Crypto remains only in `docs/` as
history. **PASS** (code) / **BLOCKED** (can't confirm on a live DB).

## 5. Bank-SMS automatic payment — removed (§5, §56)

`src/` + `supabase/functions/` sweep for
`sms|bank_sms|auto.?credit|automatic (deposit|payment|credit)|payment (webhook|
callback|listener|worker)` → **no matches**. Edge fns deleted: `receive-bank-sms`,
`manual-sms-entry`, `manual-sms-verification`. DB (`131200`):
`trigger_auto_credit_deposit`, `trigger_match_user_sms`, `auto_credit_matched_deposit`,
`match_user_sms` dropped; `user_sms_submissions` marked DEPRECATED. Bot SMS-paste
credit path removed. **PASS** (code).

## 6. Manual Telebirr — implemented

`manual_deposits` + `withdrawal_requests` (extended) + `eds_*` RPCs +
`submit-deposit` / `request-withdrawal` / `my-finance` / `get-receipt` /
`cancel-request` / `admin-finance` + bot `/deposit` `/withdraw`. No Telebirr API;
`mark_paid` requires a human-entered Telebirr reference. **CODE**.

## 7. Deposit flow — §7, §10

Submit (amount + reference + receipt, file magic-byte + size validated → private
bucket) → `pending` → admin approve (`eds_review_deposit`: one idempotent
`MANUAL_TELEBIRR_DEPOSIT` credit via the unique ledger index; double-approve is a
no-op) or reject (reason required). **CODE**; single-credit + double-approve
covered by `yena_bingo_verification.sql` §10 → **BLOCKED** to run.

## 8. Withdrawal flow — §11, §12

`eds_request_withdrawal` debits `won_balance` as `WITHDRAWAL_HOLD` (a second
in-flight request → `PENDING_EXISTS`) → approve → `mark_paid` (Telebirr reference
required, optional proof) → `WITHDRAWAL_PAID` settle. Reject/cancel →
`WITHDRAWAL_RELEASE` credits `won_balance` back. **CODE**; hold/release/mark-paid
covered by `yena_bingo_verification.sql` §11-12 → **BLOCKED** to run.

## 9-14. 600 cartelas / ETB 5 / ETB 10 / 4-limit

Config asserted at install (`400+200=600`). `cartela_layouts (room_type,
cartela_number)`: ETB 5 #1-400, ETB 10 #1-200. `eds_select_cartela` rejects
out-of-range (`CARTELA_OUT_OF_RANGE`), enforces the 4-cartela **total** limit
under a `FOR UPDATE` row lock. Unit tests **PASS** (7 cartela-limit cases incl.
cross-room + 5th rejected). SQL test §4-9 covers range + buy-4 + 5th rejected +
concurrency + shared-cartela conflict → **BLOCKED** to run.

## 13. Simultaneous rooms — §17

`BingoScreen` shows both boards; one `players` row per cartela; `GameRoom` tabs
per cartela, all auto-marked, per-cartela claim. **CODE**.

## 14. WebSocket — §36

Supabase Realtime change-feeds + polling; DB authoritative. Preserved. **CODE**.

## 15. Winner validation — §23

`atomic_claim_bingo` (unchanged) validates game state, cartela, pattern, claim
window, duplicate claims, disqualification server-side. **CODE**.

## 16-18. Multi-winner / 80-20 / house — §20-22, §48 (FIXED)

`payout_winners()`: `winner_pool = pot*80/100` (exact, pot is a multiple of 5),
`house = pot - winner_pool` (exact 20%). Pool split: `base = pool div N`,
remainder `pool mod N` distributed +1 ETB to the first `remainder` winners →
Σ payouts = pool exactly. `WINNING_CREDIT` per winner keyed `<game>:<player>`
(idempotent), one `HOUSE_REVENUE` keyed `<game>`, guard raises if paid > pool.
Unit tests **PASS**: 1000/1→[800]; 500/2→[200,200]; 2000/2→[800,800];
1000/3→[267,267,266]; 20/3→[6,5,5]; 1000/4→[200,200,200,200]; and an exhaustive
loop over every multiple-of-5 pot ≤3000 × 1-5 winners asserting house == 20% and
winners == 80% and max-min payout ≤ 1. SQL test §13-14 → **BLOCKED** to run.

## 19. Ledger — §26, §55 (VERIFIED)

Full sweep for direct balance writes in `supabase/functions/**` and
`supabase/migrations/20260906*` → **zero**. Legacy paths: stake/pot/refund
triggers dropped; `payout_winners`, `handle_referral_bonus` rewritten to the
ledger; `process_confirmed_deposit`/SMS auto-credit dropped; `transfer_balance`
disabled; signup bonus via `eds_ledger_write`. **PASS** (static).

## 20. Referral & transfer — §28 (FIXED)

Referral: ledgered + idempotent + configurable + audited. Transfer: **disabled**
(collusion / control-bypass risk in a Bingo context) — `transfer_balance` refuses,
bot `/transfer` returns a "disabled" message, command removed from the list and
BotFather set. **CODE**.

## 21. Admin / RBAC — §29-31, §42, §57

`admin_users` (owner/finance/support/viewer, bcrypt, 12h sessions),
`eds_role_can` matrix, every financial action audited with before/after
snapshots. `admin-finance` gates each action on a permission; SUPPORT/VIEWER
cannot approve/reject/mark-paid. Withdrawal `mark_paid` needs the Telebirr
reference. **CODE**.

## 22. Receipt security — §9

Private `receipts` bucket, no public policies; `submit-deposit` validates by
magic bytes (PNG `89 50 4E 47` / JPEG `FF D8 FF` / PDF `25 50 44 46`) + 10 MB
cap; `get-receipt` returns a 120 s signed URL only to the owning player or an
admin with `receipts.view`. **CODE**.

## 23. Database migrations

13 new additive migrations (`20260906130000`–`131300`); no existing migration
edited. **CODE** — `supabase db push` not run here.

## 24. Supabase verification — **BLOCKED**

`supabase/tests/yena_bingo_verification.sql` (transactional, rolls back) is
written and covers §4-14. It has **not** run — no staging project. To run:
`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/yena_bingo_verification.sql`.

## 25. Manual E2E — **BLOCKED** (needs live project + bot + logo). Script in §69 below and in `YENA_BINGO_DEPLOYMENT.md`.

## 26. Stress test — **CODE**

k6 payloads updated (`eds_lobby`, room-aware `select-card`). Not executed (needs
k6 + a live project + generated test users). `analyze-results.ts` /
`generate-test-users.ts` may need column tweaks.

## 27. Build status — **PASS**

`npm run typecheck` ✅ · `npm run build` ✅ · `npm run test` ✅ (28/28).
`npm run lint`: new `src/` code clean (1 cosmetic react-refresh warning);
pre-existing errors remain only in untouched `stress-test/*.ts`.

## 28. Test status

| Suite | Result |
|---|---|
| `src/lib/__tests__/cartelaLimit.test.ts` (7) | **PASS** |
| `src/lib/__tests__/prize.test.ts` (8) | **PASS** |
| `src/lib/__tests__/bingo.test.ts` (7) | **PASS** |
| `src/lib/__tests__/format.test.ts` (6) | **PASS** |
| `supabase/tests/yena_bingo_verification.sql` | **BLOCKED** (no DB) |
| Manual E2E | **BLOCKED** (no project/bot) |
| k6 stress | **BLOCKED** (no project) |

## 29. Remaining issues

- `mark-cell` / `mark-cells-batch` edge fns are unused by the new auto-marking
  client (harmless; can be deleted).
- No CI pipeline.
- `session.tsx` react-refresh eslint warning (cosmetic).
- Legacy `games`/`players` triggers (`create_next_game_after_finish`,
  `ensure_waiting_game_exists`) still insert `stake_amount = 10` — harmless
  (pot is per-cartela) but should be tidied.
- `stress-test/*.ts` analysis scripts not fully re-verified against the new schema.

## 30. Required environment variables

Frontend `.env`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_APP_URL`.
Edge secrets: `ADMIN_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`,
`YENA_BINGO_APP_URL` (`ALLOW_UNVERIFIED_TELEGRAM` dev-only, leave unset in prod).
`settings` rows: `telegram_bot_token`, `telegram_bot_username`, `game_url`,
`TELEBIRR_ACCOUNT_NAME`, `TELEBIRR_ACCOUNT_NUMBER`, `TELEBIRR_INSTRUCTIONS`.

## 31. Required manual setup / production deployment

1. Create a Supabase project; `supabase link`; `supabase db push`;
   `supabase functions deploy`.
2. Set edge secrets (above). Fill the `settings` rows (above).
3. Run `yena_bingo_verification.sql` on staging — must print `ALL የኛ CHECKS PASSED`.
4. Replace the placeholder logo files in `public/` (see `YENA_BINGO_LOGO_PLACEMENT.md`);
   upload `icon-512.png` to BotFather.
5. Build the frontend (`npm ci && npm run typecheck && npm test && npm run build`);
   deploy `dist/` to a static host with SPA fallback (so `/admin` serves index.html).
6. BotFather: set the token, Mini App URL; then admin panel Settings or the
   `setup-telegram-webhook` edge fn (with `ADMIN_KEY`) to register the webhook +
   commands.
7. Bootstrap the owner admin at `/admin`.
8. Run the manual E2E (below).
9. Provide the real የኛ Telebirr account values.
10. Add a CI job: `npm run typecheck && npm test && npm run build`.

---

## §69 acceptance checklist

| Item | Status |
|---|---|
| የኛ branding complete | PASS |
| Official logo integrated | BLOCKED (placeholder wired; art not supplied) |
| Telegram Mini App works | CODE (builds; not run against live bot) |
| Telegram Bot works | CODE |
| Admin Panel works | CODE |
| 75-ball Bingo works | CODE (engine preserved) |
| ETB 5 room = 400 cartelas / ETB 10 = 200 / total 600 | PASS (config asserted at install) |
| ETB 5 #1–400 / ETB 10 #1–200 | PASS (`cartela_layouts` PK + range check) |
| Max 4 cartelas TOTAL per player | PASS (unit) / CODE (`eds_select_cartela`) |
| 4-cartela limit enforced server-side | PASS (unit) / BLOCKED (SQL run) |
| Cross-room bypass impossible | PASS (unit) / BLOCKED (SQL run) |
| Concurrent bypass impossible | CODE (`FOR UPDATE` row lock) / BLOCKED (SQL run) |
| Play ETB 5 + ETB 10 simultaneously | CODE |
| All active cartelas update in the same game | CODE (`GameRoom` auto-mark) |
| Winner validation server-side | CODE (`atomic_claim_bingo` preserved) |
| One winner receives 80% pool | PASS (unit) |
| Two winners split the 80% pool | PASS (unit) |
| 3+ winners split the pool (remainder to winners) | PASS (unit `[267,267,266]`, `[6,5,5]`) |
| Winners never exceed 80% total | PASS (unit exhaustive + SQL guard) |
| House receives exactly 20% | PASS (unit exhaustive) |
| Winner payouts idempotent | CODE (unique ledger index `<game>:<player>`) / BLOCKED (SQL run) |
| Deposit is manual Telebirr | PASS (only path) |
| Deposit requires Telebirr reference + receipt | CODE (`eds_submit_deposit` + `submit-deposit`) |
| Receipt is private | CODE (bucket has no public policy; signed URLs only) |
| Admin approves / rejects deposits | CODE |
| Deposit approval idempotent | CODE / BLOCKED (SQL run) |
| Withdrawal is manual Telebirr | PASS |
| Withdrawal hold works | CODE / BLOCKED (SQL run) |
| Admin approve / reject / mark-paid | CODE |
| Telebirr reference required for PAID | CODE (`REFERENCE_REQUIRED`) |
| Withdrawal cannot be double-paid | CODE (unique ledger index) |
| Wallet uses ledger | PASS (static sweep: 0 direct mutations in live code) |
| No unsafe direct balance mutation remains | PASS |
| Referral/transfer financial paths safe or disabled | PASS (referral→ledger; transfer→disabled) |
| RBAC works | CODE |
| Audit logs work | CODE |
| Binance / BNB / crypto / blockchain removed | PASS (zero-trace sweep) |
| Crypto dependencies removed | PASS (`npm i` pruned 291) |
| Crypto env vars removed | PASS |
| Bank-SMS payment / automatic SMS credit removed | PASS (zero-trace sweep) |
| Automatic payment removed | PASS |
| No fake Telebirr API | PASS |
| Database migrations verified | BLOCKED (`supabase db push` not run) |
| Supabase verification executed on staging | BLOCKED |
| Manual E2E completed | BLOCKED |
| Stress tests updated | PASS (payloads) / BLOCKED (execution) |
| Build passes | PASS |
| Tests pass | PASS (28/28 unit) |
| No critical security issue remains | PASS (given the code; pending live verification) |

## Manual E2E script (run on staging)

1. Bootstrap owner admin at `/admin`.
2. Bot `/start` → open Mini App → የኛ branding + signup bonus in the ledger.
3. Wallet → Deposit ETB 100 → Telebirr account shown → submit reference + receipt
   → PENDING.
4. Admin → Deposits → view receipt → Approve → wallet +100 (one `MANUAL_TELEBIRR_DEPOSIT`
   ledger row). Approve again → no change.
5. Bingo → select 2 ETB 5 + 2 ETB 10 → "4 / 4" → Confirm → 4 in My Cartelas.
   Try a 5th (either room) → rejected.
6. Game starts → numbers broadcast → all 4 cartelas auto-mark → claim BINGO on a
   completed cartela → winner screen shows the 80% prize (or the player's share).
7. Second player also wins in the same window → both get half the pool, house 20%.
8. Winner → Withdraw → Telebirr number + amount → PENDING (held; `won_balance`
   drops).
9. Admin → Withdrawals → Approve → send Telebirr manually → Mark paid with the
   reference (+ optional proof) → PAID; player History shows PAID + reference.
10. Admin → Transactions: `GAME_ENTRY`×4, `WINNING_CREDIT`(s), `HOUSE_REVENUE`,
    `MANUAL_TELEBIRR_DEPOSIT`, `WITHDRAWAL_HOLD`, `WITHDRAWAL_PAID`; Audit log shows
    every admin action with before/after.

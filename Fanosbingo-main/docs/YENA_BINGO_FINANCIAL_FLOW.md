# የኛ — financial flow

Every player balance change is a row in **`wallet_ledger`** written in the same
transaction as the balance update, by **`eds_ledger_write()`** — the only
sanctioned balance mover. The ledger has a unique index on
`(entry_type, reference_type, reference_id)` so the same event can never be
applied twice.

## Balances (`telegram_users`)

| Field | Meaning | Withdrawable? |
|---|---|---|
| `deposited_balance` | credited by approved Telebirr deposits + signup bonus | ❌ play only |
| `won_balance` | credited by Bingo winnings | ✅ |
| `balance` | legacy mirror = deposited + won | — |

`eds_wallet(user)` returns `{ deposited_balance, won_balance, total_balance, on_hold, withdrawable }`.
`on_hold` = sum of `WITHDRAWAL_HOLD` − sum of `WITHDRAWAL_PAID`/`WITHDRAWAL_RELEASE`.

## Ledger entry types

| Type | Direction | Effect |
|---|---|---|
| `ADJUSTMENT` (signup) | credit | +deposited (one-time bonus) |
| `MANUAL_TELEBIRR_DEPOSIT` | credit | +deposited on admin approval |
| `GAME_ENTRY` | debit | −deposited then −won, per cartela |
| `REFUND` | credit | +deposited when a cartela is released pre-start |
| `WINNING_CREDIT` | credit | +won on game finish |
| `WITHDRAWAL_HOLD` | debit | −won when a withdrawal is requested |
| `WITHDRAWAL_RELEASE` | credit | +won when a withdrawal is rejected/cancelled |
| `WITHDRAWAL_PAID` | settle | 0 (closes the hold; money already left at hold time) |
| `HOUSE_REVENUE` | credit | house ledger only, no player balance |

## Deposit (manual Telebirr)

```
player: Deposit screen → amount + Telebirr reference + receipt (PNG/JPG/PDF)
  → submit-deposit edge fn: validate file (magic bytes, ≤10MB) → store in the
    private `receipts` bucket → eds_submit_deposit → manual_deposits(status=pending)
admin: Deposits view → view receipt (signed URL, 120s) → Approve / Reject
  approve → eds_review_deposit: eds_ledger_write(MANUAL_TELEBIRR_DEPOSIT) ONCE
            → manual_deposits.status=approved, audit_logs row
  reject  → reason required → status=rejected, audit_logs row (no credit)
```

Double-approve is a no-op (unique ledger index + `ALREADY_REVIEWED` guard).

## Withdrawal (manual Telebirr)

```
player: Withdraw screen → amount (≤ won_balance) + Telebirr number
  → request-withdrawal → eds_request_withdrawal:
       won_balance −= amount as WITHDRAWAL_HOLD, withdrawal_requests(status=pending)
       (a second in-flight request is refused: PENDING_EXISTS)
admin: Withdrawals view
  approve  → status=approved (no balance change)
  reject   → WITHDRAWAL_RELEASE (won_balance += amount), status=rejected
  mark_paid→ requires the Telebirr transaction reference of the payment the admin
             SENT (+ optional proof file) → WITHDRAWAL_PAID settle, status=paid,
             total_withdrawn += amount
player: cancel a still-pending request → WITHDRAWAL_RELEASE, status=cancelled
```

The frontend never sees a "money transferred automatically" message — `mark_paid`
only records that a human sent it.

## Prize (80 / 20) and multi-winner split

Computed in `payout_winners()` (BEFORE UPDATE trigger, fires when a game's status
becomes `finished`).

**The house always gets exactly 20%.** The game pot is the sum of the
participating cartelas' `entry_price`, and every cartela costs 5 or 10 ETB, so
`game_pot` is always a multiple of 5. Therefore `game_pot * 80 / 100` and
`game_pot * 20 / 100` are always whole numbers — no rounding at the pot level.

```
game_pot            = SUM of every participating cartela's entry_price (== games.total_pot)
winner_prize_amount = game_pot * 80 / 100          # exact — the whole winner pool
house_share_amount  = game_pot − winner_prize_amount   # exact 20%
```

**Splitting the winner pool between N winners** is the only place integer
rounding happens. The remainder is given **to the winners**, never kept by the
house:

```
base      = winner_prize_amount div N
remainder = winner_prize_amount mod N            # 0 .. N-1
winners are ordered by player id; the first `remainder` winners get base + 1 ETB,
the rest get base.
Σ payouts  = base*N + remainder = winner_prize_amount   (the whole pool, exactly)
```

Examples:

| pot | winners | winner pool (80%) | payouts | house (20%) |
|---|---|---|---|---|
| 1000 | 1 | 800 | [800] | 200 |
| 500 | 2 | 400 | [200, 200] | 100 |
| 1000 | 3 | 800 | [267, 267, 266] | 200 |
| 20 | 3 | 16 | [6, 5, 5] | 4 |
| 1000 | 4 | 800 | [200, 200, 200, 200] | 200 |

Each winner is credited with a `WINNING_CREDIT` ledger row keyed
`<game_id>:<player_id>` for **their** payout amount (idempotent — a re-finish
never double-pays). Per-winner amounts are also stored in `games.winner_payouts`
(`{player_id: amount}`) for the winner screen. The house share is a single
`HOUSE_REVENUE` row keyed `<game_id>`. A guard in the trigger raises an exception
if the total paid to winners ever exceeds the pool. All amounts are integer ETB;
no floating-point arithmetic touches money.

The frontend only ever displays `games.winner_payouts[myPlayerId]` /
`winner_prize_amount` — it cannot submit or influence a prize amount.

## Audit

`audit_logs` gets a row for every admin financial action
(`deposit.approve/reject`, `withdrawal.approve/reject/mark_paid`, `admin.*`) with
`previous_state` / `new_state` JSON snapshots and the acting admin username.

# የኛ — admin guide

The admin panel is served at **`/admin`** on the same site as the Mini App.

## Accounts & roles (RBAC)

| Role | Can |
|---|---|
| `owner` | everything, including creating/disabling admins |
| `finance` | deposits, withdrawals, receipts, wallets, transactions, house revenue, read everything |
| `support` | read players / games / cartelas / audit / deposits / withdrawals — **no** financial actions |
| `viewer` | read-only dashboards |

### First login (bootstrap)

1. Set the `ADMIN_KEY` edge-function secret (`supabase secrets set ADMIN_KEY=...`).
2. Open `/admin` → "First time? Create the owner account".
3. Enter a username, a password (≥10 chars) and the `ADMIN_KEY`.
   This calls `eds_admin_bootstrap` (works only while no admin exists) and signs you in.
4. As owner, create the other admins (SQL for now: `SELECT eds_admin_upsert(<owner-token>, 'jane', 'password', 'finance', true);`
   — a UI for this can be added later).

Sessions last 12 hours (`admin_sessions`). "Log out" revokes the token.
The `ADMIN_KEY` still works as a break-glass owner login on every admin endpoint.

## Deposits

`Deposits` tab → filter by status.

- **view** — opens the receipt via a 120-second signed URL.
- **Approve** — confirm the Telebirr payment landed, then approve. The wallet is
  credited exactly once. Approving twice does nothing.
- **Reject** — a reason is **required**; it is shown to the player.

Verify against Telebirr yourself: the app has **no** Telebirr API and never
auto-verifies.

## Withdrawals

`Withdrawals` tab.

1. **Approve** a `pending` request once you've decided to pay it.
2. Send the money **manually** from your Telebirr app to the player's number.
3. **Mark paid** — enter the **Telebirr transaction reference of the payment you
   just sent** (required) and optionally attach a screenshot/PDF.
   Only then does the request become `paid`.
4. **Reject** (from `pending` or `approved`) — reason required; the held amount is
   returned to the player's winnings.

Never mark a withdrawal paid before you have actually sent the Telebirr payment.

## Cartelas

`Cartelas` tab shows, per room: price, total, owned/reserved, available. The
"limit violations" list should always be empty — the backend rejects a 5th
cartela atomically.

## Transactions & Audit

`Transactions` = the full `wallet_ledger` (filter by type). `Audit log` = every
privileged action with before/after snapshots.

## Settings

Telebirr account details and business numbers live in the `settings` table:

```sql
UPDATE settings SET value = 'የኛ PLC'      WHERE id = 'TELEBIRR_ACCOUNT_NAME';
UPDATE settings SET value = '09XXXXXXXX'         WHERE id = 'TELEBIRR_ACCOUNT_NUMBER';
UPDATE settings SET value = 'Send the exact ...' WHERE id = 'TELEBIRR_INSTRUCTIONS';
UPDATE settings SET value = 'https://your-app'   WHERE id = 'game_url';
```

Room prices/capacities and the 80/20 split are also `settings` rows, but changing
them after launch is a business decision — the room capacities must still sum to
`MAX_STANDARD_CARTELAS` and the percentages to 100 (the migration enforces this
at install time; keep it true).

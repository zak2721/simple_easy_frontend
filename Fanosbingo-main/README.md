# የኛ bingo

A real-time, multiplayer 75-ball Bingo platform delivered as a **Telegram Mini App** and
**Telegram Bot**, with a web **Admin Panel** for managing games, players, cartelas,
manual **Telebirr** deposits/withdrawals, winners, and financial records.

> **Migration in progress.** This repository is being migrated from the original
> crypto/BNB "Fanos Bingo" codebase to የኛ bingo with a manual Telebirr
> payment model. See [`docs/YENA_BINGO_MIGRATION_AUDIT.md`](docs/YENA_BINGO_MIGRATION_AUDIT.md)
> and [`docs/YENA_BINGO_MIGRATION_REPORT.md`](docs/YENA_BINGO_MIGRATION_REPORT.md) for status.

---

## Business model

| Room | Cartela price | Cartelas | Cartela numbers |
|---|---|---|---|
| **ETB 5 room** | ETB 5 | 400 | #1–400 |
| **ETB 10 room** | ETB 10 | 200 | #1–200 |
| **Total** | — | **600** | numbers restart per room |

- A player may own/play a **maximum of 4 cartelas total**, counted **across both rooms**
  in the same game/session. Enforced authoritatively in the backend.
- A player may play the **ETB 5 and ETB 10 rooms simultaneously** in the same game.
- **75-ball Bingo:** B 1–15, I 16–30, N 31–45, G 46–60, O 61–75, centre free.
  Win = any row, any column, either diagonal, or four corners.
- **Prize split:** winner **80%**, የኛ house **20%**. Computed by the backend
  from the actual participating cartelas.

## Payments (manual Telebirr)

There is **no automatic Telebirr API**. All deposits and withdrawals are verified by a human.

**Deposit:** player enters an amount → app shows the የኛ Telebirr account →
player pays in their own Telebirr app → player submits the Telebirr transaction
reference and uploads a receipt (PNG/JPG/JPEG/PDF) → status `PENDING` → an admin
reviews and `APPROVES` or `REJECTS` → on approval the wallet is credited exactly once.

**Withdrawal:** winner taps Withdraw → enters their Telebirr number and amount →
the amount is placed on **hold** → status `PENDING` → admin `APPROVES`, sends the
money manually via Telebirr, records the Telebirr reference (+ optional proof), and
marks it `PAID` → the held amount is debited. Rejections/cancellations release the hold.

## Architecture

```
Telegram Mini App (React + Vite + Tailwind)   Telegram Bot
                 |                                  |
                 +----------------+-----------------+
                                  |
                    Supabase Edge Functions (Deno)
                                  |
        PostgreSQL (RLS)  •  Supabase Realtime  •  Storage (receipts)  •  pg_cron
```

- **Wallet & ledger:** every balance change writes a `wallet_ledger` row.
- **Audit:** every admin financial action writes an `audit_logs` row.
- **Authoritative server:** card selection, number calling, winner validation, prize
  math, and the 4-cartela limit are all enforced server-side. Realtime/WebSocket state
  is never the source of truth for money or results.

## Development

```bash
npm install
cp .env.example .env      # fill in your Supabase project values
npm run dev               # Vite dev server
npm run typecheck
npm run lint
npm run build
```

### Environment

Frontend (`.env`, Vite `VITE_*`):

| Var | Purpose |
|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key |
| `VITE_APP_URL` | Public URL of the deployed Mini App |

Backend runtime config lives in the `settings` table and Supabase Edge Function secrets
(`SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEBIRR_ACCOUNT_NAME`,
`TELEBIRR_ACCOUNT_NUMBER`, `TELEBIRR_INSTRUCTIONS`). Never commit real secrets.

See [`docs/YENA_BINGO_DEPLOYMENT.md`](docs/YENA_BINGO_DEPLOYMENT.md) for full setup, and
[`docs/YENA_BINGO_LOGO_PLACEMENT.md`](docs/YENA_BINGO_LOGO_PLACEMENT.md) for the logo files.

## Documentation

- `docs/YENA_BINGO_MIGRATION_AUDIT.md` — audit of the original (crypto) codebase
- `docs/YENA_BINGO_FINAL_AUDIT.md` — verification audit of the current repo state
- `docs/YENA_BINGO_FINANCIAL_FLOW.md` — wallet, ledger, deposit, withdrawal, 80/20 + multi-winner
- `docs/YENA_BINGO_ADMIN_GUIDE.md` — admin panel operations & RBAC
- `docs/YENA_BINGO_DEPLOYMENT.md` — deployment, environment, verification
- `docs/YENA_BINGO_LOGO_PLACEMENT.md` — the logo files you must supply
- `docs/YENA_BINGO_MIGRATION_REPORT.md` — first migration report
- `docs/YENA_BINGO_FINAL_MIGRATION_REPORT.md` — final report + §69 acceptance checklist (PASS/CODE/BLOCKED)

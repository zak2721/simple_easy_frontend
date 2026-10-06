# የኛ bingo — local setup

Run the Mini App + admin locally against a real Supabase project. There is no
local backend to run — the backend *is* Supabase (Postgres + edge functions +
Realtime). Use a **separate "staging" Supabase project**, never production.

## 0. Prerequisites

- Node.js 20+
- `supabase` CLI (`npm i -g supabase` or `brew install supabase/tap/supabase`)
- `psql` (for the verification script)
- A Supabase **staging** project

## 1. Install

```bash
cd Fanosbingo-main/Fanosbingo-main
npm ci
```

## 2. Frontend env

```bash
cp .env.example .env
```

Edit `.env`:

```
VITE_SUPABASE_URL=https://<staging-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<staging anon key>
VITE_DEV_TELEGRAM_USER={"id":111,"first_name":"Dev","username":"dev"}
```

## 3. Push the database

```bash
supabase link --project-ref <staging-ref>
# enable pg_cron and pgcrypto in the dashboard first (Database -> Extensions)
supabase db push
```

Expect the config-invariant `DO $$ … $$` blocks to pass (`400+200=600`, `80+20=100`).

## 4. Deploy edge functions + secrets

```bash
supabase functions deploy
supabase secrets set \
  ADMIN_KEY="$(openssl rand -hex 32)" \
  ALLOW_UNVERIFIED_TELEGRAM=true            # DEV ONLY — lets VITE_DEV_TELEGRAM_USER work
# (bot token/username optional for pure frontend dev; needed to test /deposit etc.)
```

Save the `ADMIN_KEY` you generated.

## 5. Storage

The `receipts` bucket is created by migration `20260906130400`. Confirm:
Dashboard → Storage → `receipts` exists, **not public**, allowed types
`image/png,image/jpeg,application/pdf`.

## 6. Telebirr settings (placeholders are fine for dev)

```sql
-- optional for dev; the deposit screen shows "not configured" otherwise
UPDATE settings SET value = 'የኛ (test)' WHERE id = 'TELEBIRR_ACCOUNT_NAME';
UPDATE settings SET value = '0900000000'       WHERE id = 'TELEBIRR_ACCOUNT_NUMBER';
```

## 7. Create the first admin

Start the app (step 9), open `http://localhost:5173/admin` →
"First time? Create the owner account" → username + password (≥10) + the
`ADMIN_KEY` from step 4.

## 8. Verify the database logic

```bash
psql "postgresql://postgres:<pw>@db.<staging-ref>.supabase.co:5432/postgres" \
  -v ON_ERROR_STOP=1 -f supabase/tests/yena_bingo_verification.sql
```

Must end with `ALL የኛ CHECKS PASSED` (it runs in a transaction and rolls
back — no test data left behind).

## 9. Run the frontend

```bash
npm run dev            # http://localhost:5173  (Mini App)
                       # http://localhost:5173/admin  (admin panel)
```

With `VITE_DEV_TELEGRAM_USER` set + `ALLOW_UNVERIFIED_TELEGRAM=true`, the Mini
App opens as user 111 without Telegram.

## 10. Other commands

```bash
npm run typecheck      # tsc --noEmit
npm run test           # 28 vitest unit tests (cartela limit, 80/20, win detection)
npm run build          # production build -> dist/
npm run lint
```

## 11. Test the Telegram bot locally (optional)

Set a real bot token secret, point the Web App URL at an HTTPS tunnel of your dev
server (e.g. `cloudflared tunnel --url http://localhost:5173`), set
`settings.game_url` to that URL, run `setup-telegram-webhook`, then `/start` the
bot.

## Notes

- `supabase/functions/mark-cell` / `mark-cells-batch` are legacy — the new
  `GameRoom` auto-marks from called numbers and doesn't call them.
- `stress-test/` k6 scripts run against a project too; `generate-test-users.ts`
  seeds `telegram_users` — use only on staging.

# የኛ — deployment

## Components

| Piece | Where |
|---|---|
| Mini App + Admin (static SPA) | any static host (Netlify, Vercel, Cloudflare Pages, Supabase hosting) |
| Database + Edge Functions + Storage + Realtime + pg_cron | Supabase project |
| Telegram Bot | webhook → the `telegram-bot-webhook` edge function |

## 1. Supabase project

```bash
supabase link --project-ref <ref>
supabase db push          # applies supabase/migrations/* in order
supabase functions deploy # deploys everything under supabase/functions/*
```

The migrations create the `receipts` **private** storage bucket automatically.

### Edge function secrets

```bash
supabase secrets set \
  ADMIN_KEY=<long random string> \
  TELEGRAM_BOT_TOKEN=<from @BotFather> \
  TELEGRAM_BOT_USERNAME=<bot username without @> \
  YENA_BINGO_APP_URL=https://<your-mini-app-domain>
# SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided by the platform
# ALLOW_UNVERIFIED_TELEGRAM  -> leave UNSET in production
```

### `settings` rows to fill in (SQL, or the admin panel later)

```sql
UPDATE settings SET value = '<bot token>'         WHERE id = 'telegram_bot_token';
UPDATE settings SET value = '<bot username>'      WHERE id = 'telegram_bot_username';
UPDATE settings SET value = 'https://<mini app>'  WHERE id = 'game_url';
UPDATE settings SET value = 'የኛ ...'       WHERE id = 'TELEBIRR_ACCOUNT_NAME';
UPDATE settings SET value = '09XXXXXXXX'          WHERE id = 'TELEBIRR_ACCOUNT_NUMBER';
UPDATE settings SET value = '<payment steps>'     WHERE id = 'TELEBIRR_INSTRUCTIONS';
```

### pg_cron

The number-caller cron (`bingo-auto-caller`) comes from the original migrations.
Confirm it is scheduled: `SELECT * FROM cron.job;`

## 2. Frontend

```bash
cp .env.example .env      # fill VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_APP_URL
npm ci
npm run typecheck && npm run test && npm run build
# deploy dist/ to your static host
```

`index.html` reads `%VITE_SUPABASE_URL%` for a preconnect hint at build time.

### Logo

Replace the placeholder art in `public/` — see
[`YENA_BINGO_LOGO_PLACEMENT.md`](YENA_BINGO_LOGO_PLACEMENT.md). Upload
`icon-512.png` to @BotFather for the Mini App icon.

## 3. Telegram

1. @BotFather → create the bot → set the token in secrets + `settings`.
2. @BotFather → configure the Web App / Mini App URL = your static host.
3. In the admin panel → Settings, or call the `setup-telegram-webhook` edge
   function with the `ADMIN_KEY`, to register the webhook + command list.

## 4. First admin

Open `/admin` and bootstrap the owner account (see the admin guide).

## 5. Verify

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/yena_bingo_verification.sql
```

Then walk the end-to-end journey in
[`YENA_BINGO_MIGRATION_REPORT.md`](YENA_BINGO_MIGRATION_REPORT.md) → "Manual E2E".

## Notes / not done here

- No CI config is included. Add one that runs `npm run typecheck && npm test && npm run build`.
- `stress-test/` k6 scripts still target the old `select-card` payload; update the
  body to `{ gameId, room, cartelaNumber, telegramUserId, playerName }` before use.
- The legacy `deposit_transactions` / `bnb_withdrawal_requests` tables are kept
  (archived) for history; nothing writes to them.

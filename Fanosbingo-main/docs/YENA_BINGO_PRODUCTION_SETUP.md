# የኛ bingo — production setup

Prereq: `YENA_BINGO_OWNER_SETUP_REQUIREMENTS.md` completed (leaked token revoked,
values gathered). Use a **fresh** Supabase project for production, separate from
staging.

## 1. Supabase production project

```bash
supabase link --project-ref <prod-ref>
```

- Dashboard → Database → Extensions: enable **`pg_cron`** and **`pgcrypto`**.
- Dashboard → Settings → API: note the **URL**, **anon key**. Keep the
  **service_role key** and **DB password** secret.

```bash
supabase db push          # applies supabase/migrations/* (14 የኛ + originals)
supabase functions deploy # deploys all 20 edge functions
```

Watch `db push` output: the install-time `DO $$` blocks assert
`ETB5_ROOM_CAPACITY + ETB10_ROOM_CAPACITY = 600`, `WINNER% + HOUSE% = 100`,
`MAX_CARTELAS_PER_PLAYER = 4`. If any fails, the push aborts — fix the `settings`
and re-run.

## 2. Edge function secrets

```bash
supabase secrets set \
  ADMIN_KEY='<openssl rand -hex 32>' \
  TELEGRAM_BOT_TOKEN='<new bot token>' \
  TELEGRAM_BOT_USERNAME='<bot username, no @>' \
  YENA_BINGO_APP_URL='https://<mini-app-domain>'
# DO NOT set ALLOW_UNVERIFIED_TELEGRAM in production.
```

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

## 3. `settings` rows

Via the admin panel (Settings) after step 6, or SQL now:

```sql
UPDATE settings SET value='<mini-app-domain>'        WHERE id='game_url';
UPDATE settings SET value='የኛ ...'            WHERE id='TELEBIRR_ACCOUNT_NAME';
UPDATE settings SET value='09XXXXXXXX'              WHERE id='TELEBIRR_ACCOUNT_NUMBER';
UPDATE settings SET value='<payment steps, am/en>' WHERE id='TELEBIRR_INSTRUCTIONS';
UPDATE settings SET value='<bot username>'          WHERE id='telegram_bot_username';
-- telegram_bot_token: prefer the edge secret; leave the settings row '' unless
-- you want the admin "Set up webhook" button to work without the secret.
```

## 4. Storage

`receipts` bucket is created by migration — verify it is **private** (no public
policies). Consider a Storage retention/lifecycle rule for old receipts per your
data-retention policy.

## 5. Frontend

```bash
npm ci
npm run typecheck && npm run test && npm run build
```

Deploy `dist/` to your static host with these settings:

- **HTTPS** (required).
- **SPA fallback / rewrite**: every path → `/index.html` (so `/admin` loads).
  - Netlify: `_redirects` → `/*  /index.html  200`
  - Vercel: `vercel.json` → `{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }`
  - Cloudflare Pages: automatic for SPAs.
- Frontend build-time env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
  (leave `VITE_DEV_TELEGRAM_USER` unset).
- Cache: long cache for `/assets/*` (hashed), no-cache for `index.html` and
  `sw.js` (the `sw.js` stub unregisters any old service worker).

## 6. Telegram

- @BotFather: token set, `/setdomain` = frontend domain, Web App URL =
  frontend URL, `icon-512.png` uploaded.
- Register webhook + commands: admin Settings, or `setup-telegram-webhook` with
  the `ADMIN_KEY`.
- `getWebhookInfo` shows your URL, no errors.

## 7. Owner admin

`https://<mini-app-domain>/admin` → bootstrap the owner (username + password ≥10
+ `ADMIN_KEY`). Then create `finance` / `support` accounts:

```sql
-- as owner; get <owner-token> from the browser localStorage key eds_admin_token
SELECT eds_admin_upsert('<owner-token>', 'finance1', '<password>', 'finance', true);
```

Rotate `ADMIN_KEY` once real accounts exist (`supabase secrets set ADMIN_KEY=…`).

## 8. Verification (staging or a throwaway prod check before launch)

```bash
psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/yena_bingo_verification.sql
# expect: ALL የኛ CHECKS PASSED
```

Then the manual E2E from `YENA_BINGO_FINAL_MIGRATION_REPORT.md` §69.

## 9. CORS hardening (optional)

Edge functions use `Access-Control-Allow-Origin: *`. This is normal for a
Telegram Mini App (webview origin varies by client) and every sensitive endpoint
already requires a verified player/admin token. If your compliance needs a fixed
origin, edit `supabase/functions/_shared/yena_bingo.ts` `corsHeaders` to echo an
allow-list from an `YENA_BINGO_ALLOWED_ORIGINS` secret — and test on iOS Telegram,
Android Telegram, Telegram Desktop, and Web-K/Web-A before shipping.

## 10. Monitoring / ops

- Supabase Dashboard → Logs (edge functions, Postgres, Realtime).
- Enable **Point-in-Time Recovery** (this DB holds money + the ledger).
- Admin panel → Transactions / Audit log for financial reconciliation.
- Alert on: pending deposits/withdrawals piling up, `HOUSE_REVENUE` vs expected,
  any `payout_winners` exception in the DB logs.

## 11. Rollback

- Frontend: redeploy the previous `dist/` build.
- Database: migrations are additive and mostly `CREATE OR REPLACE`; a bad config
  change is fixed by setting the `settings` row back (the admin `update-settings`
  refuses invariant-breaking values). Restore from PITR only for data corruption.
- Bot: `deleteWebhook` to pause all bot traffic.

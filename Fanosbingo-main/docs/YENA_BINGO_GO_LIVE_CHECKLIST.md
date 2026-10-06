# የኛ bingo — go-live checklist

Work top to bottom. Don't skip STEP 11/12. Details for each step are in
`YENA_BINGO_PRODUCTION_SETUP.md` and `YENA_BINGO_TELEGRAM_SETUP.md`.

---

### STEP 0 — Revoke the leaked bot token
- [ ] @BotFather → `/revoke` on the bot from git history; get a fresh token
- [ ] Confirm the old token is dead: `curl https://api.telegram.org/bot<OLD>/getMe` → 401

### STEP 1 — Create the Supabase production project
- [ ] New project (region close to Ethiopia, e.g. `eu-central` / `ap-south`)
- [ ] Enable extensions: `pg_cron`, `pgcrypto`
- [ ] Note URL + anon key; keep service_role key + DB password in a password manager

### STEP 2 — Push the database
- [ ] `supabase link --project-ref <prod-ref>`
- [ ] `supabase db push` → completes without the invariant `DO $$` blocks failing
- [ ] `SELECT * FROM cron.job;` → `call-bingo-numbers` present
- [ ] `SELECT eds_config();` → 600 / 400 / 200 / 4 / 80 / 20

### STEP 3 — Storage
- [ ] Dashboard → Storage → `receipts` bucket exists, **NOT public**
- [ ] Allowed MIME types = `image/png,image/jpeg,application/pdf`, 10 MB limit

### STEP 4 — Deploy edge functions + secrets
- [ ] `supabase functions deploy` (20 functions)
- [ ] `ADMIN_KEY` = `openssl rand -hex 32` → `supabase secrets set ADMIN_KEY=…` (saved)
- [ ] `supabase secrets set TELEGRAM_BOT_TOKEN=… TELEGRAM_BOT_USERNAME=… YENA_BINGO_APP_URL=https://…`
- [ ] `ALLOW_UNVERIFIED_TELEGRAM` is **NOT** set

### STEP 5 — Build & deploy the frontend
- [ ] `npm ci && npm run typecheck && npm run test && npm run build` all green
- [ ] Deploy `dist/` with **HTTPS** + **SPA fallback** (all routes → index.html)
- [ ] Build env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (no dev vars)
- [ ] Open `https://<domain>/` → የኛ splash loads (Telegram-only gate is expected in a browser)
- [ ] Open `https://<domain>/admin` → admin login screen loads

### STEP 6 — Telebirr receiving account
- [ ] `settings.TELEBIRR_ACCOUNT_NAME` = your real የኛ Telebirr name
- [ ] `settings.TELEBIRR_ACCOUNT_NUMBER` = your real Telebirr number/phone
- [ ] `settings.TELEBIRR_INSTRUCTIONS` = clear steps (Amharic + English)
- [ ] `SELECT eds_telebirr_account();` → `"configured": true`

### STEP 7 — Application secrets
- [ ] `ADMIN_KEY` generated + stored (done in STEP 4)
- [ ] No secret is in any committed file (`git grep` for tokens returns nothing new)

### STEP 8 — Create the OWNER admin
- [ ] `/admin` → "Create the owner account" → username + password (≥10) + `ADMIN_KEY`
- [ ] Log in → dashboard loads
- [ ] Create `finance` + `support` accounts (SQL `eds_admin_upsert`, see prod doc)
- [ ] (later) rotate `ADMIN_KEY`

### STEP 9 — Production domain & Telegram
- [ ] `settings.game_url` = `https://<domain>`
- [ ] @BotFather: token set, `/setdomain`, Web App URL = `https://<domain>`, icon uploaded
- [ ] Register webhook + commands (admin Settings, or `setup-telegram-webhook` + `ADMIN_KEY`)
- [ ] `curl https://api.telegram.org/bot<token>/getWebhookInfo` → your URL, `last_error_message` empty

### STEP 10 — Deploy sanity
- [ ] Bot `/start` in Telegram → welcome + "Play የኛ bingo" button
- [ ] Tap Play → Mini App opens inside Telegram → የኛ home, your name, ETB balance

### STEP 11 — Database verification (BLOCKER)
- [ ] `psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/yena_bingo_verification.sql`
- [ ] Output ends with **`ALL የኛ CHECKS PASSED`**

### STEP 12 — Manual end-to-end (BLOCKER) — do it on staging or a test player
- [ ] Player deposits ETB 100 → PENDING (Telebirr account shown, receipt uploaded)
- [ ] Admin opens the deposit → views the receipt → **Approve** → wallet +100 (one `MANUAL_TELEBIRR_DEPOSIT` ledger row)
- [ ] Admin clicks Approve again → no change (idempotent)

### STEP 13 — Test deposit rejection
- [ ] Submit a deposit → Admin **Reject** with a reason → wallet unchanged, reason shown to player

### STEP 14 — Test Bingo + cartela limit
- [ ] Player buys 2 ETB 5 + 2 ETB 10 cartelas → "4 / 4"
- [ ] Player tries a 5th (either room) → rejected ("Maximum 4 cartelas")
- [ ] Game starts → numbers broadcast → all 4 cartelas auto-mark

### STEP 15 — Test winner
- [ ] Player completes a line → BINGO → winner screen shows the 80% prize (their share)
- [ ] `SELECT winner_prize_amount, house_share_amount, winner_payouts FROM games WHERE id = …;`
      → house = exactly 20% of the pot, winners' total = exactly 80%
- [ ] Two simultaneous winners → each gets half the pool, house still 20%

### STEP 16 — Test withdrawal
- [ ] Winner requests ETB X → PENDING, `won_balance` drops by X (WITHDRAWAL_HOLD)
- [ ] Admin **Approve** → send Telebirr manually → **Mark paid** with the Telebirr reference (required)
- [ ] Player History shows **PAID** + the reference
- [ ] Try marking paid without a reference → rejected

### STEP 17 — Verify the ledger
- [ ] Admin → Transactions: `GAME_ENTRY` ×4, `WINNING_CREDIT`, `HOUSE_REVENUE`,
      `MANUAL_TELEBIRR_DEPOSIT`, `WITHDRAWAL_HOLD`, `WITHDRAWAL_PAID`
- [ ] `SELECT SUM(CASE direction WHEN 'credit' THEN amount WHEN 'debit' THEN -amount ELSE 0 END)
        FROM wallet_ledger WHERE telegram_user_id = <player>;` == that player's total balance

### STEP 18 — Verify audit logs
- [ ] Admin → Audit log: one row per admin action (deposit.approve/reject,
      withdrawal.approve/mark_paid, admin.login, settings.update) with before/after

### STEP 19 — Final crypto / SMS / secret scan
- [ ] `grep -rniE "binance|bnb|blockchain|wagmi|viem|\bsms\b|auto.?credit" src/ supabase/functions/` → nothing (only `crypto.randomUUID`/`crypto.subtle`)
- [ ] `git grep` for tokens/keys → nothing new committed
- [ ] `curl "https://<project>.supabase.co/rest/v1/settings?select=*" -H "apikey: <anon>"` → **empty / 401** (settings not publicly readable)

### STEP 20 — GO LIVE
- [ ] Enable Supabase Point-in-Time Recovery / backups
- [ ] Real logo files in `public/` + rebuilt frontend deployed
- [ ] Announce the bot
- [ ] Watch Logs + pending deposits/withdrawals for the first day

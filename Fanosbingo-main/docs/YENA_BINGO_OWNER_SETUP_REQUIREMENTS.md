# የኛ bingo — owner setup requirements

**This document was produced by auditing the actual repository** (every
`import.meta.env` in `src/`, every `Deno.env.get` in `supabase/functions/`, every
`settings` key read by code, all migrations, storage, cron, CORS). Nothing here
is invented — if a value isn't listed, the code doesn't need it.

> Business model: **የኛ bingo · 600 cartelas (ETB 5 = 400, ETB 10 = 200) ·
> max 4 cartelas per player total · both rooms at once · 80% winner pool / 20%
> house · MANUAL TELEBIRR ONLY.** Zero crypto, zero automatic payments.

---

## 🔴 CRITICAL — do this first

**A real Telegram bot token is committed in git history**
(`supabase/migrations/20251213115718_add_settings_table.sql`, from the original
Fanos Bingo project). It is not reproduced here.

1. Open **@BotFather** → `/revoke` on that bot (or `/mybots` → the bot → *API
   Token* → *Revoke current token*). This **permanently invalidates** the leaked
   token.
2. Use the **new** token everywhere below.
3. Migration `20260906131400` blanks the seeded value and removes the public-read
   RLS policy on `settings`, so a fresh deploy won't re-leak it — but the old
   value stays in history, hence the revoke.

---

## A. VALUES YOU MUST PROVIDE

| # | Value | Secret? | Where to get it | Where it's used |
|---|---|---|---|---|
| A1 | **Telegram bot token** (the new one) | 🔒 yes | @BotFather → your bot → API Token | edge secret `TELEGRAM_BOT_TOKEN` (+ optional `settings.telegram_bot_token`). Verifies Mini App `initData`; sends bot messages/notifications |
| A2 | **Telegram bot username** (without `@`) | no | @BotFather → your bot | edge secret `TELEGRAM_BOT_USERNAME` (+ optional `settings.telegram_bot_username`). Builds referral links |
| A3 | **Deployed Mini App URL** (HTTPS) | no | your static host (Netlify/Vercel/Cloudflare Pages/Supabase) after first deploy | `settings.game_url` (+ edge secret `YENA_BINGO_APP_URL` fallback). The bot's "Play" button; also set as the Web App URL in @BotFather |
| A4 | **የኛ Telebirr account name** | no (shown to players) | your የኛ Telebirr account | `settings.TELEBIRR_ACCOUNT_NAME` |
| A5 | **የኛ Telebirr account / phone number** | no (shown to players) | your የኛ Telebirr account | `settings.TELEBIRR_ACCOUNT_NUMBER` |
| A6 | **Telebirr payment instructions** (Amharic and/or English) | no | you write these | `settings.TELEBIRR_INSTRUCTIONS` |
| A7 | **Owner admin username + password** (password ≥ 10 chars) | 🔒 password | you choose | created via `/admin` bootstrap → `admin_users` (bcrypt-hashed) |
| A8 | **Official የኛ logo files** | no | your designer | `public/logo.svg`, `logo.png`, `logo-mark.svg`, `favicon.svg`/`.png`, `icon-192.png`, `icon-512.png` — see `YENA_BINGO_LOGO_PLACEMENT.md` |

> **Telebirr:** you do NOT need a Telebirr API key, merchant API, secret, or
> webhook. The model is manual — the code only needs the receiving account
> details above so it can show them to players.

## B. VALUES CLAUDE / YOU GENERATE (random secrets)

| # | Value | How to generate | Where it goes |
|---|---|---|---|
| B1 | `ADMIN_KEY` | `openssl rand -hex 32` (or `python -c "import secrets;print(secrets.token_hex(32))"`) | Supabase edge secret. Break-glass owner login + bootstraps the first admin. Store it in a password manager; you can stop using it once real admin accounts exist |

There is **no** separate JWT secret, app secret, encryption key, or bot internal
secret to generate — the code doesn't use any. Player session tokens are HMACed
with `SUPABASE_SERVICE_ROLE_KEY` (already provided by Supabase); admin sessions
are random tokens in `admin_sessions`.

## C. VALUES ALREADY IN THE PROJECT (no action)

- All business numbers are **seeded by migrations** with the correct የኛ
  defaults and **invariant-checked at install** (`400+200=600`, `80+20=100`,
  `max=4`): `ETB5_ROOM_PRICE/CAPACITY`, `ETB10_ROOM_PRICE/CAPACITY`,
  `MAX_STANDARD_CARTELAS`, `MAX_CARTELAS_PER_PLAYER`, `WINNER_PERCENTAGE`,
  `HOUSE_PERCENTAGE`, `DEPOSIT_MIN/MAX_ETB`, `WITHDRAWAL_MIN/MAX_ETB`,
  `SIGNUP_BONUS_ETB`, `REFERRAL_BONUS_*`, `REFERRAL_MAX`. Tune later in the admin
  panel if you want; you don't have to touch them to go live.
- Placeholder logo SVGs (replace with A8).
- The `receipts` storage bucket is **created by migration** (`20260906130400`) —
  private, 10 MB cap, PNG/JPG/PDF only. You do **not** create it manually.

## D. VALUES SUPABASE PROVIDES

| Value | Public? | Where | Used by |
|---|---|---|---|
| `SUPABASE_URL` / project URL | public | Dashboard → Project Settings → API | frontend `VITE_SUPABASE_URL`; auto-injected into edge functions as `SUPABASE_URL` |
| `anon` key | public | same page | frontend `VITE_SUPABASE_ANON_KEY` |
| `service_role` key | 🔒 **NEVER in the browser** | same page | auto-injected into edge functions as `SUPABASE_SERVICE_ROLE_KEY`. Verified: **not referenced anywhere in `src/`** |
| database connection string | 🔒 | Dashboard → Database → Connection string | only for running `yena_bingo_verification.sql` with `psql` |

## E. VALUES TELEGRAM PROVIDES

Bot token (A1) and bot username (A2) — from @BotFather. Nothing else. The Mini
App gets the user identity from the signed `initData` string Telegram injects at
runtime (verified server-side in `player-session`).

## F. VALUES YOU CONFIGURE MANUALLY (in Supabase / BotFather, not code)

1. **Enable Postgres extensions** (Dashboard → Database → Extensions):
   `pg_cron` (number caller), `pgcrypto` (admin password hashing — the RBAC
   migration also does `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA
   extensions`, but pre-enabling avoids a permission error on some plans).
2. **Edge function secrets** (`supabase secrets set …`): `ADMIN_KEY`,
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `YENA_BINGO_APP_URL`.
3. **`settings` rows** (admin panel Settings, or SQL): `game_url`,
   `TELEBIRR_ACCOUNT_NAME`, `TELEBIRR_ACCOUNT_NUMBER`, `TELEBIRR_INSTRUCTIONS`
   (A4–A6), optionally `telegram_bot_token` / `telegram_bot_username` /
   `user_instructions`.
4. **@BotFather**: set the token; `/setdomain` / configure the Web App (Mini App)
   URL = A3; upload `icon-512.png`; then register the webhook + command list
   (admin panel Settings, or call the `setup-telegram-webhook` edge function with
   the `ADMIN_KEY`).
5. **Bootstrap the owner admin** at `https://<A3>/admin`.

## G. OPTIONAL VALUES

| Value | Default | Effect |
|---|---|---|
| `settings.user_instructions` | none | text shown by the bot `/instructions` command |
| `settings.support_contact` | none | (legacy; the Mini App Help screen uses a built-in string) |
| `SIGNUP_BONUS_ETB` | 10 | set `0` to disable the signup bonus |
| `REFERRAL_BONUS_REFERRER` / `REFERRAL_BONUS_NEW_USER` | 10 / 10 | set `0` to disable |
| `REFERRAL_MAX` | 20 | rewarded referrals per user |
| deposit/withdrawal min/max | 10/50000, 20/100000 | limits |
| `VITE_DEV_TELEGRAM_USER` + `ALLOW_UNVERIFIED_TELEGRAM` | unset | local testing without Telegram — **never in production** |

## H. PRODUCTION DEPLOYMENT REQUIREMENTS

- **Frontend:** static host with **SPA fallback** (all paths → `index.html`) so
  `/admin` works. Build: `npm ci && npm run typecheck && npm test && npm run build`
  → deploy `dist/`.
- **Backend:** one Supabase project. `supabase db push` (migrations) +
  `supabase functions deploy` (all 20 edge functions).
- **HTTPS everywhere** (Telegram requires it for Mini Apps).
- **Realtime**: enabled by default on Supabase; the app uses `postgres_changes`
  on `games` / `players`. No separate WebSocket server (there isn't one — see
  §"WebSocket" below).
- **Cron**: `pg_cron` job `call-bingo-numbers` (every 4 s) is created by
  migration; it runs a pure SQL function, no HTTP/keys needed.
- **Backups**: enable Supabase Point-in-Time Recovery (paid) or daily backups —
  this holds real money balances and the ledger.

## I. SECURITY REQUIREMENTS

| Item | Status in code |
|---|---|
| Service-role key never in the browser | ✅ verified — 0 references in `src/` |
| `settings` table not publicly readable | ✅ fixed (`20260906131400`) — was leaking `telegram_bot_token` |
| Leaked bot token | ⚠️ **you must `/revoke` it** (git history) |
| Telegram `initData` verified (HMAC) server-side | ✅ `player-session` + `_shared/telegram.ts` |
| Financial player endpoints require a signed player token | ✅ `submit-deposit`, `request-withdrawal`, `my-finance`, `cancel-request` |
| Admin RBAC (owner/finance/support/viewer), bcrypt, 12 h sessions | ✅ |
| `update-settings` owner-only + key allow-list + invariant re-check | ✅ fixed this pass |
| Receipts private; access via short-lived signed URL, owner-or-admin only | ✅ |
| Every balance change goes through the append-only ledger | ✅ verified — 0 direct mutations in live code |
| Deposit approve idempotent (no double credit) | ✅ unique ledger index + guard |
| Withdrawal hold prevents double-spend; `mark_paid` needs the Telebirr reference | ✅ |
| Winner payout idempotent; house exactly 20%; winners ≤ 80% pool | ✅ + integrity guard |
| `ADMIN_KEY` rotation | rotate after real admins exist; keep in a password manager |
| CORS = `*` on edge functions | acceptable for a Telegram Mini App (varying webview origins; all sensitive routes require a verified token/key). Optional hardening: pin to your Mini App origin — see `YENA_BINGO_PRODUCTION_SETUP.md` |

## J. FINAL GO-LIVE CHECKLIST

Follow **`YENA_BINGO_GO_LIVE_CHECKLIST.md`** (20 numbered steps with checkboxes).
Do not go live until `yena_bingo_verification.sql` prints
`ALL የኛ CHECKS PASSED` and the manual E2E in
`YENA_BINGO_FINAL_MIGRATION_REPORT.md` passes on staging.

---

## WebSocket (Part 20 answer)

There is **no standalone WebSocket server** and there never was one (the original
`instruction/read.md` described a `game-server-ws` function that does not exist in
the repo). "Live Bingo" = **Supabase Realtime** (`postgres_changes` subscriptions
on `games` / `players`) + short polling fallbacks. It needs **no** `WS_URL`, no
extra auth, no extra deployment — it works as soon as Realtime is on (default).
The database is always the source of truth for money, cartelas and results.

---

# 📋 OWNER INPUT REQUIRED — copy/paste and fill in

> Fill these in **locally / in Supabase / in BotFather** — do **not** paste
> secrets back into this file or any doc. Send back only the **non-secret** ones
> (A2, A3, A4, A5, A6) if you want me to wire them; set the secrets yourself with
> `supabase secrets set`.

```
# --- from @BotFather (SECRET — set with: supabase secrets set TELEGRAM_BOT_TOKEN=...) ---
TELEGRAM BOT TOKEN (new, after /revoke):        [ __________________________ ]

# --- from @BotFather (not secret) ---
TELEGRAM BOT USERNAME (without @):               [ __________________________ ]

# --- your deployed Mini App URL (not secret), e.g. https://yena_bingo.example ---
MINI APP URL:                                   [ __________________________ ]

# --- your የኛ Telebirr receiving account (shown to players) ---
TELEBIRR ACCOUNT NAME:                           [ __________________________ ]
TELEBIRR ACCOUNT NUMBER / PHONE:                 [ __________________________ ]
TELEBIRR INSTRUCTIONS (Amharic/English):         [ __________________________ ]

# --- you choose (password is SECRET — never write it in a doc) ---
OWNER ADMIN USERNAME:                            [ __________________________ ]
OWNER ADMIN PASSWORD (>= 10 chars):              [ set at /admin bootstrap ]

# --- generate yourself (SECRET — set with: supabase secrets set ADMIN_KEY=...) ---
ADMIN_KEY:   run  openssl rand -hex 32           [ __________________________ ]

# --- from Supabase dashboard (URL + anon are public; service_role is SECRET) ---
SUPABASE PROJECT URL:                            [ __________________________ ]
SUPABASE ANON KEY:                               [ __________________________ ]
SUPABASE DB CONNECTION STRING (for psql tests):  [ keep private ]

# --- logo files: drop into public/ (see YENA_BINGO_LOGO_PLACEMENT.md) ---
LOGO FILES PROVIDED?                             [ yes / no ]
```

## BLOCKERS (cannot go live until resolved)

1. **Revoke the leaked bot token** (§CRITICAL).
2. Provide a **Telegram bot token** + **username** (A1, A2).
3. Provide a **Supabase project** (URL + keys) and run `supabase db push` +
   `functions deploy`.
4. Provide the **real Telebirr account** details (A4–A6).
5. Deploy the frontend and set its URL (A3).
6. Bootstrap the **owner admin** (A7).
7. Provide the **real logo** (A8) — cosmetic, but it's "your" product.
8. Run `yena_bingo_verification.sql` on staging → `ALL የኛ CHECKS PASSED`.
9. Run the manual E2E on staging.

## EXACT NEXT ACTION

1. `/revoke` the leaked bot token in @BotFather and create a fresh one.
2. Create a Supabase project.
3. Fill the copy/paste block above.
4. Then follow `YENA_BINGO_GO_LIVE_CHECKLIST.md` step by step.

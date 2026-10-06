# የኛ bingo — Telegram setup

## What the code actually needs from Telegram

Audited: `src/lib/session.tsx` (`@twa-dev/sdk`, reads `WebApp.initData`),
`supabase/functions/player-session` + `_shared/telegram.ts` (verifies `initData`),
`supabase/functions/telegram-bot-webhook`, `supabase/functions/telegram-notify`,
`supabase/functions/setup-telegram-webhook`.

| Need | Value | Notes |
|---|---|---|
| Bot API token | `TELEGRAM_BOT_TOKEN` (edge secret) and/or `settings.telegram_bot_token` | verifies Mini App `initData`, sends messages/notifications |
| Bot username | `TELEGRAM_BOT_USERNAME` (edge secret) and/or `settings.telegram_bot_username` | builds `https://t.me/<bot>?start=<code>` referral links |
| Mini App URL | `settings.game_url` (fallback `YENA_BINGO_APP_URL` secret) | the "Play" button `web_app.url`; must be HTTPS |

**No** chat IDs, group IDs, channel IDs, or admin Telegram IDs are used anywhere.
**No** Telegram payments / Stars / provider tokens. Notifications go to the
player's own chat id (their Telegram user id), which the bot already has.

## Create the bot

1. Telegram → **@BotFather** → `/newbot` → pick a name and a `@username`.
   BotFather returns the **token**. (If you're reusing the existing bot, first
   `/revoke` — see the CRITICAL note in `YENA_BINGO_OWNER_SETUP_REQUIREMENTS.md`.)
2. `/setname`, `/setdescription`, `/setabouttext`, `/setuserpic` (upload
   `public/icon-512.png` once you have the real logo).
3. Create the Mini App: `/newapp` → select the bot → title "የኛ bingo" →
   short description → photo → **Web App URL = your deployed frontend URL** →
   short name (e.g. `play`). Also run `/setdomain` with your frontend domain.

## Wire it to the backend

```bash
supabase secrets set \
  TELEGRAM_BOT_TOKEN='<token>' \
  TELEGRAM_BOT_USERNAME='<username-without-@>' \
  YENA_BINGO_APP_URL='https://<your-mini-app-url>'
```

Then set `settings.game_url` (admin panel Settings, or SQL):

```sql
UPDATE settings SET value = 'https://<your-mini-app-url>' WHERE id = 'game_url';
```

## Register the webhook + commands

Either: admin panel → Settings → "Set up webhook" (uses the `ADMIN_KEY`),
or:

```bash
curl -X POST "https://<project>.supabase.co/functions/v1/setup-telegram-webhook" \
  -H "Authorization: Bearer <anon-key>" -H "Content-Type: application/json" \
  -d '{"adminKey":"<ADMIN_KEY>"}'
```

This calls Telegram `setWebhook` → `…/functions/v1/telegram-bot-webhook` and
`setMyCommands` (`/play /balance /deposit /withdraw /invite /instructions`).

Verify: `curl "https://api.telegram.org/bot<token>/getWebhookInfo"` — `url`
should be your webhook and `pending_update_count` should drain to 0.

## How identity works (no passwords for players)

1. Telegram injects a signed `initData` string into the Mini App WebView.
2. `session.tsx` POSTs it to `player-session`.
3. `_shared/telegram.ts` recomputes the HMAC (`HMAC_SHA256(secret_key,
   data_check_string)` where `secret_key = HMAC_SHA256("WebAppData", bot_token)`)
   and rejects anything that doesn't match or is older than 24 h.
4. On success it upserts `telegram_users` (via `eds_ensure_player`) and issues a
   **12 h player token** (HMAC of `user_id.expiry`, keyed by the service-role
   key). The financial endpoints require that token.

So the bot token is what makes identity verification possible — keep it secret,
and if it leaks, revoke it (that invalidates all past `initData` too).

## Bot messages sent by the system

- `/start` → welcome + Play button (+ signup bonus, ledger-backed)
- `/balance` → wallet (deposited / won / available / pending)
- `/deposit` → Telebirr account + "do it in the Mini App"
- `/withdraw` → "winnings only, do it in the Mini App"
- `/invite` → referral link
- `/instructions` → `settings.user_instructions`
- `telegram-notify` (called by the backend) → game-start / winner / deposit /
  withdrawal notifications to the player's chat

`/transfer` and the old SMS-paste deposit path are **removed**.

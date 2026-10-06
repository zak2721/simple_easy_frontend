# Deploying የኛ bingo — VPS with WHM/cPanel, single shared IP

Your setup: root SSH on a VPS, WHM/cPanel already running other sites on the
server's one IP. Apache stays the public entrypoint on 80/443 for everything,
including this app; it reverse-proxies this app's domain to Docker
containers that only listen on `127.0.0.1`. Postgres/Redis/backend/frontend
never touch cPanel directly — they're the same Docker stack as any other
deployment of this project, just fronted by Apache instead of the built-in
Caddy container.

Replace `yena-bingo.com` and `91.204.209.24` below with your real values
throughout. Run steps top to bottom; each code block is meant to be copied
as-is.

---

### 1. SSH into the server

```bash
ssh root@91.204.209.24
```

### 2. Update the system

```bash
apt update && apt upgrade -y
```

(Use `yum update -y` or `dnf update -y` instead if this is CentOS/AlmaLinux.)

### 3. Create a non-root deploy user (skip if you already have one)

```bash
adduser deploy
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

### 4. Confirm the firewall allows 22/80/443

cPanel servers run **ConfigServer Firewall (CSF)**, not `ufw` — don't enable
`ufw` alongside it. Check:

```bash
grep -E "^TCP_IN" /etc/csf/csf.conf
```

You should see `22,80,443` (and others) in that list — cPanel needs them
already, so this is normally already fine. If 80/443 are missing, add them
in **WHM → Security Center → ConfigServer Security & Firewall → Firewall
Configuration → TCP_IN**, then Save.

### 5. Point DNS at the server — already done

Your cPanel screenshot shows `yena-bingo.com` as the account's **Primary
Domain** with **SSL: Active** already. That only happens once DNS resolves
to this server, so this step is already satisfied — just confirm it:

```bash
dig yena-bingo.com +short
```

It should print `91.204.209.24`. If it doesn't, stop here and fix DNS
before continuing (WHM → DNS Functions → Edit DNS Zone).

### 6. Create the domain in cPanel — already done

`yena-bingo.com` is already the account's primary domain (visible in your
screenshot), so there's nothing to create here. Skip to step 7.

### 7. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy
```

Log out and back in as `deploy` so the group change applies:

```bash
exit
```
```bash
ssh deploy@91.204.209.24
docker --version
docker compose version
```

### 8. Allow CSF to work with Docker

```bash
grep -i "^DOCKER" /etc/csf/csf.conf
```

If a `DOCKER` setting exists, turn it on:

```bash
sudo sed -i 's/^DOCKER = "0"/DOCKER = "1"/' /etc/csf/csf.conf
sudo csf -r
```

(If that line isn't present at all, your CSF version predates this option —
skip it. Since this app's containers will only bind `127.0.0.1` in this
setup, not the public IP, this rarely causes problems either way.)

### 9. Get the code onto the server

```bash
cd ~
git clone <YOUR_REPO_URL> yena-bingo
cd yena-bingo
```

(No git remote yet? From your **local machine**, run
`scp -r "./Fanosbingo-main" deploy@91.204.209.24:~/yena-bingo` instead, then
`cd ~/yena-bingo` on the server.)

### 10. Copy your production secrets up

From your **local machine** (not the server):

```bash
scp .env.production deploy@91.204.209.24:~/yena-bingo/.env.production
```

### 11. Lock down and edit the secrets file

Back on the **server**:

```bash
cd ~/yena-bingo
chmod 600 .env.production
nano .env.production
```

Set this line, then save (`Ctrl+O`, `Enter`, `Ctrl+X`):

```
DOMAIN=yena-bingo.com
```

**Also confirm `PLATFORM_ENCRYPTION_KEY` is set** (it should already have a
generated value in this file) — this build supports multiple bingo operators
(white-label), and every operator's Telegram bot token (other than the
original/default operator, which still uses `TELEGRAM_BOT_TOKEN` below) is
stored encrypted with this key. If it's ever blank, generate one:

```bash
openssl rand -base64 32
```

Paste the output as the value:

```
PLATFORM_ENCRYPTION_KEY=<the-output-above>
```

**This key cannot be rotated casually** — losing it, or changing it after
operators have connected bots, makes every one of their stored tokens
permanently unreadable (each operator would have to reconnect their bot from
their admin panel). Back it up somewhere separate from the server itself
(a password manager, not just this file) — see the backup section below.

Leave everything else in that file as-is.

### 12. Start the stack

This repo has a ready-made compose file for exactly this setup —
`docker-compose.cpanel.yml` — which binds the backend to
`127.0.0.1:3000` and the frontend to `127.0.0.1:8080`, with no public ports
of its own:

```bash
docker compose --env-file .env.production -f docker-compose.cpanel.yml up -d --build
```

### 13. Watch it come up

```bash
docker compose -f docker-compose.cpanel.yml logs -f
```

Wait for `Nest application successfully started` from the backend, then
`Ctrl+C` to stop following logs (the containers keep running).

### 14. Add the Apache reverse proxy

In **WHM → Service Configuration → Apache Configuration → Include
Editor**, choose "Pre VirtualHost Include" → select the domain
`yena-bingo.com`, and paste:

```apache
ProxyPreserveHost On
ProxyPass /api http://127.0.0.1:3000/api
ProxyPassReverse /api http://127.0.0.1:3000/api
ProxyPass / http://127.0.0.1:8080/
ProxyPassReverse / http://127.0.0.1:8080/
```

Click **Update**. WHM rebuilds and restarts Apache automatically.

### 15. Issue the SSL certificate — already done

Your screenshot already shows `SSL Certificate: Active` for `yena-bingo.com`,
so nothing to do here. (If you ever need to re-issue it:
**WHM → SSL/TLS → Manage AutoSSL → Run AutoSSL**, select the user `yenabing`.)

### 16. Verify

```bash
curl -I https://yena-bingo.com/api/health
curl -I https://yena-bingo.com/
```

Both should return `200`.

### 17. Create the first (Super Admin) account

```bash
curl -X POST https://yena-bingo.com/api/auth/admin/bootstrap \
  -H "Content-Type: application/json" \
  -d '{
    "username": "your-admin-username",
    "password": "a-strong-password-at-least-10-chars",
    "fullName": "Your Name",
    "adminKey": "<the ADMIN_KEY value from .env.production>"
  }'
```

This only ever works once. Log in at `https://yena-bingo.com/admin`.

### 18. Point the Telegram bot at production

This step is for the **default/original operator** only (the one whose bot
token lives in `.env.production` as `TELEGRAM_BOT_TOKEN`). In Telegram,
message **@BotFather** and set the Mini App URL to `https://yena-bingo.com`.

Then register the webhook (replace `<ADMIN_JWT>` with a bearer token from
logging into the admin panel):

```bash
curl -X POST https://yena-bingo.com/api/admin/telegram/setup-webhook \
  -H "Authorization: Bearer <ADMIN_JWT>"
```

## Onboard additional operators (white-label / multi-operator)

This build supports more than one bingo operator behind the same domain and
deployment — each with their own branding, cartela rooms, staff, and their
own Telegram bot. Nothing below needs SSH or a server restart; it's all done
through the admin panel by whoever holds the Super Admin login.

1. **Create the operator.** Super Admin → **Operators → + New operator** (or
   `POST /api/platform/operators`, see the API docs) — sets its slug, display
   name, initial rooms, and its owner's admin login.
2. **The operator connects their own bot.** The new owner logs into the same
   admin panel at `https://yena-bingo.com/admin` and, under **My Bot**, pastes
   their own @BotFather token. The backend verifies it with Telegram, stores
   it encrypted (`PLATFORM_ENCRYPTION_KEY` — step 11), and registers that
   operator's own webhook automatically. Nobody needs server access for this.
3. **The operator's Mini App URL** is `https://yena-bingo.com/o/<slug>` —
   the same Apache config from step 14 already proxies all paths to the
   frontend, so this works immediately with no per-operator Apache edit.
   The operator sets this as their bot's Mini App URL in @BotFather.
4. **Player wallets, rooms, and staff are all separate per operator** — a
   player who plays at two different operators' bots has two unrelated
   accounts and balances by design.

Suspending, disabling, or reactivating an operator, resetting an owner's
password, or approving their pending branding/inventory changes are all
Super Admin actions in the admin panel (**Operators → Manage**, and
**Approvals Queue**) — again, no server access needed.

---

## Day-to-day commands

```bash
# view logs
docker compose -f docker-compose.cpanel.yml logs -f
docker compose -f docker-compose.cpanel.yml logs -f backend

# restart one service
docker compose -f docker-compose.cpanel.yml restart backend

# what's running
docker compose -f docker-compose.cpanel.yml ps
```

## Deploying an update later

```bash
cd ~/yena-bingo
git pull
docker compose --env-file .env.production -f docker-compose.cpanel.yml up -d --build
```

## Backup the database

```bash
docker compose -f docker-compose.cpanel.yml exec postgres \
  pg_dump -U postgres yena_bingo | gzip > backup-$(date +%F).sql.gz
```

Copy the file off the server (from your **local machine**):

```bash
scp deploy@91.204.209.24:~/yena-bingo/backup-*.sql.gz ./local-backups/
```

Put the `pg_dump` command in `deploy`'s crontab (`crontab -e`) to run
daily. Full restore instructions:
[`YENA_BINGO_BACKUP_AND_RESTORE.md`](YENA_BINGO_BACKUP_AND_RESTORE.md).

**Back up `PLATFORM_ENCRYPTION_KEY` separately from the database.** A
database backup alone is not enough to restore a multi-operator deployment:
every operator's bot token in that backup is encrypted with the key that was
active in `.env.production` at backup time. Restoring the database on a
server with a *different* `PLATFORM_ENCRYPTION_KEY` (a fresh install, a typo
when recreating `.env.production`, etc.) leaves every non-default operator's
bot connection broken — each one would need to reconnect from their admin
panel. Keep the key in a password manager or secrets vault, not only inside
`.env.production` on the server itself.

---

## If something's wrong

| Symptom | Check |
|---|---|
| `dig` doesn't return your server's IP | Unexpected, since SSL is already active — double-check you're not confusing a `www.` alias with the bare domain |
| AutoSSL fails on re-run | Domain's DNS must resolve to this server first (step 5) |
| 502/504 from the domain | `docker compose -f docker-compose.cpanel.yml ps` — a container isn't up; then `curl http://127.0.0.1:8080` and `curl http://127.0.0.1:3000/api` directly on the server |
| Backend container keeps restarting | `docker compose -f docker-compose.cpanel.yml logs backend` — almost always one missing/wrong value in `.env.production` |
| Telegram Mini App won't open | It requires real HTTPS — verify step 16 actually returns `200`, not a redirect loop or cert error |
| An operator's bot stops responding (only after restoring a backup or redeploying) | Check `PLATFORM_ENCRYPTION_KEY` in `.env.production` matches what was active when that operator connected their bot — see the backup section. If it doesn't, the operator reconnects the bot from their own admin panel (**My Bot**); no data is lost, only the stored token |
| `PUT /operator/bot` (an operator connecting their bot) returns "PLATFORM_ENCRYPTION_KEY is not configured" | It's missing or blank in `.env.production` — set it per step 11 and restart the backend container |

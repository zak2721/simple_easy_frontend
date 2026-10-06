# Deploying የኛ bingo to a Hahu Cloud VPS (end to end)

This repo already ships a complete production stack — `docker-compose.prod.yml`
+ `Caddyfile` + `.env.production` — so deployment is: get a server, install
Docker on it, copy the repo, fill in one env var (`DOMAIN`), and start it.
Caddy handles HTTPS automatically. This guide walks that whole path.

Everything below assumes Hahu Cloud gives you a plain Linux VPS with root SSH
access and a public IPv4 address (the normal shape of an IaaS VM, regardless
of provider) — **Ubuntu 22.04 or 24.04** if you get a choice of image.

> **Ignore `docs/YENA_BINGO_DEPLOYMENT.md`, `..._PRODUCTION_SETUP.md`, and
> `..._GO_LIVE_CHECKLIST.md`** — those describe an earlier Supabase
> edge-functions architecture this project has since migrated away from (see
> `PRODUCTION_MIGRATION_REPORT.md`). The current backend is the NestJS +
> Prisma app under `backend/`, deployed via `docker-compose.prod.yml`, which
> is what this guide covers.

---

## 0. Before you start

You need:
- A **domain name** you control (e.g. `bingo.yourdomain.com`), with access to
  its DNS records. Telegram Mini Apps require HTTPS, and Caddy needs a real
  domain to issue a Let's Encrypt certificate — a bare IP address will not work.
- The server's **public IP** and **root/SSH access** (Hahu Cloud gives you
  this after the VM is provisioned — either a root password or an SSH key you
  uploaded when creating the instance).
- Your Telegram bot token (already in this repo's `backend/.env`, and already
  copied into `.env.production`).

---

## 1. Provision the server on Hahu Cloud

1. In the Hahu Cloud console, create a new VM/instance:
   - Image: **Ubuntu 22.04 LTS** (or 24.04).
   - Size: 2 vCPU / 2–4 GB RAM is comfortable for Postgres + Redis + backend +
     frontend + Caddy on one box for a launch-stage deployment. Scale up later
     if needed.
   - Attach/create an SSH key if the console offers it (preferred over a
     password).
2. Note the **public IP** it gives you.
3. Make sure inbound ports **22 (SSH), 80 (HTTP), 443 (HTTPS)** are allowed in
   whatever firewall/security-group panel Hahu Cloud exposes for the instance.

---

## 2. First login and basic hardening

From your own machine:

```bash
ssh root@<SERVER_IP>
```

Once in:

```bash
# Update the system
apt update && apt upgrade -y

# Create a non-root user with sudo, so you stop working as root day to day
adduser deploy
usermod -aG sudo deploy

# Copy your SSH key to the new user (skip if you'll keep using root+password)
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy

# Basic firewall: allow only SSH/HTTP/HTTPS
apt install -y ufw
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable

# Optional but recommended: auto-ban repeated failed SSH logins
apt install -y fail2ban
```

From here on, log in as `deploy` (`ssh deploy@<SERVER_IP>`) instead of root.

---

## 3. Point your domain at the server

In your DNS provider's dashboard, create:

```
Type: A
Name: bingo            (or whatever subdomain you want — matches DOMAIN below)
Value: <SERVER_IP>
TTL: default
```

Wait for it to propagate (`dig bingo.yourdomain.com` from your own machine
should return the server's IP). **This must resolve before you start Caddy**,
or the automatic Let's Encrypt certificate request will fail.

---

## 4. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# log out and back in for the group change to apply
exit
ssh deploy@<SERVER_IP>
docker --version
docker compose version
```

---

## 5. Get the code onto the server

Either clone from your git remote (recommended, so future updates are a
`git pull`) or `scp` the folder up.

```bash
# Option A — git (replace with your actual repo URL)
git clone <YOUR_REPO_URL> yena-bingo
cd yena-bingo

# Option B — copy from your machine (run this from your LOCAL machine, not the server)
# scp -r "./Fanosbingo-main" deploy@<SERVER_IP>:~/yena-bingo
```

---

## 6. Configure production secrets

This repo already has `.env.production` with generated secrets
(`JWT_ACCESS_SECRET`, `ADMIN_KEY`, `TELEGRAM_WEBHOOK_SECRET`,
`POSTGRES_PASSWORD`, `APP_RUNTIME_PASSWORD`) and your Telegram bot token
pre-filled. `APP_RUNTIME_PASSWORD` is what lets the backend connect as the
restricted, Row-Level-Security-scoped `app_runtime` Postgres role instead of
the superuser — the entrypoint sets it on the role automatically on first
boot, you don't do anything extra for it. **Copy that file to the server**
(it's git-ignored on purpose, so `git clone` alone won't bring it) and set the
one thing it's still missing — your real domain:

```bash
# from your LOCAL machine, copy the file up (don't commit it, don't paste it in chat)
scp .env.production deploy@<SERVER_IP>:~/yena-bingo/.env.production
```

Then on the server:

```bash
cd ~/yena-bingo
nano .env.production
```

Set:
```
DOMAIN=bingo.yourdomain.com
```

Everything else in that file (`CORS_ALLOWED_ORIGINS`, `YENA_BINGO_APP_URL`,
`DATABASE_URL`, `VITE_API_BASE_URL`) is derived automatically from `DOMAIN` by
`docker-compose.prod.yml` — you don't need to touch them.

> Treat `.env.production` like a password file: it contains real secrets.
> Never commit it, never paste it into chat/Slack, and restrict its
> permissions: `chmod 600 .env.production`.

---

## 7. Start the stack

```bash
cd ~/yena-bingo
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

This builds and starts, in order: Postgres, Redis, the backend (which runs
`prisma migrate deploy` + seeds default settings on boot — see
`backend/docker-entrypoint.sh`), the frontend (built as static files served by
nginx), and Caddy (which requests the TLS certificate for `DOMAIN` and starts
proxying `/api/*` to the backend and everything else to the frontend).

Watch it come up:

```bash
docker compose -f docker-compose.prod.yml logs -f
```

Look for `Nest application successfully started` from the backend and no
certificate errors from `caddy`. Once it settles:

```bash
curl -I https://bingo.yourdomain.com/api/health
curl -I https://bingo.yourdomain.com/
```

Both should return `200`.

---

## 8. Create your first (Super Admin) account

The admin panel has no accounts yet — bootstrap creates the one-and-only
Super Admin, gated by `ADMIN_KEY` from `.env.production`:

```bash
curl -X POST https://bingo.yourdomain.com/api/auth/admin/bootstrap \
  -H "Content-Type: application/json" \
  -d '{
    "username": "your-admin-username",
    "password": "a-strong-password-at-least-10-chars",
    "fullName": "Your Name",
    "adminKey": "<the ADMIN_KEY value from .env.production>"
  }'
```

This can only ever succeed once — a second call returns "Owner account
already exists". Log in at `https://bingo.yourdomain.com/admin` with the
username/password you just set.

---

## 9. Point the Telegram bot at production

1. Open the Mini App / bot settings via **@BotFather**, set the Mini App URL
   to `https://bingo.yourdomain.com`.
2. Register the webhook (there's an admin endpoint for this already mapped —
   `POST /api/admin/telegram/setup-webhook` — call it once, authenticated as
   the admin you just created, from the admin panel or with a bearer token).

---

## Day-to-day management

All commands below run from `~/yena-bingo` on the server.

**View logs:**
```bash
docker compose -f docker-compose.prod.yml logs -f            # everything
docker compose -f docker-compose.prod.yml logs -f backend     # one service
```

**Restart a service:**
```bash
docker compose -f docker-compose.prod.yml restart backend
```

**Deploy an update** (after pushing new code to your git remote):
```bash
cd ~/yena-bingo
git pull
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```
This rebuilds only the images whose source changed, runs any new Prisma
migrations automatically on backend start, and does a rolling restart of the
affected containers.

**Check what's running / resource use:**
```bash
docker compose -f docker-compose.prod.yml ps
docker stats --no-stream
```

**Stop everything:**
```bash
docker compose -f docker-compose.prod.yml down
```
(Data survives — it's in the `postgres_data`, `receipts_data`,
`public_storage_data` named volumes. `down -v` would delete them — never run
that in production without a backup.)

---

## Backups

Don't hand-roll this — the repo already ships a tested backup/restore
pipeline in `scripts/backup.sh`, `scripts/restore.sh`, and `scripts/backup.cron`
(full detail in `docs/YENA_BINGO_BACKUP_AND_RESTORE.md`). It captures the
Postgres database, uploaded receipt files, `.env`/compose/Caddy config, and
Caddy's TLS state in one encrypted archive.

**One-off backup, run from `~/yena-bingo`:**

```bash
# Generate a GPG key first if you don't have one (once, ever):
#   gpg --full-generate-key
BACKUP_GPG_RECIPIENT=you@yourdomain.com ./scripts/backup.sh
```

Without `BACKUP_GPG_RECIPIENT` set, it still runs but warns loudly and writes
the archive **unencrypted** — the archive contains real secrets and real
user financial data, so set it.

**Automate it** — install the schedule in `scripts/backup.cron` (daily 03:15
server time, chosen to sit outside Ethiopia-facing peak play hours):

```bash
crontab -e
# paste the line from scripts/backup.cron, adjusting the repo path to
# /home/deploy/yena-bingo and the email to your real GPG recipient
```

**Copy archives off the server** — a backup that lives only on the machine
it protects doesn't survive that machine being lost. Add an `rsync`/`restic`/
S3 sync as the last line of the cron job once you've picked a destination;
`backup.sh` deliberately doesn't choose one for you.

**Restore** (destructive — overwrites the current database):

```bash
./scripts/restore.sh backups/yena-bingo-backup-<timestamp>.tar.gz.gpg --yes
```

**Run the restore drill now, not during an incident** — spin up a throwaway
Postgres, restore into it, and diff a few known values (e.g. a player's
wallet balance) against production. `docs/YENA_BINGO_BACKUP_AND_RESTORE.md`
has the full drill procedure; this exact mechanism was already dry-run once
against real dev data with an exact match.

---

## Troubleshooting

- **Caddy won't get a certificate** — DNS for `DOMAIN` doesn't point at this
  server yet, or ports 80/443 are blocked by a firewall/security group.
  `docker compose logs caddy` shows the exact ACME error.
- **Backend keeps restarting** — `docker compose logs backend`; almost always
  a missing/wrong required env var (`docker-compose.prod.yml` fails fast with
  a clear `must be set` error for anything missing in `.env.production`).
- **502 from the domain** — backend or frontend container isn't healthy yet;
  check `docker compose ps` for unhealthy/restarting containers.
- **Telegram Mini App won't open** — it silently requires HTTPS; if you're
  testing via the raw IP or HTTP, it will fail even if the API itself works.

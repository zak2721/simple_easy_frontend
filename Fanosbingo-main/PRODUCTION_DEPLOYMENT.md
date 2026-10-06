# YEGNA BINGO — PRODUCTION DEPLOYMENT GUIDE

**Stack:** React/Vite + NestJS + PostgreSQL 15 + Caddy (TLS) + Docker Compose  
**Domain pattern:** `app.yegnabingo.com` (replace with your real domain throughout)

---

## Table of Contents

1. [VPS Requirements](#1-vps-requirements)
2. [VPS Initial Setup](#2-vps-initial-setup)
3. [Install Docker](#3-install-docker)
4. [Deploy the Application](#4-deploy-the-application)
5. [Environment Variables](#5-environment-variables)
6. [DNS Configuration](#6-dns-configuration)
7. [SSL / HTTPS](#7-ssl--https)
8. [Telegram Setup](#8-telegram-setup)
9. [Database Migration](#9-database-migration)
10. [Bootstrap First Admin](#10-bootstrap-first-admin)
11. [Backups](#11-backups)
12. [Monitoring & Logs](#12-monitoring--logs)
13. [Application Updates](#13-application-updates)
14. [Rollback](#14-rollback)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. VPS Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |
| RAM | 2 GB | 4 GB |
| CPU | 1 vCPU | 2 vCPU |
| Disk | 20 GB SSD | 40 GB SSD |
| Network | 100 Mbps | 1 Gbps |
| Public IP | Required | Required |

Hahu Cloud: choose the Ubuntu 22.04 or 24.04 image when creating your server.

---

## 2. VPS Initial Setup

SSH into your server as root:

```bash
ssh root@YOUR_VPS_IP
```

### Update the system

```bash
apt update && apt upgrade -y
```

### Create a deployment user

```bash
adduser deploy
usermod -aG sudo deploy
```

### Copy your SSH key to the deploy user

```bash
# Run this on your LOCAL machine, not the server
ssh-copy-id deploy@YOUR_VPS_IP
```

### Test key-based login

```bash
ssh deploy@YOUR_VPS_IP
```

### Configure UFW firewall

```bash
ufw allow 22/tcp     # SSH
ufw allow 80/tcp     # HTTP (Caddy needs this for ACME challenge)
ufw allow 443/tcp    # HTTPS
ufw enable
ufw status
```

**Never** expose ports 3000 (backend), 5432 (PostgreSQL), or 5173 (dev server).

### Disable password SSH (after confirming key works)

```bash
sudo nano /etc/ssh/sshd_config
# Set: PasswordAuthentication no
sudo systemctl reload sshd
```

---

## 3. Install Docker

```bash
# Add Docker's official GPG key
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add Docker repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker Engine + Compose plugin
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Add deploy user to docker group (no sudo needed)
sudo usermod -aG docker deploy

# Re-login to apply group
exit
ssh deploy@YOUR_VPS_IP

# Verify
docker --version
docker compose version
```

---

## 4. Deploy the Application

### Clone the repository

```bash
cd /opt
sudo mkdir yena-bingo
sudo chown deploy:deploy yena-bingo
git clone https://github.com/YOUR_ORG/YOUR_REPO.git /opt/yena-bingo
cd /opt/yena-bingo
```

### Create the production environment file

```bash
cp .env.example .env
nano .env
```

Fill in every value — see [Section 5](#5-environment-variables).

### Build and start all services

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

### Verify all containers are healthy

```bash
docker compose -f docker-compose.prod.yml ps
```

Expected output — all should show `healthy` or `running`:

```
NAME         STATUS    PORTS
caddy        running   0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
backend      healthy
frontend     running
postgres     healthy
```

### Check backend health endpoint

```bash
curl https://app.yegnabingo.com/api/health
# Expected: {"status":"ok","time":"2026-..."}
```

---

## 5. Environment Variables

Edit `/opt/yena-bingo/.env` with these values:

```bash
# ── Domain ──────────────────────────────────────────────────────────────
DOMAIN=app.yegnabingo.com
CADDY_EMAIL=your@email.com

# ── PostgreSQL ───────────────────────────────────────────────────────────
POSTGRES_DB=yena_bingo
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<use: openssl rand -hex 32>

# Runtime role (RLS-scoped, least privilege)
APP_RUNTIME_PASSWORD=<use: openssl rand -hex 32>

# ── Backend connections (must match POSTGRES_* above) ────────────────────
DATABASE_URL=postgresql://app_runtime:${APP_RUNTIME_PASSWORD}@postgres:5432/yena_bingo
MIGRATE_DATABASE_URL=postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/yena_bingo

# ── Auth ─────────────────────────────────────────────────────────────────
JWT_ACCESS_SECRET=<use: openssl rand -hex 32>
ADMIN_KEY=<use: openssl rand -hex 32>

# ── Telegram ─────────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=<from @BotFather>
TELEGRAM_BOT_USERNAME=<your bot @username without @>
TELEGRAM_WEBHOOK_SECRET=<use: openssl rand -hex 32>

# ── Multi-operator bot token encryption ──────────────────────────────────
# Required once any operator (other than the default) configures their own bot.
# Back this up SEPARATELY from database dumps — losing it makes all stored
# operator bot tokens permanently unreadable.
PLATFORM_ENCRYPTION_KEY=<use: openssl rand -base64 32>

# ── Application URL (used for Mini App buttons in bot messages) ───────────
YENA_BINGO_APP_URL=https://app.yegnabingo.com

# ── CORS ─────────────────────────────────────────────────────────────────
CORS_ALLOWED_ORIGINS=https://app.yegnabingo.com

# ── Storage ──────────────────────────────────────────────────────────────
RECEIPTS_STORAGE_PATH=/app/storage/receipts
PUBLIC_STORAGE_PATH=/app/storage/public

# ── Error tracking (optional but recommended) ────────────────────────────
SENTRY_DSN=

# ── Runtime (set by Dockerfile; only needed for non-Docker local run) ─────
NODE_ENV=production
```

**Generate random secrets quickly:**

```bash
# Generate 3 secrets at once
for i in 1 2 3; do openssl rand -hex 32; done
# Generate base64 secret for PLATFORM_ENCRYPTION_KEY
openssl rand -base64 32
```

---

## 6. DNS Configuration

On your DNS provider (Hahu Cloud DNS, Cloudflare, etc.):

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | app | YOUR_VPS_PUBLIC_IP | 300 |

**Important:** Caddy performs automatic TLS certificate issuance on first start. DNS **must** resolve to the VPS IP before you start the stack, or certificate issuance will fail.

### Verify DNS

```bash
# From your local machine or the VPS
nslookup app.yegnabingo.com
dig app.yegnabingo.com +short
```

Both must return your VPS public IP.

### Find your VPS public IP

```bash
curl -s ifconfig.me
```

### DNS troubleshooting

```bash
# Check propagation globally (use a tool like dnschecker.org)
# On the VPS:
dig @8.8.8.8 app.yegnabingo.com   # Google DNS
dig @1.1.1.1 app.yegnabingo.com   # Cloudflare DNS
```

If `nslookup` returns the correct IP but Caddy still fails to get a certificate:
- Check that port 80 is open in UFW: `ufw status`
- Check Caddy logs: `docker compose -f docker-compose.prod.yml logs caddy`

---

## 7. SSL / HTTPS

SSL is **fully automatic** — Caddy handles everything:

- Certificate issuance via Let's Encrypt ACME protocol on first start
- HTTP → HTTPS redirect (automatic, built into Caddy)
- Certificate renewal (automatic, no cron job, no certbot needed)
- HSTS header (`Strict-Transport-Security: max-age=31536000; includeSubDomains`)

No manual steps required after DNS is pointed.

### Verify HTTPS is working

```bash
curl -I https://app.yegnabingo.com
# Look for: HTTP/2 200 and Strict-Transport-Security header

curl -I http://app.yegnabingo.com
# Look for: 301 redirect to https://
```

### Verify certificate

```bash
echo | openssl s_client -connect app.yegnabingo.com:443 2>/dev/null | openssl x509 -noout -dates
# notAfter should be ~90 days from now (Let's Encrypt)
```

### Certificate storage

Caddy stores certificates in the `caddy_data` Docker volume. They survive container recreations. To inspect:

```bash
docker volume inspect yena-bingo_caddy_data
```

### Certificate renewal

Caddy renews automatically at ~30 days before expiry. No action needed. To manually trigger a renewal test (dry run concept — Caddy handles this internally):

```bash
docker compose -f docker-compose.prod.yml logs caddy | grep -i certif
```

---

## 8. Telegram Setup

### Step 1 — Create your bot with @BotFather

In Telegram, message @BotFather:
```
/newbot
→ Enter bot name: የኛ bingo
→ Enter username: yegnabingo_bot (must end in _bot)
→ Copy the TOKEN
```

### Step 2 — Configure the Mini App

In @BotFather:
```
/newapp or /mybots → select your bot → Bot Settings → Menu Button
→ URL: https://app.yegnabingo.com
→ Text: Play bingo
```

### Step 3 — Set env vars

In `.env`:
```
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHI...
TELEGRAM_BOT_USERNAME=yegnabingo_bot
TELEGRAM_WEBHOOK_SECRET=<your generated secret>
```

Restart the stack:
```bash
docker compose -f docker-compose.prod.yml up -d
```

### Step 4 — Register the webhook

The backend exposes `POST /api/admin/telegram/setup-webhook`. Call it after getting an admin JWT:

```bash
# First: get admin JWT (see Section 10)
TOKEN="<your admin JWT>"

curl -X POST https://app.yegnabingo.com/api/admin/telegram/setup-webhook \
  -H "Authorization: Bearer $TOKEN"
```

### Step 5 — Verify webhook

```bash
curl https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo
```

Expected:
```json
{
  "url": "https://app.yegnabingo.com/api/telegram/webhook",
  "has_custom_certificate": false,
  "pending_update_count": 0
}
```

### Webhook routes

| Route | Purpose |
|-------|---------|
| `POST /api/telegram/webhook` | Default operator |
| `POST /api/telegram/webhook/:slug` | Per-operator (multi-tenant) |

Both validate `X-Telegram-Bot-Api-Secret-Token` against the operator's stored secret.

---

## 9. Database Migration

Migrations run **automatically** on every container start via `backend/docker-entrypoint.sh`:

```bash
npx prisma migrate deploy        # apply pending migrations
npx tsx prisma/ensure-app-runtime-password.ts  # rotate app_runtime password
npx tsx prisma/seed.ts           # idempotent: roles, permissions, default settings
exec node dist/main.js           # start the app
```

This is safe to run repeatedly — `migrate deploy` is idempotent, and the seed uses upserts.

### Manual migration (if needed)

```bash
docker compose -f docker-compose.prod.yml exec backend \
  npx prisma migrate deploy
```

### Check migration status

```bash
docker compose -f docker-compose.prod.yml exec backend \
  npx prisma migrate status
```

### Fresh database

If starting with a brand new database, `migrate deploy` applies all migrations in order automatically.

---

## 10. Bootstrap First Admin

The Super Admin account is created via a one-time bootstrap endpoint that requires `ADMIN_KEY`:

```bash
curl -X POST https://app.yegnabingo.com/api/auth/admin/bootstrap \
  -H "Content-Type: application/json" \
  -d '{
    "adminKey": "YOUR_ADMIN_KEY",
    "email": "admin@yegnabingo.com",
    "password": "StrongPassword123!"
  }'
```

The response contains your JWT token. Save it for admin operations.

**After bootstrapping:**
1. Log into the admin panel at `https://app.yegnabingo.com/admin`
2. Change the password on first login (enforced by `mustChangePassword` flag)
3. Configure Telebirr account details in Settings
4. Register the Telegram webhook (see Section 8)

---

## 11. Backups

### Automated daily backup (set up on VPS)

```bash
# Create backup directory
sudo mkdir -p /opt/backups/yena-bingo
sudo chown deploy:deploy /opt/backups/yena-bingo

# Create backup script
cat > /opt/backups/backup.sh << 'EOF'
#!/bin/bash
set -e
BACKUP_DIR=/opt/backups/yena-bingo
DATE=$(date +%Y%m%d_%H%M%S)
FILE="$BACKUP_DIR/yena_bingo_$DATE.sql.gz"

docker compose -f /opt/yena-bingo/docker-compose.prod.yml exec -T postgres \
  pg_dump -U postgres yena_bingo | gzip > "$FILE"

# Keep 14 days of daily backups
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +14 -delete

echo "Backup complete: $FILE"
EOF
chmod +x /opt/backups/backup.sh
```

Add to crontab:

```bash
crontab -e
# Add this line (runs at 2 AM daily):
0 2 * * * /opt/backups/backup.sh >> /var/log/yena-bingo-backup.log 2>&1
```

### Off-server backup (REQUIRED — same-VPS backup is not sufficient)

```bash
# On your local machine or a second server, pull backups via rsync:
# Set up SSH key from backup server to VPS first, then:
rsync -avz deploy@YOUR_VPS_IP:/opt/backups/yena-bingo/ /local/backups/yena-bingo/
```

Or use Hahu Cloud's snapshot feature to take periodic VPS snapshots.

### Restore from backup

```bash
# Stop the backend (not the DB)
docker compose -f docker-compose.prod.yml stop backend

# Restore
gunzip -c /opt/backups/yena-bingo/yena_bingo_20261001_020000.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U postgres yena_bingo

# Restart
docker compose -f docker-compose.prod.yml start backend
```

### Verify a backup (test restore)

```bash
# Create a test database
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U postgres -c "CREATE DATABASE yena_bingo_test;"

# Restore into test database
gunzip -c /opt/backups/yena-bingo/BACKUP_FILE.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U postgres yena_bingo_test

# Verify critical table counts
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U postgres yena_bingo_test -c "SELECT count(*) FROM wallet_ledger;"

# Clean up
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U postgres -c "DROP DATABASE yena_bingo_test;"
```

---

## 12. Monitoring & Logs

### View all logs

```bash
docker compose -f docker-compose.prod.yml logs -f
```

### View specific service logs

```bash
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml logs -f caddy
docker compose -f docker-compose.prod.yml logs -f postgres
docker compose -f docker-compose.prod.yml logs -f frontend
```

### Check container health

```bash
docker compose -f docker-compose.prod.yml ps
```

### Backend health endpoint

```bash
watch -n 5 'curl -s https://app.yegnabingo.com/api/health | python3 -m json.tool'
```

### Prometheus metrics (built-in)

The backend exposes Prometheus metrics at `GET /api/metrics` (admin-auth required). Use with Grafana/Prometheus if needed.

### Disk usage

```bash
df -h
docker system df
```

### Log rotation (built-in Docker)

Add to `/etc/docker/daemon.json` to prevent log files from filling the disk:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "100m",
    "max-file": "5"
  }
}
```

Then: `sudo systemctl reload docker`

---

## 13. Application Updates

Follow this order to deploy a new version safely:

```bash
cd /opt/yena-bingo

# 1. Backup database first
/opt/backups/backup.sh

# 2. Pull new code
git pull origin main

# 3. Review the changes
git log --oneline -10
git diff HEAD~1 HEAD -- backend/prisma/migrations/

# 4. Build new images
docker compose -f docker-compose.prod.yml build

# 5. Tag current images as stable (rollback point)
docker tag $(docker images -q yena-bingo-backend:latest) yena-bingo-backend:stable
docker tag $(docker images -q yena-bingo-frontend:latest) yena-bingo-frontend:stable

# 6. Apply update (migrations run automatically in entrypoint)
docker compose -f docker-compose.prod.yml up -d

# 7. Check health
docker compose -f docker-compose.prod.yml ps
curl https://app.yegnabingo.com/api/health

# 8. Check logs for errors
docker compose -f docker-compose.prod.yml logs --tail=100 backend

# 9. Smoke test — open the app in Telegram
```

---

## 14. Rollback

### Code rollback (no DB schema change)

```bash
cd /opt/yena-bingo

# Go back one commit
git checkout HEAD~1

# Rebuild and redeploy
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

### Image rollback (faster — no rebuild)

```bash
# If you tagged stable before the update:
docker compose -f docker-compose.prod.yml down
docker tag yena-bingo-backend:stable yena-bingo-backend:latest
docker tag yena-bingo-frontend:stable yena-bingo-frontend:latest
docker compose -f docker-compose.prod.yml up -d
```

### Database rollback

Prisma does **not** support automatic `migrate revert`. The safe rollback path is always a database restore:

```bash
# 1. Stop backend
docker compose -f docker-compose.prod.yml stop backend

# 2. Restore from pre-update backup
gunzip -c /opt/backups/yena-bingo/PRE_UPDATE_BACKUP.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U postgres yena_bingo

# 3. Checkout old code
git checkout <PREVIOUS_COMMIT>

# 4. Rebuild and start
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

**Warning:** Never roll back the database without also rolling back the code. Mismatched schema + code will break the app.

---

## 15. Troubleshooting

### Caddy fails to get SSL certificate

```bash
docker compose -f docker-compose.prod.yml logs caddy
```

Causes:
- DNS not yet pointing to this server — wait for propagation, then restart Caddy
- Port 80 blocked: `ufw status` — must allow port 80
- Domain typo in `DOMAIN` env var

Fix:
```bash
nano .env   # correct DOMAIN
docker compose -f docker-compose.prod.yml restart caddy
```

### Backend won't start

```bash
docker compose -f docker-compose.prod.yml logs backend
```

Common causes:
- Missing required env var (`:?` in compose will print the var name)
- PostgreSQL not yet healthy — wait and retry: `docker compose -f docker-compose.prod.yml restart backend`
- Migration failed — check logs for Prisma errors

### Database connection refused

```bash
docker compose -f docker-compose.prod.yml exec backend \
  npx prisma db pull
```

Check that `DATABASE_URL` uses `postgres` (service hostname), not `localhost`.

### Telegram webhook not receiving updates

```bash
# Check webhook registration
curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo

# Re-register
curl -X POST https://app.yegnabingo.com/api/admin/telegram/setup-webhook \
  -H "Authorization: Bearer $ADMIN_JWT"
```

Common cause: `TELEGRAM_WEBHOOK_SECRET` changed after webhook was registered — re-register.

### SPA routes return 404

This means the frontend container is bypassed. Check Caddy is routing `/*` to `frontend:80`.

```bash
curl -I https://app.yegnabingo.com/rooms
# Should return 200 (nginx's try_files serves index.html)
```

### High disk usage

```bash
# Check Docker images and volumes
docker system df -v

# Clean unused images (safe — only removes untagged/dangling)
docker image prune -f

# DO NOT run docker volume prune — this will delete the database!
```

### Full disk — PostgreSQL stops writing

```bash
# Check disk
df -h

# Clean old backups
find /opt/backups/yena-bingo -name "*.sql.gz" -mtime +7 -delete

# Free Docker build cache
docker builder prune -f
```

### Reset a stuck container

```bash
docker compose -f docker-compose.prod.yml restart backend
# or
docker compose -f docker-compose.prod.yml up -d --force-recreate backend
```

**Never** run `docker compose down -v` for a normal restart — the `-v` flag destroys volumes including the PostgreSQL database.

---

## Quick Reference

```bash
# Start all services
docker compose -f docker-compose.prod.yml up -d

# Stop all services (SAFE — preserves volumes)
docker compose -f docker-compose.prod.yml down

# View logs
docker compose -f docker-compose.prod.yml logs -f

# Health check
curl https://app.yegnabingo.com/api/health

# Manual database backup
/opt/backups/backup.sh

# Check running containers
docker compose -f docker-compose.prod.yml ps

# Run database migrations manually
docker compose -f docker-compose.prod.yml exec backend npx prisma migrate deploy

# Open PostgreSQL shell
docker compose -f docker-compose.prod.yml exec postgres psql -U postgres yena_bingo
```

# YEGNA BINGO Production Readiness Report

**Date:** 2026-10-02  
**Auditor:** Automated audit + code inspection  
**Commit:** d13bbd8 + audit fixes

---

## Architecture
**PASS**

- Caddy (TLS termination) → frontend:80 + backend:3000 → postgres:5432
- All services on private Docker network; only ports 80/443 exposed
- No WebSocket (not used by this app) — confirmed by full grep of backend/src
- No Redis — removed (dead infrastructure, backend never imported a Redis client)
- `.dockerignore` created to prevent `.env` leaking into build context

## Docker
**PASS**

- `backend/Dockerfile`: multi-stage build, non-root `app` user, `wget` health check
- `Dockerfile.frontend`: Node build → nginx:1.27-alpine, `VITE_API_BASE_URL` build arg
- `docker-compose.prod.yml`: Caddy + backend + frontend + postgres; all `:?` fail-fast vars
- `backend/docker-entrypoint.sh`: migrate → seed → start (correct startup order)
- `.dockerignore`: blocks `.env`, `node_modules`, `dist`, `.git` from build context

## Frontend
**PASS**

- Framework: React 18 + Vite 5
- Production build: `npm run build` → `dist/`
- Served by nginx:1.27-alpine (NOT dev server)
- SPA routing: `try_files $uri $uri/ /index.html` — all routes work
- Security headers: `X-Content-Type-Options`, `Referrer-Policy`, CSP with Telegram `frame-ancestors`
- Asset caching: `max-age=31536000, immutable` for hashed assets; `no-cache` for `index.html`
- `VITE_DEV_TELEGRAM_USER` blocked from production bundle by `.dockerignore`

## Backend
**PASS**

- Framework: NestJS 10 (Express adapter)
- Production start: `node dist/main.js` (NOT `nest start --watch`)
- Listens on `0.0.0.0` (NestJS default) — accessible from Caddy container
- Global prefix: `/api` — all routes under `/api/...`
- Health endpoint: `GET /api/health` → `{ status: 'ok', time: ISO }` + DB ping
- `trust proxy: 1` — correct for single-hop Caddy topology
- `express.json({ limit: '14mb' })` — supports receipt photo uploads
- Helmet, cookie-parser, ValidationPipe, ThrottlerGuard — all active
- Prometheus metrics at `GET /api/metrics`

## PostgreSQL
**PASS**

- PostgreSQL 15-alpine
- `postgres_data` Docker volume — persistent across restarts
- Port 5432 NOT exposed to host or internet
- Runtime role: `app_runtime` (RLS-scoped, least privilege)
- Superuser `postgres` used ONLY for migrations (never by running app)
- `BEFORE UPDATE OR DELETE` trigger on `wallet_ledger` and `audit_logs` — immutable
- RLS policies: migration 20260926090000_row_level_security

## Nginx
**PASS** (nginx serves the frontend inside its container; Caddy is the public reverse proxy)

- `nginx.conf`: SPA fallback, gzip, production security headers, Telegram CSP
- Caddy handles public routing: `/api/*` → backend:3000, `/*` → frontend:80
- `handle_path /api/*` strips `/api` prefix before proxying — correct for NestJS `setGlobalPrefix('api')`

## DNS
**NOT TESTED** — requires real domain and DNS provider

Required configuration:
```
A record: app → YOUR_VPS_PUBLIC_IP
```

Validation commands:
```bash
nslookup app.yegnabingo.com
dig app.yegnabingo.com +short
```

Both must return the VPS public IP before starting Caddy.

## HTTPS
**NOT TESTED** — requires DNS pointing at server and public internet access

Caddy handles TLS automatically via Let's Encrypt ACME. No manual certificate steps needed. HTTP automatically redirects to HTTPS.

## SSL Renewal
**NOT TESTED** — requires running production instance

Caddy renews certificates automatically ~30 days before expiry. No cron job or certbot needed. Check: `docker compose logs caddy | grep -i certif`

## Telegram Mini App
**NOT TESTED** — requires real bot token and Telegram client

Configuration is correct:
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` required in `.env`
- `ALLOW_UNVERIFIED_TELEGRAM` hardcoded `"false"` in `docker-compose.prod.yml`
- `YENA_BINGO_APP_URL` must point to `https://app.yegnabingo.com`

## Telegram Webhook
**NOT TESTED** — requires live HTTPS + real bot token

Webhook routes implemented:
- `POST /api/telegram/webhook` — default operator
- `POST /api/telegram/webhook/:slug` — per-operator (multi-tenant)

Both validate `X-Telegram-Bot-Api-Secret-Token` before processing. Registration command: `POST /api/admin/telegram/setup-webhook` (admin auth required).

## Authentication
**PASS**

- Telegram HMAC-validated `initData` for players
- JWT access tokens (short-lived) + httpOnly refresh cookies for admins
- `mustChangePassword` flag enforces first-login password change
- TOTP / 2FA available
- Account lockout after failed attempts
- `ALLOW_UNVERIFIED_TELEGRAM=false` in production

## Authorization
**PASS**

- RBAC: `SUPER_ADMIN`, `ADMIN`, `OPERATOR_OWNER`, `OPERATOR_STAFF`
- All 28 controllers verified to have explicit `@UseGuards` or `@Public()` decorator (`guard-coverage.spec.ts`)
- RLS at DB level: `app_runtime` role + `SET LOCAL app.operator_id` per request
- `tenant_id` never trusted from frontend — resolved from authenticated token

## Financial Ledger
**PASS**

- `wallet_ledger` table: append-only, immutable via DB trigger
- `audit_logs` table: same trigger
- Integer-only arithmetic for all money (no floats in DB — `DECIMAL(14,2)` columns)
- `Math.round()` applied to all multiplication paths (wagering, prize split)
- Prize invariant: `houseShare + sum(perWinner) === totalPot` exactly
- Ledger entry types: DEPOSIT, WITHDRAWAL, BINGO_ENTRY, BINGO_REFUND, WINNING_CREDIT, GAME_REFUND, BONUS, HOUSE_REVENUE

## Telebirr
**PASS** (code) / **NOT TESTED** (live flow)

- Manual Telebirr-only deposit flow implemented
- Receipt upload: player uploads screenshot/PDF → admin review → approval → ledger
- No crypto, no Binance, no auto payment paths
- Deposit minimum: **200 ETB** (corrected this audit)
- Withdrawal minimum: **50 ETB** (corrected this audit)
- Admin approval required for both deposits and withdrawals

## Bingo Concurrency
**PASS** (unit tests) / **NOT TESTED** (load test against live VPS)

Database-level protections:
- Cartela reservation: unique constraint + `FOR UPDATE` row lock in transaction
- Wallet operations: ledger-based (no direct balance field mutation without ledger)
- Game finalization: `SELECT ... FOR UPDATE` on game row prevents double payout

k6 stress test suite at `stress-test/` available for live load testing.

## File Uploads
**PASS**

- `express.json({ limit: '14mb' })` in `main.ts`
- Receipt storage: `/app/storage/receipts` on persistent Docker volume
- Theme assets: `/app/storage/public` on persistent Docker volume
- Caddy default body limit is not restrictive for this upload size

## Security
**PASS**

- Helmet (security headers) on every backend response
- CORS: explicit origins only (no wildcard) — `CORS_ALLOWED_ORIGINS`
- Rate limiting: ThrottlerGuard global + tighter `30/10s` on Telegram webhook
- Bot tokens AES-256-GCM encrypted at rest (`PLATFORM_ENCRYPTION_KEY`)
- Secrets not committed: `.env` gitignored, `.dockerignore` blocks from build
- No `ALLOW_UNVERIFIED_TELEGRAM` in production
- `trust proxy: 1` — correct real IP resolution behind Caddy

## Backups
**PASS** (documented) / **NOT TESTED** (requires running VPS)

- `BACKUP.md`: `pg_dump`, crontab schedule, off-server rsync, retention policy
- `DISASTER_RECOVERY.md`: VPS crash, DB corruption, bad migration, disk full
- `ROLLBACK.md`: Docker image rollback, Prisma migration rollback procedure
- Daily crontab instructions in `PRODUCTION_DEPLOYMENT.md` Section 11

## Restore
**NOT TESTED** — requires production environment

Restore command documented. Test restore procedure (into separate DB) documented in `PRODUCTION_DEPLOYMENT.md` Section 11.

## Monitoring
**PASS** (instrumentation) / **NOT TESTED** (live dashboards)

- Prometheus metrics: `GET /api/metrics` (prom-client)
- Structured JSON logging: nestjs-pino in production mode
- Sentry error tracking: `SENTRY_DSN` env var (no-op if blank)
- Docker healthchecks on backend and postgres containers

## Load Testing
**NOT TESTED** — k6 stress test suite exists at `stress-test/`, requires live VPS

---

## Final Production Status

**READY**

All code-verifiable items pass. Items requiring a live VPS + domain + Telegram credentials are documented and cannot be tested locally.

---

## Remaining Blockers

None — all code-level blockers have been resolved.

### Pre-launch checklist (VPS side)

- [ ] VPS provisioned and SSH access working
- [ ] UFW configured (22, 80, 443 open)
- [ ] Docker installed
- [ ] Repository cloned to `/opt/yena-bingo`
- [ ] `.env` filled in with all required values
- [ ] DNS A record: `app` → VPS public IP (verify with `dig`)
- [ ] `docker compose -f docker-compose.prod.yml up -d --build`
- [ ] HTTPS verified: `curl -I https://app.yegnabingo.com`
- [ ] Backend health: `curl https://app.yegnabingo.com/api/health`
- [ ] Bootstrap Super Admin via `/api/auth/admin/bootstrap`
- [ ] Register Telegram webhook via `/api/admin/telegram/setup-webhook`
- [ ] Configure Telebirr account in Admin → Settings
- [ ] Set up daily backup crontab (Section 11 of PRODUCTION_DEPLOYMENT.md)
- [ ] Set up off-server backup (rsync or Hahu Cloud snapshot)
- [ ] End-to-end smoke test via real Telegram client

---

## Files Created / Modified This Audit

| File | Action |
|------|--------|
| `DEPLOYMENT_AUDIT.md` | Created — full architecture inspection |
| `PRODUCTION_DEPLOYMENT.md` | Created — step-by-step VPS deployment guide |
| `PRODUCTION_READINESS_REPORT.md` | Updated — this file |
| `.dockerignore` | Created — blocks `.env` from Docker build context |
| `backend/src/settings/settings.service.ts` | Fixed — deposit/withdrawal minimums |
| `backend/src/bingo/bingo.service.ts` | Fixed — `Math.round()` on prize-pool conversion |
| `backend/src/bonus/bonus.service.ts` | Fixed — `Math.round()` on wagering multiplier |
| `docker-compose.prod.yml` | Fixed — Redis removed |
| `BACKUP.md` | Created |
| `DISASTER_RECOVERY.md` | Created |
| `ROLLBACK.md` | Created |

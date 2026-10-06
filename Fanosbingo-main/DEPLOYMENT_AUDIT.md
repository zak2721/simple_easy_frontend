# YEGNA BINGO — DEPLOYMENT AUDIT

**Date:** 2026-10-02  
**Auditor:** Automated inspection of full repository

---

## Current Architecture

```
INTERNET
    |
    v
{$DOMAIN}  (e.g. app.yegnabingo.com)
    |
    v
CADDY :80/:443   ← TLS termination, auto Let's Encrypt, HTTP→HTTPS redirect
    |
    +------ /api/* ──→ backend:3000  (NestJS)
    |
    +------ /*  ────→ frontend:80   (nginx serving React/Vite SPA)
                           |
                       backend:3000
                           |
                       postgres:5432  (internal only)
```

**Why Caddy, not Nginx as reverse proxy:** Caddy was deliberately chosen over nginx+certbot for TLS termination. It handles certificate issuance, renewal, and HTTP→HTTPS redirect automatically with zero configuration — critical for Telegram Mini Apps which require HTTPS. The existing `Caddyfile` is correct and complete. This audit does NOT replace it with nginx.

---

## Services

| Service | Image | Internal Port | Public | Notes |
|---------|-------|--------------|--------|-------|
| caddy | caddy:2-alpine | 80, 443 | ✅ 80, 443 | TLS termination |
| frontend | build: Dockerfile.frontend | 80 | ❌ internal | nginx serving React dist |
| backend | build: backend/Dockerfile | 3000 | ❌ internal | NestJS, expose only |
| postgres | postgres:15-alpine | 5432 | ❌ internal | persistent volume |

**Redis:** Removed — not used anywhere in backend/src. Dead infrastructure eliminated this audit.

---

## Frontend Service

| Property | Value |
|----------|-------|
| Framework | React 18 + Vite 5 |
| Build command | `npm run build` |
| Output directory | `dist/` |
| Production server | nginx:1.27-alpine |
| Internal port | 80 |
| SPA routing | ✅ `try_files $uri $uri/ /index.html` |
| Dev server in prod | ❌ Never — `npm run dev` not used |
| Build arg | `VITE_API_BASE_URL` |

SPA routes confirmed working via nginx.conf `try_files` fallback:
- `/` `/rooms` `/wallet` `/leaderboard` `/settings` `/admin` → all serve `index.html`

---

## Backend Service

| Property | Value |
|----------|-------|
| Framework | NestJS 10 (Express adapter) |
| Language | TypeScript → compiled to `dist/main.js` |
| Production start | `node dist/main.js` |
| Port | `process.env.PORT` (default 3000) |
| Bind address | `0.0.0.0` (NestJS default) — confirmed in main.ts |
| Global prefix | `/api` (all routes served under `/api/...`) |
| Health endpoint | `GET /api/health` → `{ status: 'ok', time: ISO }` + DB ping |
| Telegram webhook | `POST /api/telegram/webhook` (default operator) |
| Telegram webhook (multi) | `POST /api/telegram/webhook/:slug` (per-operator) |
| WebSocket / Socket.IO | ❌ NOT USED — no `@WebSocketGateway` anywhere |
| File uploads | `express.json({ limit: '14mb' })` — receipt photos |
| Trust proxy | `app.set('trust proxy', 1)` — correct for Caddy topology |
| Startup sequence | migrations → app_runtime password rotation → seed → `node dist/main.js` |

---

## Database

| Property | Value |
|----------|-------|
| Engine | PostgreSQL 15 |
| ORM | Prisma 5 |
| Migration command | `prisma migrate deploy` |
| Seed command | `tsx prisma/seed.ts` (idempotent upserts) |
| Migration path | `backend/prisma/migrations/` |
| Runtime role | `app_runtime` (RLS-scoped, least privilege) |
| Superuser role | `postgres` (migrations only, never the running app) |
| Volume | `postgres_data` (persistent) |
| Public exposure | ❌ No ports published |
| Ledger immutability | ✅ DB trigger on `wallet_ledger` + `audit_logs` |
| RLS | ✅ Migration 20260926090000_row_level_security |

---

## Reverse Proxy (Caddy)

| Route | Target |
|-------|--------|
| `{$DOMAIN}/api/*` | `backend:3000` (path stripped by `handle_path`) |
| `{$DOMAIN}/*` | `frontend:80` |

Features active: gzip/zstd compression, HSTS, automatic TLS, HTTP→HTTPS redirect.

---

## Frontend Nginx (inside container)

| Feature | Status |
|---------|--------|
| SPA fallback | ✅ `try_files $uri $uri/ /index.html` |
| Asset caching | ✅ `max-age=31536000, immutable` for hashed JS/CSS/img |
| index.html caching | ✅ `no-cache` — new deploys picked up immediately |
| Security headers | ✅ `X-Content-Type-Options`, `Referrer-Policy`, CSP |
| CSP Telegram iframe | ✅ `frame-ancestors` allows `web.telegram.org` |
| gzip | ✅ enabled |

---

## Environment Variables

All read from environment — never hardcoded. Defined in `.env.example`.

### Required (app fails to start without these)
| Variable | Used by | Notes |
|----------|---------|-------|
| `DATABASE_URL` | Prisma runtime | app_runtime role URL |
| `MIGRATE_DATABASE_URL` | Prisma migrate | superuser URL, entrypoint only |
| `APP_RUNTIME_PASSWORD` | entrypoint | rotated on every start |
| `POSTGRES_PASSWORD` | docker postgres | DB root password |
| `JWT_ACCESS_SECRET` | auth tokens | generate: `openssl rand -hex 32` |
| `ADMIN_KEY` | bootstrap endpoint | generate: `openssl rand -hex 32` |
| `TELEGRAM_BOT_TOKEN` | telegram service | from @BotFather |
| `TELEGRAM_BOT_USERNAME` | telegram service | from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | webhook auth | generate: `openssl rand -hex 32` |
| `DOMAIN` | Caddy, CORS, URLs | e.g. `app.yegnabingo.com` |
| `CADDY_EMAIL` | Let's Encrypt | expiry notices |
| `CORS_ALLOWED_ORIGINS` | NestJS CORS | `https://{DOMAIN}` |
| `VITE_API_BASE_URL` | Vite build arg | `https://{DOMAIN}/api` |

### Optional (safe defaults exist)
| Variable | Default | Notes |
|----------|---------|-------|
| `PLATFORM_ENCRYPTION_KEY` | (empty) | required once multi-operator bot tokens stored |
| `SENTRY_DSN` | (empty) | error tracking, no-op if blank |
| `ALLOW_UNVERIFIED_TELEGRAM` | `false` | hardcoded false in prod compose |
| `RECEIPTS_STORAGE_PATH` | `/app/storage/receipts` | persistent volume |
| `PUBLIC_STORAGE_PATH` | `/app/storage/public` | persistent volume |
| `PORT` | `3000` | backend port |
| `NODE_ENV` | set to `production` by Dockerfile | |

---

## Docker Configuration

### Existing Files (all correct, no replacement needed)

| File | Status | Notes |
|------|--------|-------|
| `backend/Dockerfile` | ✅ Production-ready | multi-stage, non-root app user, health check |
| `Dockerfile.frontend` | ✅ Production-ready | multi-stage Node→nginx, VITE_API_BASE_URL build arg |
| `docker-compose.prod.yml` | ✅ Updated this audit | Redis removed; correct `:?` fail-fast vars |
| `Caddyfile` | ✅ Correct | auto TLS, HSTS, gzip, correct routing |
| `nginx.conf` | ✅ Correct | SPA, caching, CSP for Telegram |
| `.dockerignore` | ✅ Created this audit | blocks `.env` from build context |
| `backend/docker-entrypoint.sh` | ✅ Correct | migrate → seed → start |

---

## Security Configuration

| Item | Status |
|------|--------|
| PostgreSQL not exposed | ✅ |
| Backend not exposed | ✅ |
| Telegram HMAC auth | ✅ |
| Webhook secret validation | ✅ per-operator |
| JWT + httpOnly refresh cookie | ✅ |
| RBAC 4-tier | ✅ SUPER_ADMIN / ADMIN / OPERATOR_OWNER / OPERATOR_STAFF |
| RLS tenant isolation | ✅ DB-level |
| Ledger immutability trigger | ✅ DB-level |
| Bot token encryption | ✅ AES-256-GCM |
| `ALLOW_UNVERIFIED_TELEGRAM` | ✅ hardcoded false in prod |
| Helmet security headers | ✅ |
| Rate limiting (ThrottlerGuard) | ✅ |
| Trust proxy=1 (real IP) | ✅ |
| `.env` excluded from Docker build | ✅ `.dockerignore` created |
| Secrets not committed | ✅ `.gitignore` covers `.env` |

---

## Problems Found and Fixed This Audit

| # | Severity | Problem | Fix |
|---|----------|---------|-----|
| 1 | Medium | `.dockerignore` missing — `.env` could be copied into Docker build context, baking `VITE_DEV_TELEGRAM_USER` into prod bundle | Created `.dockerignore` |
| 2 | Medium | `DEPOSIT_MIN_ETB` default was 30 (spec: 200), `WITHDRAWAL_MIN_ETB` default was 200 (spec: 50) | Fixed code defaults |
| 3 | Low | `bingo.service.ts` used `Number(game.total_pot)` without `Math.round()` before integer arithmetic | Added `Math.round()` |
| 4 | Low | `bonus.service.ts` wagering multiplier could produce float | Added `Math.round()` |
| 5 | Info | Redis provisioned but unused (dead infrastructure) | Removed from `docker-compose.prod.yml` |

---

## Concurrency & Stress Testing

The repository contains a full k6-based stress test suite at `stress-test/`:

| Script | Purpose |
|--------|---------|
| `run-test.sh spike` | Spike load test |
| `run-test.sh sustained` | Sustained load |
| `run-test.sh gradual` | Gradual ramp |
| `run-test.sh all` | All scenarios |
| `full-test-suite.sh` | Full suite with setup/teardown |
| `generate-test-users.ts` | Seed test users |
| `analyze-results.ts` | Results analysis |

Database-level concurrency protections confirmed:
- Cartela reservation: unique constraint + transaction isolation
- Wallet operations: ledger-based (no direct balance fields mutated without ledger entry)
- Duplicate deposit/withdrawal: DB unique constraints + service-layer idempotency

**Status: NOT TESTED** — requires VPS + real domain + Telegram credentials for full E2E.

---

## Items Requiring VPS / External Services

| Item | Reason |
|------|--------|
| DNS resolution | Requires actual domain + DNS provider |
| HTTPS / Let's Encrypt | Requires public domain pointing at server |
| Telegram webhook | Requires live bot token + public HTTPS |
| Telegram Mini App auth | Requires real Telegram client |
| Certificate renewal | Requires running Caddy instance |
| Telebirr deposit flow | Requires Telebirr account configuration |
| Full smoke test | Requires all of the above |

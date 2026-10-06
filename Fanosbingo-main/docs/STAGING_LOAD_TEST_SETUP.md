# Staging deployment for the k6 load tests

Purpose-built for running `load-tests/yena-bingo-load-test.js` at real scale
(100/500/1000/5000 users) — the one item still open from
`PRODUCTION_READINESS_AUDIT.md`. Not a second copy of `DEPLOYMENT.md`; it
reuses that guide's steps and calls out only what's different for a
load-test target versus a real production deployment.

---

## Why a separate server, not this local dev box

The local dev backend (this repo's `docker-compose.yml`, single Postgres
container, no resource limits mirroring a real VPS) already proved the k6
script itself is correct at a 30-VU smoke scale — see the load-test commit
history. It cannot tell you anything meaningful about capacity: it's not
running on production-equivalent hardware, and hammering it further would
just flood the same dev database you've been using for manual testing all
session. A real capacity number needs a real, isolated deployment.

## Why NOT the eventual production server

Never run a load test against the server you intend to actually launch on.
Best case it's wasted load on a box about to serve real users; worst case a
runaway test degrades a server that's already partially configured for go-
live. Provision a second, throwaway VPS — cheapest tier is fine, this is
temporary — and tear it down (or stop billing on it) once you have your
numbers.

---

## 1. Provision + deploy — follow `DEPLOYMENT.md` steps 1-7 exactly, with two differences

Everything in `DEPLOYMENT.md` §1 (provision), §2 (harden), §3 (DNS), §4
(install Docker), §5 (get the code) applies unchanged. At §6-7, deviate as
follows:

### Difference 1 — a separate `.env.staging`, never `.env.production`

Copy the same structure as `.env.production` but:
- **Fresh secrets.** Never reuse a production secret on a throwaway box —
  generate new ones with the same commands `DEPLOYMENT.md`/`.env.production`
  already document (`openssl rand -hex 32`, `openssl rand -base64 32`, etc.).
- **A different domain** (or subdomain), e.g. `staging.yourdomain.com`,
  pointed at the staging VPS's own IP. DNS still needs to resolve before
  Caddy starts, exactly as in the main guide.
- The rest (`POSTGRES_DB`, room prices, etc.) can just be copied — this data
  never needs to look like your real catalog.

### Difference 2 — one compose override for `ALLOW_UNVERIFIED_TELEGRAM`

`docker-compose.prod.yml` hardcodes `ALLOW_UNVERIFIED_TELEGRAM: "false"` —
correct for real production, but the load-test script authenticates via
`devTelegramUserId` (see `load-tests/README.md`), which only works when this
is `"true"`. Rather than edit the production compose file (which would then
need to be remembered and reverted), add a small override file that only
exists on the staging box:

```yaml
# docker-compose.staging-override.yml — staging only, never copy this to the production server.
services:
  backend:
    environment:
      ALLOW_UNVERIFIED_TELEGRAM: "true"
```

Deploy with both files (`-f` order matters — the override must come last so
its values win):

```bash
docker compose --env-file .env.staging \
  -f docker-compose.prod.yml -f docker-compose.staging-override.yml \
  up -d --build
```

Everything else — Postgres/Redis network isolation, the `app_runtime` RLS
role, rate limiting, CORS, security headers — stays exactly as production
would run it. **Do not also relax the rate limiter for this test.** The k6
script already assigns each virtual user a distinct synthetic
`X-Forwarded-For` IP specifically so it's measured against the *same*
per-real-user throttle production traffic would see (see the comment in
`load-tests/yena-bingo-load-test.js` and `load-tests/README.md`) — loosening
the limiter on top of that would make the results meaningless for judging
real capacity.

---

## 2. Verify the staging deploy before loading it

```bash
curl -I https://staging.yourdomain.com/api/health
```

Should return `200`. Then confirm the dev-login path is actually open (only
true when `ALLOW_UNVERIFIED_TELEGRAM=true` took effect):

```bash
curl -s -X POST https://staging.yourdomain.com/api/auth/telegram \
  -H "Content-Type: application/json" \
  -d '{"devTelegramUserId": 900000001, "operatorSlug": "yena"}'
```

Should return a real session (`accessToken`, `wallet`, ...), not
`401 Invalid or expired Telegram session`.

---

## 3. Run the four scales

From wherever you run k6 (a Docker image works, as validated during this
script's own smoke test — see `load-tests/README.md`; a real network hop to
a remote server is exactly what k6 expects, unlike the `host.docker.internal`
workaround needed for the local-dev smoke test):

```bash
k6 run -e BASE_URL=https://staging.yourdomain.com/api -e VUS=100  -e HOLD=2m load-tests/yena-bingo-load-test.js
k6 run -e BASE_URL=https://staging.yourdomain.com/api -e VUS=500  -e HOLD=3m load-tests/yena-bingo-load-test.js
k6 run -e BASE_URL=https://staging.yourdomain.com/api -e VUS=1000 -e HOLD=5m -e RAMP_UP=1m load-tests/yena-bingo-load-test.js
k6 run -e BASE_URL=https://staging.yourdomain.com/api -e VUS=5000 -e HOLD=5m -e RAMP_UP=2m load-tests/yena-bingo-load-test.js
```

Run them in order, smallest first — if 100 users already shows trouble,
there's no point spending the time (or the VPS's CPU credits) on 5000 yet.
Watch `docker stats` on the staging box in a second terminal during each run
to correlate k6's latency numbers with actual CPU/memory/connection-pool
pressure, not just the client-side view.

## 4. After the runs

- Save each run's summary output (or `k6 run --out json=results-100.json ...`
  for the full time series) before moving to the next scale — this is the
  actual deliverable, the number this whole exercise exists to produce.
- Tear down the staging VPS (`docker compose down -v` then deprovision the
  server) once you have what you need — no reason to keep paying for a
  throwaway box, and `.env.staging`'s secrets should be treated as burned
  the moment the box is destroyed.
- Feed the results back into `PRODUCTION_READINESS_AUDIT.md`'s "Post-Audit
  Remediation Status" table (item 9) — either the thresholds held and item 9
  closes out, or they didn't and you have concrete numbers to decide what to
  scale (bigger instance, connection pool tuning, read replica, etc.) before
  a real launch.

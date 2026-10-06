# Load testing (current NestJS backend)

`yena-bingo-load-test.js` targets the live NestJS + Prisma + Postgres API and
is multi-operator aware. The `stress-test/` directory at the repo root is
**legacy and no longer runnable** — it calls Supabase REST/Edge Function
endpoints (`SUPABASE_URL/rest/v1/rpc/...`, `functions/v1/select-card`) from
the pre-migration architecture (see `PRODUCTION_MIGRATION_REPORT.md`); those
endpoints don't exist anymore. Kept for historical reference only.

## Prerequisites

1. Install k6: https://k6.io/docs/get-started/installation/
2. A **dedicated load-test target** — never production. It must run with
   `ALLOW_UNVERIFIED_TELEGRAM=true` so the script can log in via
   `devTelegramUserId` instead of forging real Telegram `initData` signatures.
   This flag must never be set on a real deployment (see
   `backend/.env.example`), which is exactly why this can't be pointed at
   production even if you wanted to.
3. At least one operator that exists in that target's database (defaults to
   the seeded `yena` operator). To exercise cross-operator isolation under
   load, create 2-3 extra test operators first and pass their slugs via
   `OPERATOR_SLUGS`.
4. For meaningful withdrawal-flow results, pre-fund the test user ID range
   (`900000000 + RUN_ID*100000 + <vu>`) with `wonBalance` via the admin
   wallet-adjustment endpoint — fresh signups only get bonus balance, so
   withdrawal attempts will otherwise correctly 400 with "insufficient
   balance" (still useful for measuring the locking/validation path's latency
   under load, just not a "successful withdrawal" metric).

## Running the 4 requested scales

```bash
# Smoke — 100 users
k6 run -e VUS=100 -e HOLD=2m yena-bingo-load-test.js

# Medium — 500 users
k6 run -e VUS=500 -e HOLD=3m yena-bingo-load-test.js

# High — 1000 users
k6 run -e VUS=1000 -e HOLD=5m -e RAMP_UP=1m yena-bingo-load-test.js

# Breaking point — 5000 users
k6 run -e VUS=5000 -e HOLD=5m -e RAMP_UP=2m yena-bingo-load-test.js
```

Point at a real host and multiple operators:

```bash
k6 run -e BASE_URL=https://staging.yourdomain.com/api \
       -e OPERATOR_SLUGS=yena,test-operator-b,test-operator-c \
       -e VUS=500 -e HOLD=3m \
       yena-bingo-load-test.js
```

## What it measures

Per-VU flow: login once (cached for the VU's lifetime, since login is
rate-limited at 30/min per key by design — see the comment in the script),
then repeatedly loads the lobby and does a weighted mix of cartela purchase
(50%), deposit submission (15%), withdrawal request (15%), bingo claim (10%),
and lobby-only polling (10%) — approximating real traffic shape rather than
hammering one endpoint.

Each VU sends requests with a distinct synthetic `X-Forwarded-For` IP (the
backend trusts one proxy hop — `main.ts`), so the global rate limiter (120
req/min per key, `app.module.ts`) sees many distinct real users instead of
one client hammering the API from a single address, which is what actually
happens when k6 runs from one machine. Without this, a run collapses into
mostly-429s almost immediately regardless of VU count — confirmed empirically
during this script's own validation (78% failure rate before the fix, 0%
unexpected-error rate after it, at the same 30 VUs).

Custom metrics: `login_duration`, `lobby_duration`,
`cartela_purchase_duration` (+ separate counters for success vs.
already-taken, since a 409 under concurrent purchase load is the *expected*
outcome of the row-lock/unique-constraint design, not a failure),
`deposit_submit_duration`, `withdrawal_request_duration`,
`bingo_claim_duration`, and `unexpected_errors` (any 5xx, anywhere).

## Expected performance metrics (targets, not guarantees)

These are starting thresholds baked into the script — tighten or loosen them
once you have a real baseline run, don't just raise them to make a failing
run pass:

| Metric | Target |
|---|---|
| Login p95 | < 1500ms |
| Lobby load p95 | < 800ms |
| Cartela purchase p95 | < 1500ms |
| Unexpected (5xx) error rate | < 1% |

Deliberately not gating on k6's built-in `http_req_failed` — this script
intentionally produces a lot of *expected* 4xx traffic (409 "already taken"
from VUs racing for the same small cartela pool, 400 "insufficient balance"
on withdrawal, 400 "not a winner" on claim), which `http_req_failed` counts
as failures regardless of whether the response was actually correct. Judge
correctness from the named checks (`login: 200/201`, `lobby: 200`, etc.) and
`unexpected_errors` (5xx only), not from that metric.

If `cartela_purchase_duration` degrades sharply as VUs scale up while
`cartela_purchase_already_taken` stays proportionally flat, that points at
lock contention on the game row (`SELECT ... FOR UPDATE` in
`CardsService.selectCartela`) rather than raw throughput — expected at very
high concurrency on a single "hot" game, and the reason the DB backstop
(unique constraint) exists as the final word rather than the row lock alone.

// Modern k6 load test for the current NestJS + Prisma + Postgres backend,
// multi-operator aware. Replaces the Supabase-era scripts in `stress-test/`
// (those call `SUPABASE_URL/rest/v1/rpc/...` and `functions/v1/select-card`,
// endpoints that no longer exist since the migration documented in
// PRODUCTION_MIGRATION_REPORT.md — they cannot run against this backend).
//
// ============================================================================
// REQUIRES A DEDICATED LOAD-TEST TARGET. NEVER POINT THIS AT PRODUCTION.
// ============================================================================
// Player login goes through POST /auth/telegram with `devTelegramUserId`
// instead of real Telegram initData — this path only works when the target
// backend has ALLOW_UNVERIFIED_TELEGRAM=true (see backend/.env.example).
// That flag must never be set in a real production deployment (it disables
// Telegram signature verification), so this script is only usable against a
// throwaway/staging stack seeded for load testing, never prod.
//
// Login is also rate-limited at 30/min per key (PLAYER_LOGIN_THROTTLE,
// backend/src/auth/auth.controller.ts) — by design, not a bug. This script
// logs in ONCE per virtual user (cached at module scope, so it survives
// across that VU's iterations) and reuses the token for the rest of the run,
// which is both realistic (real players don't re-login every request) and
// keeps login volume far below the throttle even at 5000 VUs, since logins
// are spread across the ramp-up window rather than all firing at once.
//
// Withdrawal-flow checks need players with a real `wonBalance` (winnings),
// which fresh accounts don't have — the signup bonus only funds
// `bonusBalance`. Either seed test accounts with a wallet adjustment via the
// admin API before running, or accept that withdrawal attempts will mostly
// return a clean 400 "insufficient balance" here, which still exercises the
// locking/validation path under load even though it isn't a "successful"
// withdrawal.
//
// ---------------------------------------------------------------------------
// USAGE — presets for the 4 scales requested:
//
//   Smoke   (100 users):  k6 run -e VUS=100  -e HOLD=2m load-tests/yena-bingo-load-test.js
//   Medium  (500 users):  k6 run -e VUS=500  -e HOLD=3m load-tests/yena-bingo-load-test.js
//   High    (1000 users): k6 run -e VUS=1000 -e HOLD=5m -e RAMP_UP=1m load-tests/yena-bingo-load-test.js
//   Breaking(5000 users): k6 run -e VUS=5000 -e HOLD=5m -e RAMP_UP=2m -e PRE_ALLOC=500 -e MAX_VUS=5500 load-tests/yena-bingo-load-test.js
//
// Common overrides:
//   -e BASE_URL=https://staging.yourdomain.com/api   (default http://localhost:3000/api)
//   -e OPERATOR_SLUGS=yena,abebe-test,operator-c      (comma-separated; round-robined across VUs to load-test tenant isolation under concurrency, not just single-tenant throughput)
//   -e RUN_ID=2                                        (changes the test-user ID range so repeated runs don't reuse depleted balances/state from a prior run)
// ---------------------------------------------------------------------------

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000/api';
const OPERATOR_SLUGS = (__ENV.OPERATOR_SLUGS || 'yena').split(',').map((s) => s.trim());
const RUN_ID = Number(__ENV.RUN_ID || 1);
// Same base offset convention as stress-test/generate-test-users.ts (id
// range that can never collide with real Telegram user IDs).
const TEST_USER_BASE = 900000000 + RUN_ID * 100000;

const VUS = Number(__ENV.VUS || 100);
const RAMP_UP = __ENV.RAMP_UP || '30s';
const HOLD = __ENV.HOLD || '2m';
const RAMP_DOWN = __ENV.RAMP_DOWN || '30s';

const loginDuration = new Trend('login_duration');
const lobbyDuration = new Trend('lobby_duration');
const purchaseDuration = new Trend('cartela_purchase_duration');
const depositDuration = new Trend('deposit_submit_duration');
const withdrawalDuration = new Trend('withdrawal_request_duration');
const claimDuration = new Trend('bingo_claim_duration');

const loginErrors = new Rate('login_errors');
const purchaseSuccess = new Counter('cartela_purchase_success');
const purchaseTaken = new Counter('cartela_purchase_already_taken'); // expected under concurrency, not a failure
const purchaseErrors = new Rate('cartela_purchase_unexpected_errors');
const unexpectedErrors = new Rate('unexpected_errors'); // any 5xx, anywhere

export const options = {
  scenarios: {
    load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP_UP, target: VUS },
        { duration: HOLD, target: VUS },
        { duration: RAMP_DOWN, target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    // Money-adjacent hot paths: kept tight. Raise these only with evidence
    // (an accepted, documented capacity limit), never to silence a real
    // regression.
    login_duration: ['p(95)<1500'],
    lobby_duration: ['p(95)<800'],
    cartela_purchase_duration: ['p(95)<1500'],
    // unexpected_errors (any 5xx) is the real correctness gate — not k6's
    // built-in http_req_failed, which counts every non-2xx/3xx response as
    // "failed" by default. This script deliberately produces a lot of
    // expected 4xx: 409 "already taken" from VUs racing for the same small
    // cartela pool (the whole point of that traffic pattern), 400
    // "insufficient balance" from fresh test accounts requesting a
    // withdrawal, 400 "not a winner" from claim attempts. Gating on
    // http_req_failed would fail a healthy run for behaving correctly under
    // contention — see the per-action checks and counters below instead
    // (cartela_purchase_already_taken, etc.) for what "expected" looks like.
    unexpected_errors: ['rate<0.01'],
  },
};

function operatorForVu(vu) {
  return OPERATOR_SLUGS[vu % OPERATOR_SLUGS.length];
}

/**
 * A distinct synthetic client IP per VU. The backend's rate limiter keys on
 * the request IP (`trust proxy` is set in main.ts, so it honors
 * X-Forwarded-For from one hop), and the global default is 120 req/min PER
 * KEY (app.module.ts) — plenty for one real user, but a k6 run naturally
 * originates from a single machine/container, so without this every VU
 * would share one IP and the whole run would collapse into 429s almost
 * immediately, long before any real capacity limit was reached. This isn't
 * working around the limiter — it's what makes the test represent reality:
 * production traffic is many real users, each with their own IP, not one
 * client hammering the API from a single address.
 */
function vuIp() {
  const b = 10 + (__VU % 240);
  const c = Math.floor(__VU / 240) % 256;
  const d = (__VU % 250) + 1;
  return `10.${b}.${c}.${d}`;
}

// Logged in once per VU, then reused for every iteration that VU runs —
// see the throttle note at the top of this file for why.
let session = null;

function login() {
  const operatorSlug = operatorForVu(__VU);
  const devTelegramUserId = TEST_USER_BASE + __VU;

  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/auth/telegram`,
    JSON.stringify({ devTelegramUserId, operatorSlug }),
    { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': vuIp() }, tags: { name: 'login' } },
  );
  loginDuration.add(Date.now() - start);

  const ok = check(res, {
    'login: 200/201': (r) => r.status === 200 || r.status === 201,
    'login: has accessToken': (r) => {
      try {
        return !!JSON.parse(r.body).accessToken;
      } catch {
        return false;
      }
    },
  });
  loginErrors.add(!ok);
  if (res.status >= 500) unexpectedErrors.add(1);
  else unexpectedErrors.add(0);

  if (!ok) return null;

  const body = JSON.parse(res.body);
  return {
    accessToken: body.accessToken,
    operatorSlug,
    devTelegramUserId,
  };
}

function authHeaders(sess) {
  return { headers: { Authorization: `Bearer ${sess.accessToken}`, 'Content-Type': 'application/json', 'X-Forwarded-For': vuIp() } };
}

function loadLobby(sess) {
  const start = Date.now();
  const res = http.get(`${BASE_URL}/games/lobby`, { ...authHeaders(sess), tags: { name: 'lobby' } });
  lobbyDuration.add(Date.now() - start);

  check(res, { 'lobby: 200': (r) => r.status === 200 });
  if (res.status >= 500) unexpectedErrors.add(1);
  else unexpectedErrors.add(0);

  if (res.status !== 200) return null;
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

function purchaseCartela(sess, lobby) {
  if (!lobby || !lobby.game || !Array.isArray(lobby.room_list) || lobby.room_list.length === 0) return;
  const room = lobby.room_list[__VU % lobby.room_list.length];
  if (!room || !room.capacity) return;

  // Deliberately not tracking which numbers are taken client-side — the
  // whole point of this load pattern is many VUs racing for the same
  // small pool of numbers, exercising the row-lock + unique-constraint
  // backstop in CardsService.selectCartela under real contention.
  const cartelaNumber = 1 + ((__VU + __ITER) % room.capacity);

  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/cards/purchase`,
    JSON.stringify({ gameId: lobby.game.id, room: room.code, cartelaNumber }),
    { ...authHeaders(sess), tags: { name: 'cartela_purchase' } },
  );
  purchaseDuration.add(Date.now() - start);

  if (res.status === 201 || res.status === 200) {
    purchaseSuccess.add(1);
    purchaseErrors.add(0);
  } else if (res.status === 409) {
    // Another VU won the race for this number, or a business-rule reject
    // (limit reached) — expected under concurrent load, not a defect.
    purchaseTaken.add(1);
    purchaseErrors.add(0);
  } else if (res.status === 400) {
    // e.g. per-player cartela limit reached — expected business rejection.
    purchaseErrors.add(0);
  } else {
    purchaseErrors.add(1);
  }
  if (res.status >= 500) unexpectedErrors.add(1);
  else unexpectedErrors.add(0);
}

function submitDeposit(sess) {
  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/deposits`,
    JSON.stringify({
      amount: 50,
      // A tiny valid base64 payload is enough to exercise the upload/validation
      // path's size and magic-byte checks without shipping a real image fixture.
      receiptBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      telebirrReference: `LOADTEST-${__VU}-${__ITER}-${Date.now()}`.slice(0, 40),
    }),
    { ...authHeaders(sess), tags: { name: 'deposit_submit' } },
  );
  depositDuration.add(Date.now() - start);
  check(res, { 'deposit: 201/200/400': (r) => [200, 201, 400].includes(r.status) });
  if (res.status >= 500) unexpectedErrors.add(1);
  else unexpectedErrors.add(0);
}

function requestWithdrawal(sess) {
  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/withdrawals`,
    JSON.stringify({ amount: 20, telebirrAccount: '0900000000' }),
    { ...authHeaders(sess), tags: { name: 'withdrawal_request' } },
  );
  withdrawalDuration.add(Date.now() - start);
  // 400 (insufficient balance) is the expected outcome for fresh test
  // accounts with no won_balance — see the note at the top of this file.
  check(res, { 'withdrawal: 201/200/400': (r) => [200, 201, 400].includes(r.status) });
  if (res.status >= 500) unexpectedErrors.add(1);
  else unexpectedErrors.add(0);
}

function claimBingo(sess, lobby) {
  if (!lobby || !lobby.game) return;
  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/bingo/claim`,
    JSON.stringify({ playerId: `${lobby.game.id}:${sess.devTelegramUserId}` }),
    { ...authHeaders(sess), tags: { name: 'bingo_claim' } },
  );
  claimDuration.add(Date.now() - start);
  // Almost always a legitimate 400 ("not a winner"/"no cartela") under load
  // test conditions — this endpoint is included to measure its latency
  // under concurrent load, not to actually win games.
  check(res, { 'claim: handled (not 5xx)': (r) => r.status < 500 });
  if (res.status >= 500) unexpectedErrors.add(1);
  else unexpectedErrors.add(0);
}

export function setup() {
  console.log(`\nYENA Bingo load test`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`Operators exercised: ${OPERATOR_SLUGS.join(', ')}`);
  console.log(`Target VUs: ${VUS} (ramp ${RAMP_UP} / hold ${HOLD} / down ${RAMP_DOWN})`);
}

export default function () {
  if (!session) {
    session = login();
    if (!session) {
      sleep(1);
      return;
    }
  }

  const lobby = loadLobby(session);

  // Weighted action mix approximating real traffic: lobby polling and
  // cartela purchase dominate, deposits/withdrawals/claims are rarer.
  const roll = Math.random();
  if (roll < 0.5) {
    purchaseCartela(session, lobby);
  } else if (roll < 0.65) {
    submitDeposit(session);
  } else if (roll < 0.8) {
    requestWithdrawal(session);
  } else if (roll < 0.9) {
    claimBingo(session, lobby);
  }
  // remaining 10% is lobby-only polling, already done above.

  sleep(1 + Math.random() * 2);
}

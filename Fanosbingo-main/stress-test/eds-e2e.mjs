/*
  የኛ local E2E — drives the real edge functions + DB.
  Prereq: `supabase start` in the project (see docs/YENA_BINGO_LOCAL_SETUP.md).

    ANON=$(supabase status -o json | jq -r .ANON_KEY) \
    ADMIN_KEY=local-dev-admin-key-0123456789 \
    node stress-test/eds-e2e.mjs

  29 assertions: admin bootstrap/login, player sessions, manual Telebirr deposit
  (approve + no-double-credit), 4-cartela limit across BOTH rooms, pot + 80/20,
  cartela-taken, withdrawal hold/approve/mark-paid.
  Last run (2026-09-06): 29 passed, 0 failed.
*/
const URL = process.env.SUPA_URL || 'http://127.0.0.1:54321';
const ANON = process.env.ANON;
const ADMIN_KEY = process.env.ADMIN_KEY || 'local-dev-admin-key-0123456789';
if (!ANON) { console.error('set ANON'); process.exit(1); }

const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON}`, apikey: ANON };
const fn = (name, body, extra = {}) =>
  fetch(`${URL}/functions/v1/${name}`, { method: 'POST', headers: { ...H, ...extra }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const rpc = (name, args) =>
  fetch(`${URL}/rest/v1/rpc/${name}`, { method: 'POST', headers: H, body: JSON.stringify(args) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗', m)); };

const P1 = { id: 700001, first_name: 'Alice', username: 'alice' };
const P2 = { id: 700002, first_name: 'Bob', username: 'bob' };

console.log('\n== 1. admin bootstrap + login ==');
let r = await fn('admin-auth', { action: 'bootstrap', username: 'owner', password: 'ownerpass123', adminKey: ADMIN_KEY });
ok(r.body.success || r.body.error_code === 'ALREADY_BOOTSTRAPPED', `bootstrap (${r.body.error || 'ok'})`);
r = await fn('admin-auth', { action: 'login', username: 'owner', password: 'ownerpass123' });
ok(r.body.success && r.body.token, 'admin login');
const ADMIN = r.body.token;
const adminFn = (body) => fn('admin-finance', body, { 'X-Admin-Token': ADMIN });

console.log('\n== 2. player sessions ==');
r = await fn('player-session', { devUser: P1 });
ok(r.body.success && r.body.playerToken, `P1 session (bonus wallet: ${JSON.stringify(r.body.wallet)})`);
const T1 = r.body.playerToken;
r = await fn('player-session', { devUser: P2 });
const T2 = r.body.playerToken;
ok(!!T2, 'P2 session');

console.log('\n== 3. config ==');
r = await rpc('eds_config', {});
ok(r.body.standard_total_cartelas === 600 && r.body.max_cartelas_per_player === 4 && r.body.winner_percentage === 80,
   `config 600/4/80 (${JSON.stringify(r.body)})`);

console.log('\n== 4. give P1 balance via approved Telebirr deposit ==');
// tiny 1x1 png base64
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
r = await fn('submit-deposit', { telegramUserId: P1.id, amount: 500, telebirrReference: 'TESTREF-P1-001', receiptBase64: PNG }, { 'X-Player-Token': T1 });
ok(r.body.success, `deposit submitted (${r.body.error || r.body.depositId})`);
const depId = r.body.depositId;
r = await adminFn({ action: 'list_deposits', status: 'pending' });
ok(Array.isArray(r.body.deposits) && r.body.deposits.some((d) => d.id === depId), 'deposit visible to admin');
r = await adminFn({ action: 'review_deposit', depositId: depId, decision: 'approve' });
ok(r.body.success, `deposit approved (credited ${r.body.credited})`);
r = await adminFn({ action: 'review_deposit', depositId: depId, decision: 'approve' });
ok(!r.body.success, 'double-approve rejected (no double credit)');
r = await fn('my-finance', { telegramUserId: P1.id }, { 'X-Player-Token': T1 });
ok(r.body.wallet.total_balance >= 500, `P1 wallet after deposit: ${JSON.stringify(r.body.wallet)}`);

console.log('\n== 5. game + 4-cartela limit (both rooms) ==');
await rpc('ensure_waiting_game_exists', {});
r = await rpc('eds_lobby', { p_user: P1.id });
const gameId = r.body.game?.id;
ok(!!gameId, `active game ${gameId}`);
const buy = (room, n, tok = T1, name = 'Alice') =>
  fn('select-card', { gameId, room, cartelaNumber: n, telegramUserId: name === 'Alice' ? P1.id : P2.id, playerName: name }, { 'X-Player-Token': tok });
ok((await buy('etb5', 10)).body.success, 'P1 buy ETB5 #10');
ok((await buy('etb5', 11)).body.success, 'P1 buy ETB5 #11');
ok((await buy('etb10', 8)).body.success, 'P1 buy ETB10 #8');
ok((await buy('etb10', 9)).body.success, 'P1 buy ETB10 #9  (=4 total, both rooms)');
r = await buy('etb5', 12);
ok(!r.body.success && r.body.error_code === 'LIMIT_REACHED', `5th rejected: ${r.body.error}`);
r = await buy('etb10', 20);
ok(!r.body.success && r.body.error_code === 'LIMIT_REACHED', `5th (other room) rejected: ${r.body.error}`);
r = await buy('etb5', 401);
ok(!r.body.success && r.body.error_code === 'CARTELA_OUT_OF_RANGE', 'ETB5 #401 out of range');
r = await buy('etb10', 10, T2, 'Bob');
ok(r.body.success, 'P2 buy ETB10 #10 (P1 has ETB10 #10? no — shared number, different owner ok since P1 took #8/#9)');
r = await buy('etb10', 8, T2, 'Bob');
ok(!r.body.success && r.body.error_code === 'CARTELA_TAKEN', 'P2 cannot take P1 ETB10 #8');

console.log('\n== 6. pot + 80/20 ==');
r = await rpc('eds_lobby', { p_user: P1.id });
const pot = r.body.game.total_pot;
ok(pot === 2 * 5 + 2 * 10 + 10, `pot = ${pot} (P1: 2x5 + 2x10, P2: 1x10)`);

console.log('\n== 7. winner payout (P1 ETB10 #8) ==');
// force game to playing then finished with P1's cartela as winner
const player = (await rpc('eds_player_cartela_count', { p_game_id: gameId, p_user: P1.id })).body;
// need a player_id — read from lobby my_cartelas
r = await rpc('eds_lobby', { p_user: P1.id });
const winCartela = r.body.my_cartelas.find((c) => c.room === 'etb10' && c.number === 8);
const patch = (fields) => fetch(`${URL}/rest/v1/games?id=eq.${gameId}`, {
  method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(fields),
});
await patch({ status: 'playing', started_at: new Date().toISOString() });
await patch({ winner_ids: [winCartela.player_id] });
await patch({ status: 'finished', finished_at: new Date().toISOString() });
r = await fetch(`${URL}/rest/v1/games?id=eq.${gameId}&select=total_pot,winner_prize_amount,house_share_amount,winner_payouts`, { headers: H }).then((x) => x.json());
const g = r[0];
ok(g.winner_prize_amount === Math.floor(pot * 0.8) && g.house_share_amount === pot - g.winner_prize_amount,
   `pot ${g.total_pot} -> winner ${g.winner_prize_amount} / house ${g.house_share_amount}`);
ok(g.winner_payouts && g.winner_payouts[winCartela.player_id] === g.winner_prize_amount, 'winner_payouts has P1 full pool');

console.log('\n== 8. withdrawal hold -> approve -> mark paid ==');
r = await fn('my-finance', { telegramUserId: P1.id }, { 'X-Player-Token': T1 });
const wonBefore = r.body.wallet.won_balance;
ok(wonBefore >= g.winner_prize_amount, `P1 won_balance ${wonBefore}`);
r = await fn('request-withdrawal', { telegramUserId: P1.id, amount: Math.min(20, wonBefore), telebirrAccount: '0912345678' }, { 'X-Player-Token': T1 });
ok(r.body.success, `withdrawal requested (hold ${r.body.onHold})`);
const wid = r.body.withdrawalId;
r = await fn('my-finance', { telegramUserId: P1.id }, { 'X-Player-Token': T1 });
ok(r.body.wallet.won_balance === wonBefore - Math.min(20, wonBefore), `hold applied: won ${r.body.wallet.won_balance}`);
r = await adminFn({ action: 'review_withdrawal', withdrawalId: wid, decision: 'approve' });
ok(r.body.success, 'withdrawal approved');
r = await adminFn({ action: 'review_withdrawal', withdrawalId: wid, decision: 'mark_paid' });
ok(!r.body.success && r.body.error_code === 'REFERENCE_REQUIRED', 'mark_paid without ref rejected');
r = await adminFn({ action: 'review_withdrawal', withdrawalId: wid, decision: 'mark_paid', telebirrReference: 'TELEBIRR-OUT-999' });
ok(r.body.success, 'withdrawal marked paid with reference');

console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);

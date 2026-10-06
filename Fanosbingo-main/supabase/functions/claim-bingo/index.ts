// የኛ — claim BINGO on a cartela.
// Validation + winner_ids + disqualification are done atomically in
// atomic_claim_bingo(). Prize math + payouts + house share are done by the
// payout_winners() trigger when the game flips to 'finished' — this function
// never computes a prize.
import { corsHeaders, json, preflight, serviceClient } from '../_shared/yena_bingo.ts';
import { notifyPlayer } from '../_shared/notify.ts';
import { botT, playerLang } from '../_shared/i18n.ts';

const CLAIM_WINDOW_MS = 1000;

// deno-lint-ignore no-explicit-any
const waitUntil = (p: Promise<unknown>) => {
  try {
    (globalThis as any).EdgeRuntime?.waitUntil?.(p);
  } catch {
    /* fall through — the promise still runs, just may be cut short */
  }
};

async function finalizeAndNotify() {
  const supabase = serviceClient();
  await new Promise((r) => setTimeout(r, CLAIM_WINDOW_MS + 150));

  const { data: game } = await supabase
    .from('games')
    .select('id, status, claim_window_start')
    .eq('status', 'playing')
    .not('claim_window_start', 'is', null)
    .maybeSingle();
  if (!game) return;

  if (Date.now() - new Date(game.claim_window_start).getTime() < CLAIM_WINDOW_MS) return;

  const finishedAt = new Date();
  // Flip to finished — the payout_winners() BEFORE-UPDATE trigger fills in
  // game_pot / winner_prize_amount / house_share_amount / winner_payouts and
  // credits the ledger.
  const { data: finished } = await supabase
    .from('games')
    .update({
      status: 'finished',
      finished_at: finishedAt.toISOString(),
      return_to_lobby_at: new Date(finishedAt.getTime() + 7000).toISOString(),
    })
    .eq('id', game.id)
    .eq('status', 'playing')
    .select('id, winner_payouts')
    .maybeSingle();

  if (!finished?.winner_payouts) return;

  const payouts = finished.winner_payouts as Record<string, number>;
  for (const [pid, amount] of Object.entries(payouts)) {
    const { data: player } = await supabase
      .from('players').select('telegram_user_id').eq('id', pid).maybeSingle();
    const lang = await playerLang(supabase, player?.telegram_user_id);
    await notifyPlayer(
      supabase, player?.telegram_user_id,
      botT(lang, 'notify.winner', { amount }),
    );
  }
}

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  try {
    const supabase = serviceClient();
    const { playerId } = await req.json();
    if (!playerId) return json({ error: 'Player ID is required' }, 400);

    const { data: result, error } = await supabase.rpc('atomic_claim_bingo', {
      p_player_id: playerId,
      p_claim_window_ms: CLAIM_WINDOW_MS,
    });
    if (error) return json({ error: 'Failed to process claim' }, 500);
    if (result?.error) return json({ error: result.error }, 400);

    if (result?.isFirstClaim) {
      waitUntil(finalizeAndNotify());
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Internal server error' }, 500);
  }
});

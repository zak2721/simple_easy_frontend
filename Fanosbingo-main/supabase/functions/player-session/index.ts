/*
  የኛ — resolve the current player from a Telegram Mini App session.

  Body: { initData }  (the signed Telegram.WebApp.initData string)
  In dev, if ALLOW_UNVERIFIED_TELEGRAM=true you may instead pass { devUser: {id, first_name, username} }.

  Returns: { user, wallet, config, playerToken }  — playerToken is required by the
  financial player endpoints (submit-deposit, request-withdrawal, my-finance).
*/
import { json, preflight, serviceClient } from '../_shared/yena_bingo.ts';
import { verifyInitData, makePlayerToken } from '../_shared/telegram.ts';

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  try {
    const body = await req.json();
    const supabase = serviceClient();

    const { data: tokenRow } = await supabase.from('settings').select('value').eq('id', 'telegram_bot_token').maybeSingle();
    const botToken = tokenRow?.value || Deno.env.get('TELEGRAM_BOT_TOKEN') || '';

    let user = body.initData ? await verifyInitData(body.initData, botToken) : null;

    if (!user && Deno.env.get('ALLOW_UNVERIFIED_TELEGRAM') === 'true' && body.devUser?.id) {
      user = body.devUser;
    }

    if (!user?.id) {
      return json({ error: 'Could not verify your Telegram session. Open የኛ bingo from the bot.' }, 401);
    }

    const { data, error } = await supabase.rpc('eds_ensure_player', {
      p_user: user.id,
      p_username: user.username ?? null,
      p_first_name: user.first_name ?? null,
      p_last_name: user.last_name ?? null,
    });
    if (error) return json({ error: error.message }, 500);

    const playerToken = await makePlayerToken(user.id);
    return json({ success: true, playerToken, ...data });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Internal error' }, 500);
  }
});

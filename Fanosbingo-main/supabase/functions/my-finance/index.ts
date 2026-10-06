// የኛ — player's own wallet + deposit/withdrawal history + Telebirr account.
// Body: { telegramUserId, limit? }
import { json, preflight, serviceClient } from '../_shared/yena_bingo.ts';
import { resolvePlayer } from '../_shared/telegram.ts';

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  try {
    const body = await req.json().catch(() => ({}));
    const telegramUserId = await resolvePlayer(req, body);
    if (!telegramUserId || telegramUserId <= 0) return json({ error: 'Telegram user required' }, 403);

    const supabase = serviceClient();
    const [{ data: finance, error }, { data: account }] = await Promise.all([
      supabase.rpc('eds_my_finance', { p_user: telegramUserId, p_limit: Number(body.limit) || 30 }),
      supabase.rpc('eds_telebirr_account'),
    ]);

    if (error) return json({ error: error.message }, 500);
    return json({ success: true, ...finance, telebirr: account });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Internal error' }, 500);
  }
});

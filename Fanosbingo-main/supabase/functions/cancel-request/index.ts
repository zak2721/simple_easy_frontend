// የኛ — player cancels their own PENDING deposit or withdrawal request.
// Body: { kind: 'deposit'|'withdrawal', id }  + player token
import { json, preflight, serviceClient } from '../_shared/yena_bingo.ts';
import { resolvePlayer } from '../_shared/telegram.ts';

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  try {
    const body = await req.json();
    const user = await resolvePlayer(req, body);
    if (!user) return json({ error: 'Telegram session required' }, 403);
    if (!body.id || (body.kind !== 'deposit' && body.kind !== 'withdrawal')) {
      return json({ error: 'kind and id required' }, 400);
    }

    const supabase = serviceClient();
    const rpc = body.kind === 'deposit' ? 'eds_cancel_deposit' : 'eds_cancel_withdrawal';
    const arg = body.kind === 'deposit' ? { p_deposit_id: body.id, p_user: user } : { p_id: body.id, p_user: user };

    const { data, error } = await supabase.rpc(rpc, arg);
    if (error) return json({ error: error.message }, 500);
    return json(data, data?.success ? 200 : 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Internal error' }, 500);
  }
});

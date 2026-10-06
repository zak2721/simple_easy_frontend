// የኛ — player requests a manual Telebirr withdrawal (places a hold).
// Body: { telegramUserId, amount, telebirrAccount }
import { json, preflight, serviceClient } from '../_shared/yena_bingo.ts';
import { resolvePlayer } from '../_shared/telegram.ts';

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  try {
    const body = await req.json();
    const telegramUserId = await resolvePlayer(req, body);
    const amount = Number(body.amount);
    const telebirrAccount: string = (body.telebirrAccount ?? body.account ?? '').toString().trim();

    if (!telegramUserId || telegramUserId <= 0) {
      return json({ error: 'Open የኛ bingo from Telegram to withdraw.' }, 403);
    }
    if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'Enter a valid amount.' }, 400);
    if (!telebirrAccount) return json({ error: 'Enter your Telebirr phone/account number.' }, 400);

    const supabase = serviceClient();
    const { data, error } = await supabase.rpc('eds_request_withdrawal', {
      p_user: telegramUserId,
      p_amount: amount,
      p_telebirr_account: telebirrAccount,
    });

    if (error) return json({ error: error.message }, 500);
    if (!data?.success) {
      const code = data?.error_code;
      const status = code === 'PENDING_EXISTS' ? 409 : code === 'INSUFFICIENT_WINNINGS' ? 402 : 400;
      return json({ error: data?.error ?? 'Could not request withdrawal', error_code: code, ...data }, status);
    }

    return json({
      success: true,
      withdrawalId: data.withdrawal_id,
      status: 'pending',
      onHold: data.on_hold,
      message: 'Withdrawal requested. An admin will send your Telebirr payment and mark it paid.',
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Internal error' }, 500);
  }
});

// የኛ — player submits a manual Telebirr deposit for admin review.
// Body: { telegramUserId, amount, telebirrReference, receiptBase64 }
import { json, preflight, serviceClient } from '../_shared/yena_bingo.ts';
import { resolvePlayer } from '../_shared/telegram.ts';
import { validateReceipt, storeReceipt } from '../_shared/receipts.ts';

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  try {
    const body = await req.json();
    const telegramUserId = await resolvePlayer(req, body);
    const amount = Number(body.amount);
    const reference: string = (body.telebirrReference ?? body.reference ?? '').toString().trim();

    if (!telegramUserId || telegramUserId <= 0) {
      return json({ error: 'Open የኛ bingo from Telegram to deposit.' }, 403);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: 'Enter a valid deposit amount.' }, 400);
    }
    if (reference.length < 4) {
      return json({ error: 'Enter the Telebirr transaction / reference number.' }, 400);
    }

    const receipt = validateReceipt(body.receiptBase64);
    if (!receipt.ok) return json({ error: receipt.error }, 400);

    const supabase = serviceClient();
    const stored = await storeReceipt(supabase, String(telegramUserId), receipt);

    const { data, error } = await supabase.rpc('eds_submit_deposit', {
      p_user: telegramUserId,
      p_amount: amount,
      p_reference: reference,
      p_receipt_path: stored.path,
      p_receipt_type: stored.type,
    });

    if (error) return json({ error: error.message }, 500);
    if (!data?.success) {
      const status = data?.error_code === 'DUPLICATE' ? 409 : 400;
      return json({ error: data?.error ?? 'Could not submit deposit', error_code: data?.error_code }, status);
    }

    return json({
      success: true,
      depositId: data.deposit_id,
      status: 'pending',
      message: 'Deposit submitted. An admin will verify your Telebirr payment and credit your wallet.',
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Internal error' }, 500);
  }
});

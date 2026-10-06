/*
  የኛ — authorized access to a receipt / payment-proof file.

  A player may fetch the receipt for THEIR OWN deposit.
  An admin with `receipts.view` may fetch any receipt or withdrawal proof.
  Returns a short-lived signed URL to the private `receipts` bucket.

  Body: { kind: 'deposit'|'withdrawal', id, telegramUserId? , adminToken?/adminKey? }
*/
import { json, preflight, serviceClient, requireAdmin, isResponse } from '../_shared/yena_bingo.ts';

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  try {
    const body = await req.json();
    const kind: string = body.kind;
    const id: string = body.id;
    if (!id || (kind !== 'deposit' && kind !== 'withdrawal')) {
      return json({ error: 'kind (deposit|withdrawal) and id are required' }, 400);
    }

    const supabase = serviceClient();
    let path: string | null = null;

    if (kind === 'deposit') {
      const { data } = await supabase
        .from('manual_deposits')
        .select('telegram_user_id, receipt_file_path')
        .eq('id', id)
        .maybeSingle();
      if (!data) return json({ error: 'Deposit not found' }, 404);
      path = data.receipt_file_path;

      const asOwner = Number(body.telegramUserId) === Number(data.telegram_user_id);
      if (!asOwner) {
        const admin = await requireAdmin(req, body, 'receipts.view');
        if (isResponse(admin)) return admin;
      }
    } else {
      // withdrawal proof — admin only
      const admin = await requireAdmin(req, body, 'receipts.view');
      if (isResponse(admin)) return admin;
      const { data } = await supabase
        .from('withdrawal_requests')
        .select('payment_proof_file_path')
        .eq('id', id)
        .maybeSingle();
      if (!data) return json({ error: 'Withdrawal not found' }, 404);
      path = data.payment_proof_file_path;
    }

    if (!path) return json({ error: 'No file attached' }, 404);

    const { data: signed, error } = await supabase.storage
      .from('receipts')
      .createSignedUrl(path, 120);
    if (error) return json({ error: error.message }, 500);

    return json({ success: true, url: signed.signedUrl, expiresIn: 120 });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Internal error' }, 500);
  }
});

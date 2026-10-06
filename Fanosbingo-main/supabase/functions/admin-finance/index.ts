/*
  የኛ — admin financial operations (RBAC-gated, audited in SQL).

  Body: { action, adminToken?/adminKey?, ...params }
    dashboard
    cartelas
    list_deposits     { status?, limit?, cursor? }
    review_deposit    { depositId, decision: 'approve'|'reject', rejectionReason?, adminNote? }
    list_withdrawals  { status?, limit? }
    review_withdrawal { withdrawalId, decision: 'approve'|'reject'|'mark_paid',
                        telebirrReference?, proofBase64?, rejectionReason?, adminNote? }
    list_ledger       { entryType?, userId?, limit? }
    list_audit        { limit? }
    player_cartelas   { userId }
*/
import { json, preflight, serviceClient, requireAdmin, isResponse } from '../_shared/yena_bingo.ts';
import { validateReceipt, storeReceipt } from '../_shared/receipts.ts';
import { notifyPlayer } from '../_shared/notify.ts';
import { botT, playerLang } from '../_shared/i18n.ts';

const PERM: Record<string, string> = {
  dashboard: 'dashboard.view',
  cartelas: 'cartelas.view',
  list_deposits: 'deposits.view',
  review_deposit: 'deposits.review',
  list_withdrawals: 'withdrawals.view',
  review_withdrawal: 'withdrawals.review',
  list_ledger: 'transactions.view',
  list_audit: 'audit.view',
  player_cartelas: 'cartelas.view',
};

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  try {
    const body = await req.json();
    const action: string = body.action;
    const perm = PERM[action];
    if (!perm) return json({ error: 'Unknown action' }, 400);

    const admin = await requireAdmin(req, body, perm);
    if (isResponse(admin)) return admin;

    const supabase = serviceClient();

    switch (action) {
      case 'dashboard': {
        const { data, error } = await supabase.rpc('eds_admin_dashboard');
        return error ? json({ error: error.message }, 500) : json({ success: true, dashboard: data });
      }
      case 'cartelas': {
        const { data, error } = await supabase.rpc('eds_admin_cartelas', { p_game_id: body.gameId ?? null });
        return error ? json({ error: error.message }, 500) : json({ success: true, cartelas: data });
      }
      case 'player_cartelas': {
        const { data, error } = await supabase.rpc('eds_admin_player_cartelas', {
          p_user: Number(body.userId), p_game_id: body.gameId ?? null,
        });
        return error ? json({ error: error.message }, 500) : json({ success: true, ...data });
      }
      case 'list_deposits': {
        let q = supabase.from('manual_deposits')
          .select('id, telegram_user_id, amount, telebirr_transaction_reference, receipt_file_type, status, rejection_reason, admin_note, submitted_at, reviewed_at, reviewed_by')
          .order('submitted_at', { ascending: false })
          .limit(Math.min(Number(body.limit) || 50, 200));
        if (body.status) q = q.eq('status', body.status);
        const { data, error } = await q;
        return error ? json({ error: error.message }, 500) : json({ success: true, deposits: data });
      }
      case 'review_deposit': {
        const { data, error } = await supabase.rpc('eds_review_deposit', {
          p_deposit_id: body.depositId,
          p_admin: admin.username,
          p_action: body.decision,
          p_rejection_reason: body.rejectionReason ?? null,
          p_admin_note: body.adminNote ?? null,
        });
        if (error) return json({ error: error.message }, 500);
        if (data?.success) {
          const { data: d } = await supabase
            .from('manual_deposits')
            .select('telegram_user_id, amount, rejection_reason')
            .eq('id', body.depositId).maybeSingle();
          if (d) {
            const lang = await playerLang(supabase, d.telegram_user_id);
            await notifyPlayer(
              supabase, d.telegram_user_id,
              body.decision === 'approve'
                ? botT(lang, 'notify.depositApproved', { amount: d.amount })
                : botT(lang, 'notify.depositRejected', { amount: d.amount, reason: d.rejection_reason ?? '—' }),
            );
          }
        }
        return json(data, data?.success ? 200 : 400);
      }
      case 'list_withdrawals': {
        let q = supabase.from('withdrawal_requests')
          .select('id, telegram_user_id, amount, telebirr_account, account_number, status, rejection_reason, admin_notes, telebirr_transaction_reference, requested_at, reviewed_at, reviewed_by, paid_at')
          .order('requested_at', { ascending: false })
          .limit(Math.min(Number(body.limit) || 50, 200));
        if (body.status) q = q.eq('status', body.status);
        const { data, error } = await q;
        return error ? json({ error: error.message }, 500) : json({ success: true, withdrawals: data });
      }
      case 'review_withdrawal': {
        let proofPath: string | null = null;
        if (body.decision === 'mark_paid' && body.proofBase64) {
          const r = validateReceipt(body.proofBase64);
          if (!r.ok) return json({ error: r.error }, 400);
          const stored = await storeReceipt(supabase, `withdrawal-proof/${body.withdrawalId}`, r);
          proofPath = stored.path;
        }
        const { data, error } = await supabase.rpc('eds_review_withdrawal', {
          p_id: body.withdrawalId,
          p_admin: admin.username,
          p_action: body.decision,
          p_telebirr_reference: body.telebirrReference ?? null,
          p_proof_path: proofPath,
          p_reason: body.rejectionReason ?? null,
          p_admin_note: body.adminNote ?? null,
        });
        if (error) return json({ error: error.message }, 500);
        if (data?.success) {
          const { data: w } = await supabase
            .from('withdrawal_requests')
            .select('telegram_user_id, amount, rejection_reason, telebirr_transaction_reference')
            .eq('id', body.withdrawalId).maybeSingle();
          if (w) {
            const lang = await playerLang(supabase, w.telegram_user_id);
            const msg =
              body.decision === 'mark_paid'
                ? botT(lang, 'notify.withdrawalPaid', { amount: w.amount, reference: w.telebirr_transaction_reference ?? '—' })
                : body.decision === 'approve'
                ? botT(lang, 'notify.withdrawalApproved', { amount: w.amount })
                : botT(lang, 'notify.withdrawalRejected', { amount: w.amount, reason: w.rejection_reason ?? '—' });
            await notifyPlayer(supabase, w.telegram_user_id, msg);
          }
        }
        return json(data, data?.success ? 200 : 400);
      }
      case 'list_ledger': {
        let q = supabase.from('wallet_ledger')
          .select('id, telegram_user_id, entry_type, direction, amount, note, related_game_id, created_at, created_by')
          .order('created_at', { ascending: false })
          .limit(Math.min(Number(body.limit) || 100, 500));
        if (body.entryType) q = q.eq('entry_type', body.entryType);
        if (body.userId) q = q.eq('telegram_user_id', Number(body.userId));
        const { data, error } = await q;
        return error ? json({ error: error.message }, 500) : json({ success: true, ledger: data });
      }
      case 'list_audit': {
        const { data, error } = await supabase.from('audit_logs')
          .select('*').order('created_at', { ascending: false })
          .limit(Math.min(Number(body.limit) || 100, 500));
        return error ? json({ error: error.message }, 500) : json({ success: true, audit: data });
      }
    }
    return json({ error: 'Unhandled action' }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Internal error' }, 500);
  }
});

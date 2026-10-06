import { useCallback, useEffect, useState } from 'react';
import { adminApi, WithdrawalRow, fileToBase64 } from '../adminApi';
import { formatEtb } from '../../lib/format';
import { API_BASE_URL } from '../../lib/api-client';

/** Signed proof paths are backend-relative (e.g. "/api/storage/receipts/...") — resolve against the API origin, not the frontend's. */
function toAbsoluteApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const apiOrigin = new URL(API_BASE_URL).origin;
  return `${apiOrigin}${path}`;
}

export function AdminWithdrawals({ role, permissions }: { role: string; permissions: string[] }) {
  const [status, setStatus] = useState('pending');
  const [rows, setRows] = useState<WithdrawalRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isSuperAdmin = role === 'SUPER_ADMIN';
  const canApprove = isSuperAdmin || permissions.includes('APPROVE_WITHDRAWALS');
  const canReject = isSuperAdmin || permissions.includes('REJECT_WITHDRAWALS');
  const canReview = canApprove || canReject;

  const load = useCallback(() => {
    adminApi.listWithdrawals(status || undefined).then((r) => setRows(r.withdrawals)).catch((e) => setErr(e.message));
  }, [status]);
  useEffect(() => { load(); }, [load]);

  const approve = async (r: WithdrawalRow) => {
    if (!window.confirm(`Approve withdrawal of ${formatEtb(r.amount)}?`)) return;
    setBusy(r.id);
    try { await adminApi.reviewWithdrawal(r.id, 'approve', {}); load(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(null); }
  };

  const reject = async (r: WithdrawalRow) => {
    const reason = window.prompt('Rejection reason (required):') || '';
    if (!reason) return;
    setBusy(r.id);
    try { await adminApi.reviewWithdrawal(r.id, 'reject', { rejectionReason: reason }); load(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(null); }
  };

  const markPaid = async (r: WithdrawalRow) => {
    if (!window.confirm(`Confirm you have manually sent ${formatEtb(r.amount)} via Telebirr to ${r.telebirr_account ?? r.account_number}?`)) return;
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/jpeg,application/pdf';
    fileInput.onchange = async () => {
      setBusy(r.id);
      try {
        const proofBase64 = fileInput.files?.[0] ? await fileToBase64(fileInput.files[0]) : undefined;
        await adminApi.reviewWithdrawal(r.id, 'mark_paid', { proofBase64 });
        load();
      } catch (e) {
        alert(e instanceof Error ? e.message : 'Failed');
      } finally {
        setBusy(null);
      }
    };
    // proof optional — allow cancel to still submit without it
    if (window.confirm('Attach a payment screenshot/PDF? (Cancel to submit without proof)')) {
      fileInput.click();
    } else {
      setBusy(r.id);
      adminApi.reviewWithdrawal(r.id, 'mark_paid', {})
        .then(load).catch((e) => alert(e instanceof Error ? e.message : 'Failed')).finally(() => setBusy(null));
    }
  };

  const viewProof = async (r: WithdrawalRow) => {
    try {
      const { url } = await adminApi.withdrawalProofUrl(r.id);
      if (!url) throw new Error('No proof on file');
      window.open(toAbsoluteApiUrl(url), '_blank');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'No proof');
    }
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-xl font-bold">Withdrawals</h1>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1 text-sm">
          {['pending', 'approved', 'paid', 'rejected', 'cancelled', ''].map((s) => <option key={s} value={s}>{s || 'all'}</option>)}
        </select>
      </div>
      {err && <p className="text-red-500">{err}</p>}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">User</th><th className="px-3 py-2">Amount</th><th className="px-3 py-2">Telebirr acct</th>
              <th className="px-3 py-2">Notes</th><th className="px-3 py-2">Requested</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Proof</th>
              {canReview && <th className="px-3 py-2">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-3 py-2">{r.telegram_user_id}</td>
                <td className="px-3 py-2 font-semibold">{formatEtb(r.amount)}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.telebirr_account ?? r.account_number}</td>
                <td className="px-3 py-2 max-w-[16rem] truncate text-slate-500" title={r.notes}>{r.notes || '—'}</td>
                <td className="px-3 py-2 text-slate-400">{new Date(r.requested_at).toLocaleString()}</td>
                <td className="px-3 py-2">
                  {r.status}
                  {r.rejection_reason ? ` — ${r.rejection_reason}` : ''}
                </td>
                <td className="px-3 py-2">
                  {r.status === 'paid' ? <button onClick={() => viewProof(r)} className="text-emerald-600 underline">view</button> : '—'}
                </td>
                {canReview && (
                  <td className="px-3 py-2">
                    <span className="flex flex-wrap gap-1.5">
                      {r.status === 'pending' && (
                        <>
                          {canApprove && <button disabled={busy === r.id} onClick={() => approve(r)} className="rounded bg-sky-600 px-2 py-1 text-xs text-white">Approve</button>}
                          {canReject && <button disabled={busy === r.id} onClick={() => reject(r)} className="rounded bg-red-500 px-2 py-1 text-xs text-white">Reject</button>}
                        </>
                      )}
                      {r.status === 'approved' && (
                        <>
                          {canApprove && <button disabled={busy === r.id} onClick={() => markPaid(r)} className="rounded bg-emerald-600 px-2 py-1 text-xs text-white">Mark paid</button>}
                          {canReject && <button disabled={busy === r.id} onClick={() => reject(r)} className="rounded bg-red-500 px-2 py-1 text-xs text-white">Reject</button>}
                        </>
                      )}
                    </span>
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">Nothing here</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

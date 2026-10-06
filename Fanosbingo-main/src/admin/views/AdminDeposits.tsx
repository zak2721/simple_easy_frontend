import { useCallback, useEffect, useState } from 'react';
import { adminApi, DepositRow } from '../adminApi';
import { formatEtb } from '../../lib/format';
import { API_BASE_URL } from '../../lib/api-client';

/** Signed receipt paths are backend-relative (e.g. "/api/storage/receipts/...") — resolve against the API origin, not the frontend's. */
function toAbsoluteApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const apiOrigin = new URL(API_BASE_URL).origin;
  return `${apiOrigin}${path}`;
}

export function AdminDeposits({ role, permissions }: { role: string; permissions: string[] }) {
  const [status, setStatus] = useState('pending');
  const [rows, setRows] = useState<DepositRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isSuperAdmin = role === 'SUPER_ADMIN';
  const canApprove = isSuperAdmin || permissions.includes('APPROVE_DEPOSITS');
  const canReject = isSuperAdmin || permissions.includes('REJECT_DEPOSITS');
  const canReview = canApprove || canReject;

  const load = useCallback(() => {
    adminApi.listDeposits(status || undefined).then((r) => setRows(r.deposits)).catch((e) => setErr(e.message));
  }, [status]);
  useEffect(() => { load(); }, [load]);

  const review = async (row: DepositRow, decision: 'approve' | 'reject') => {
    let reason: string | undefined;
    if (decision === 'reject') {
      reason = window.prompt('Rejection reason (required):') || undefined;
      if (!reason) return;
    } else if (!window.confirm(`Approve ${formatEtb(row.amount)} for user ${row.telegram_user_id}? This credits their wallet once.`)) {
      return;
    }
    setBusy(row.id);
    try {
      await adminApi.reviewDeposit(row.id, decision, reason);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const viewReceipt = async (row: DepositRow) => {
    try {
      const { url } = await adminApi.receiptUrl(row.id);
      if (!url) throw new Error('No receipt on file');
      window.open(toAbsoluteApiUrl(url), '_blank');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'No receipt');
    }
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-xl font-bold">Deposits</h1>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1 text-sm">
          {['pending', 'approved', 'rejected', 'cancelled', ''].map((s) => <option key={s} value={s}>{s || 'all'}</option>)}
        </select>
      </div>
      {err && <p className="text-red-500">{err}</p>}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">User</th><th className="px-3 py-2">Amount</th><th className="px-3 py-2">Telebirr Ref</th><th className="px-3 py-2">Notes</th>
              <th className="px-3 py-2">Submitted</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Receipt</th>
              {canReview && <th className="px-3 py-2">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-3 py-2">{r.telegram_user_id}</td>
                <td className="px-3 py-2 font-semibold">{formatEtb(r.amount)}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.telebirr_reference || '—'}</td>
                <td className="px-3 py-2 max-w-[16rem] truncate text-slate-500" title={r.notes}>{r.notes || '—'}</td>
                <td className="px-3 py-2 text-slate-400">{new Date(r.submitted_at).toLocaleString()}</td>
                <td className="px-3 py-2">{r.status}{r.rejection_reason ? ` — ${r.rejection_reason}` : ''}</td>
                <td className="px-3 py-2"><button onClick={() => viewReceipt(r)} className="text-emerald-600 underline">view</button></td>
                {canReview && (
                  <td className="px-3 py-2">
                    {r.status === 'pending' && (
                      <span className="flex gap-2">
                        {canApprove && <button disabled={busy === r.id} onClick={() => review(r, 'approve')} className="rounded bg-emerald-600 px-2 py-1 text-xs text-white">Approve</button>}
                        {canReject && <button disabled={busy === r.id} onClick={() => review(r, 'reject')} className="rounded bg-red-500 px-2 py-1 text-xs text-white">Reject</button>}
                      </span>
                    )}
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

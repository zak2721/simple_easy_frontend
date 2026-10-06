import { useEffect, useState } from 'react';
import { adminApi, ReferralReport } from '../adminApi';

export function AdminReferralReports({ role, permissions }: { role: string; permissions: string[] }) {
  const canView = role === 'SUPER_ADMIN' || permissions.includes('VIEW_REFERRAL_REPORTS');
  const canExport = role === 'SUPER_ADMIN' || permissions.includes('EXPORT_REPORTS');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [report, setReport] = useState<ReferralReport | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!canView) return;
    adminApi.referralReports(from || undefined, to || undefined).then(setReport).catch((e) => setErr(e.message));
  }, [canView, from, to]);

  if (!canView) return <p className="text-slate-500">You don't have permission to view referral reports.</p>;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-xl font-bold">Referral Reports</h1>
        {canExport && (
          <button
            onClick={() => adminApi.downloadReferralReportCsv(from || undefined, to || undefined).catch((e) => alert(e.message))}
            className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white"
          >
            Export CSV
          </button>
        )}
      </div>

      <div className="mb-4 flex items-end gap-2">
        <label className="text-xs text-slate-500">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 block rounded-lg border border-slate-300 px-2 py-1 text-sm" />
        </label>
        <label className="text-xs text-slate-500">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 block rounded-lg border border-slate-300 px-2 py-1 text-sm" />
        </label>
      </div>

      {err && <p className="text-sm text-red-500">{err}</p>}
      {!report && !err && <p className="text-slate-500">Loading…</p>}

      {report && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs text-slate-500">Total referrals</p>
              <p className="mt-1 text-2xl font-bold">{report.total_referrals}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs text-slate-500">Total rewards paid</p>
              <p className="mt-1 text-2xl font-bold">{report.total_rewards_paid_etb.toFixed(2)} ETB</p>
            </div>
          </div>

          <h2 className="mb-2 text-sm font-bold">Top referrers</h2>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="px-3 py-2">Telegram ID</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Successful referrals</th>
                </tr>
              </thead>
              <tbody>
                {report.top_referrers.length === 0 && (
                  <tr><td colSpan={3} className="px-3 py-4 text-center text-slate-400">No referrals in this range.</td></tr>
                )}
                {report.top_referrers.map((r, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">{r.telegram_user_id ?? '—'}</td>
                    <td className="px-3 py-2">{r.name || '—'}</td>
                    <td className="px-3 py-2">{r.successful_referrals}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

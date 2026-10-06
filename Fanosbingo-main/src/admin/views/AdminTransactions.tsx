import { useCallback, useEffect, useState } from 'react';
import { adminApi, LedgerRow } from '../adminApi';
import { formatEtb } from '../../lib/format';

const TYPES = ['', 'MANUAL_TELEBIRR_DEPOSIT', 'GAME_ENTRY', 'WINNING_CREDIT', 'WITHDRAWAL_HOLD', 'WITHDRAWAL_PAID', 'WITHDRAWAL_RELEASE', 'REFUND', 'HOUSE_REVENUE', 'ADJUSTMENT'];

export function AdminTransactions() {
  const [type, setType] = useState('');
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi.ledger(type || undefined).then((r) => setRows(r.ledger)).catch((e) => setErr(e.message));
  }, [type]);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-xl font-bold">Transactions (wallet ledger)</h1>
        <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1 text-sm">
          {TYPES.map((t) => <option key={t} value={t}>{t || 'all types'}</option>)}
        </select>
      </div>
      {err && <p className="text-red-500">{err}</p>}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr><th className="px-3 py-2">Type</th><th className="px-3 py-2">User</th><th className="px-3 py-2">Dir</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Note</th><th className="px-3 py-2">When</th></tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id} className="border-t border-slate-100">
                <td className="px-3 py-2">{l.entry_type.replace(/_/g, ' ').toLowerCase()}</td>
                <td className="px-3 py-2">{l.telegram_user_id ?? 'house'}</td>
                <td className="px-3 py-2">{l.direction}</td>
                <td className="px-3 py-2 text-right font-semibold">{formatEtb(l.amount)}</td>
                <td className="px-3 py-2 text-slate-500">{l.note}</td>
                <td className="px-3 py-2 text-slate-400">{new Date(l.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

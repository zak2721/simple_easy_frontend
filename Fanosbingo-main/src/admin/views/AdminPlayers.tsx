import { useCallback, useEffect, useState } from 'react';
import { adminApi, PlayerRow } from '../adminApi';
import { formatEtb } from '../../lib/format';

/**
 * Audit finding ADMIN-1 (Critical): setPlayerStatus/EDIT_USERS has existed
 * on the backend all session with zero UI — ops had no way to suspend or
 * ban a player without a raw API call. This is that missing UI.
 */
export function AdminPlayers({ role, permissions }: { role: string; permissions: string[] }) {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<PlayerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const isSuperAdmin = role === 'SUPER_ADMIN';
  const canEdit = isSuperAdmin || permissions.includes('EDIT_USERS');

  const load = useCallback(() => {
    adminApi.listPlayers({ status: status || undefined, search: search || undefined, take: 100 })
      .then((r) => { setRows(r.players); setTotal(r.total); })
      .catch((e) => setErr(e.message));
  }, [status, search]);
  useEffect(() => { load(); }, [load]);

  const changeStatus = async (row: PlayerRow, newStatus: 'active' | 'suspended' | 'banned') => {
    const verb = newStatus === 'active' ? 'reactivate' : newStatus;
    const reason = window.prompt(
      `Reason to ${verb} player ${row.telegram_user_id} (${row.username || row.first_name || 'no name'}) — required, at least 3 characters:`,
    );
    if (!reason || reason.trim().length < 3) return;
    setBusy(row.telegram_user_id);
    try {
      await adminApi.setPlayerStatus(row.telegram_user_id, newStatus, reason.trim());
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Players</h1>
        <div className="flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search username / first name"
            className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
          />
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1 text-sm">
            {['', 'active', 'suspended', 'banned'].map((s) => <option key={s} value={s}>{s || 'all statuses'}</option>)}
          </select>
        </div>
      </div>
      {err && <p className="text-red-500">{err}</p>}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Telegram ID</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Balance</th><th className="px-3 py-2">Joined</th>
              {canEdit && <th className="px-3 py-2">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.telegram_user_id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-mono text-xs">{r.telegram_user_id}</td>
                <td className="px-3 py-2">{r.username || r.first_name || '—'}</td>
                <td className="px-3 py-2">
                  <StatusBadge status={r.status} />
                  {r.status_reason && <span className="ml-2 text-xs text-slate-400" title={r.status_reason}>({r.status_reason})</span>}
                </td>
                <td className="px-3 py-2 font-semibold">{formatEtb(r.total_balance)}</td>
                <td className="px-3 py-2 text-slate-400">{new Date(r.created_at).toLocaleDateString()}</td>
                {canEdit && (
                  <td className="px-3 py-2">
                    <span className="flex gap-2">
                      {r.status !== 'active' && (
                        <button disabled={busy === r.telegram_user_id} onClick={() => changeStatus(r, 'active')} className="rounded bg-emerald-600 px-2 py-1 text-xs text-white">
                          Reactivate
                        </button>
                      )}
                      {r.status !== 'suspended' && (
                        <button disabled={busy === r.telegram_user_id} onClick={() => changeStatus(r, 'suspended')} className="rounded bg-amber-500 px-2 py-1 text-xs text-white">
                          Suspend
                        </button>
                      )}
                      {r.status !== 'banned' && (
                        <button disabled={busy === r.telegram_user_id} onClick={() => changeStatus(r, 'banned')} className="rounded bg-red-600 px-2 py-1 text-xs text-white">
                          Ban
                        </button>
                      )}
                    </span>
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={canEdit ? 6 : 5} className="px-3 py-6 text-center text-slate-400">Nothing here</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-400">{total} player{total === 1 ? '' : 's'} total{status || search ? ' matching this filter' : ''}.</p>
    </div>
  );
}

function StatusBadge({ status }: { status: PlayerRow['status'] }) {
  const styles: Record<PlayerRow['status'], string> = {
    active: 'bg-emerald-100 text-emerald-700',
    suspended: 'bg-amber-100 text-amber-700',
    banned: 'bg-red-100 text-red-700',
  };
  return <span className={`rounded px-2 py-0.5 text-xs font-semibold ${styles[status]}`}>{status}</span>;
}

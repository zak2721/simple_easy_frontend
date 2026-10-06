import { useEffect, useState } from 'react';
import { adminApi, AuditRow } from '../adminApi';

const SECURITY_ACTIONS = ['ADMIN_LOGIN_FAILED', 'ADMIN_SESSION_REVOKED', 'ADMIN_DISABLED'];

type FilterAction = 'all' | 'ADMIN_LOGIN_FAILED' | 'ADMIN_SESSION_REVOKED' | 'ADMIN_DISABLED';

function rowBgClass(action: string): string {
  if (action === 'ADMIN_LOGIN_FAILED' || action === 'ADMIN_DISABLED') return 'bg-red-50';
  if (action === 'ADMIN_SESSION_REVOKED') return 'bg-orange-50';
  return '';
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) {
    const m = Math.floor(diff / 60_000);
    return m < 1 ? 'just now' : `${m}m ago`;
  }
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function SecurityEvents() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [filterAction, setFilterAction] = useState<FilterAction>('all');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [failedLast24h, setFailedLast24h] = useState(0);

  useEffect(() => {
    adminApi.audit()
      .then((r) => {
        const security = r.audit.filter((a) => SECURITY_ACTIONS.includes(a.action));
        setRows(security);
        const now = Date.now();
        const count = security.filter(
          (a) => a.action === 'ADMIN_LOGIN_FAILED' && now - new Date(a.created_at).getTime() < 86_400_000
        ).length;
        setFailedLast24h(count);
      })
      .catch((e) => setErr(e.message));
  }, []);

  const filtered = rows.filter((r) => {
    if (filterAction !== 'all' && r.action !== filterAction) return false;
    if (search) {
      const s = search.toLowerCase();
      if (!(r.username?.toLowerCase().includes(s) || r.ip_address?.toLowerCase().includes(s))) return false;
    }
    if (dateFrom && r.created_at < dateFrom) return false;
    if (dateTo && r.created_at > dateTo + 'T23:59:59') return false;
    return true;
  });

  return (
    <div>
      <h1 className="mb-2 text-xl font-bold">Security Events</h1>
      {err && <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}

      <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <strong>{failedLast24h}</strong> failed login{failedLast24h !== 1 ? 's' : ''} in the last 24 hours
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <select
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          value={filterAction}
          onChange={(e) => setFilterAction(e.target.value as FilterAction)}
        >
          <option value="all">All security events</option>
          <option value="ADMIN_LOGIN_FAILED">Login failures</option>
          <option value="ADMIN_SESSION_REVOKED">Session revocations</option>
          <option value="ADMIN_DISABLED">Account disabled</option>
        </select>
        <input
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          placeholder="Search username or IP…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <input
          type="date"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          title="From date"
        />
        <input
          type="date"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          title="To date"
        />
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Tenant</th>
              <th className="px-3 py-2">Actor</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">IP Address</th>
              <th className="px-3 py-2">Details</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No security events found</td></tr>
            )}
            {filtered.map((r) => (
              <tr key={r.id} className={`border-t border-slate-100 ${rowBgClass(r.action)}`}>
                <td className="px-3 py-2 text-slate-400 whitespace-nowrap" title={new Date(r.created_at).toLocaleString()}>
                  {relTime(r.created_at)}
                </td>
                <td className="px-3 py-2 text-slate-500 text-xs">{r.entity_type || '—'}</td>
                <td className="px-3 py-2 font-medium">{r.username ?? r.admin_user_id ?? 'system'}</td>
                <td className="px-3 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    r.action === 'ADMIN_LOGIN_FAILED' ? 'bg-red-100 text-red-800'
                    : r.action === 'ADMIN_SESSION_REVOKED' ? 'bg-orange-100 text-orange-800'
                    : r.action === 'ADMIN_DISABLED' ? 'bg-red-100 text-red-800'
                    : 'bg-slate-100 text-slate-700'
                  }`}>{r.action}</span>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-slate-500">{r.ip_address ?? '—'}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{r.reason ?? r.entity_id ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

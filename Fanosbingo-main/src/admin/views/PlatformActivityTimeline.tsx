import { useEffect, useState, useCallback } from 'react';
import { adminApi, AuditRow, OperatorRow } from '../adminApi';

const ACTION_LABELS: Record<string, string> = {
  DEPOSIT_APPROVED: 'Approved deposit',
  DEPOSIT_REJECTED: 'Rejected deposit',
  WITHDRAWAL_APPROVED: 'Approved withdrawal',
  WITHDRAWAL_REJECTED: 'Rejected withdrawal',
  WITHDRAWAL_PAID: 'Marked withdrawal paid',
  GAME_STARTED: 'Started game',
  GAME_FINISHED: 'Finished game',
  GAME_CANCELLED: 'Cancelled game',
  ADMIN_LOGIN: 'Admin signed in',
  ADMIN_LOGIN_FAILED: 'Failed login attempt',
  ADMIN_CREATED: 'Created admin account',
  ADMIN_DISABLED: 'Disabled admin account',
  ADMIN_SESSION_REVOKED: 'Revoked session',
  OPERATOR_CREATED: 'Created operator',
  OPERATOR_STATUS_CHANGED: 'Changed operator status',
  SETTING_UPDATED: 'Updated setting',
  BRANDING_UPDATED: 'Updated branding',
  ROOM_CREATED: 'Created room',
  ROOM_UPDATED: 'Updated room',
  APPROVAL_APPROVED: 'Approved request',
  APPROVAL_REJECTED: 'Rejected request',
  PLAYER_STATUS_CHANGED: 'Changed player status',
  WALLET_ADJUSTED: 'Adjusted wallet',
};

type Category = 'all' | 'auth' | 'financial' | 'games' | 'settings' | 'admin';

const CATEGORY_ACTIONS: Record<Exclude<Category, 'all'>, string[]> = {
  auth: ['ADMIN_LOGIN', 'ADMIN_LOGIN_FAILED', 'ADMIN_SESSION_REVOKED'],
  financial: ['DEPOSIT_APPROVED', 'DEPOSIT_REJECTED', 'WITHDRAWAL_APPROVED', 'WITHDRAWAL_REJECTED', 'WITHDRAWAL_PAID', 'WALLET_ADJUSTED'],
  games: ['GAME_STARTED', 'GAME_FINISHED', 'GAME_CANCELLED'],
  settings: ['SETTING_UPDATED', 'BRANDING_UPDATED', 'ROOM_CREATED', 'ROOM_UPDATED'],
  admin: ['ADMIN_CREATED', 'ADMIN_DISABLED', 'OPERATOR_CREATED', 'OPERATOR_STATUS_CHANGED', 'APPROVAL_APPROVED', 'APPROVAL_REJECTED', 'PLAYER_STATUS_CHANGED'],
};

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hour${Math.floor(diff / 3_600_000) > 1 ? 's' : ''} ago`;
  return new Date(iso).toLocaleDateString();
}

const OP_COLORS = ['bg-blue-100 text-blue-800', 'bg-purple-100 text-purple-800', 'bg-indigo-100 text-indigo-800',
  'bg-pink-100 text-pink-800', 'bg-teal-100 text-teal-800', 'bg-orange-100 text-orange-800'];

function opColor(entityType: string): string {
  let h = 0;
  for (let i = 0; i < entityType.length; i++) h = (h * 31 + entityType.charCodeAt(i)) & 0xffff;
  return OP_COLORS[h % OP_COLORS.length];
}

function humanizeAction(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

const PAGE_SIZE = 20;

export function PlatformActivityTimeline() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [operators, setOperators] = useState<OperatorRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [tenantFilter, setTenantFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<Category>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const load = useCallback(async () => {
    try {
      const [auditRes, opRes] = await Promise.allSettled([
        adminApi.audit(),
        adminApi.listOperators(),
      ]);
      if (auditRes.status === 'fulfilled') {
        setRows([...auditRes.value.audit].sort((a, b) => b.created_at.localeCompare(a.created_at)));
      }
      if (opRes.status === 'fulfilled') setOperators(opRes.value);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15_000);
    return () => clearInterval(interval);
  }, [load]);

  const filtered = rows.filter((r) => {
    if (tenantFilter && r.entity_type !== tenantFilter) {
      const op = operators.find((o) => o.id === tenantFilter);
      if (!op || r.entity_type !== op.slug) return false;
    }
    if (categoryFilter !== 'all') {
      if (!CATEGORY_ACTIONS[categoryFilter].includes(r.action)) return false;
    }
    if (dateFrom && r.created_at < dateFrom) return false;
    if (dateTo && r.created_at > dateTo + 'T23:59:59') return false;
    return true;
  });

  const visible = filtered.slice(0, page * PAGE_SIZE);
  const hasMore = filtered.length > visible.length;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">Activity Timeline</h1>
        <span className="text-xs text-slate-400">Auto-refresh every 15s</span>
      </div>

      {err && <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}

      <div className="mb-4 flex flex-wrap gap-2">
        <select
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          value={tenantFilter}
          onChange={(e) => { setTenantFilter(e.target.value); setPage(1); }}
        >
          <option value="">All tenants</option>
          {operators.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <select
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm capitalize"
          value={categoryFilter}
          onChange={(e) => { setCategoryFilter(e.target.value as Category); setPage(1); }}
        >
          <option value="all">All categories</option>
          <option value="auth">Auth</option>
          <option value="financial">Financial</option>
          <option value="games">Games</option>
          <option value="settings">Settings</option>
          <option value="admin">Admin</option>
        </select>
        <input
          type="date"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          value={dateFrom}
          onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
          title="From date"
        />
        <input
          type="date"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          value={dateTo}
          onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
          title="To date"
        />
      </div>

      <div className="relative ml-4 border-l-2 border-slate-200 pl-6 space-y-4">
        {visible.length === 0 && (
          <p className="py-10 text-center text-slate-400">No activity events found</p>
        )}
        {visible.map((r) => (
          <div key={r.id} className="relative">
            <span className="absolute -left-8 top-1.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-white bg-slate-300" />
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-400 whitespace-nowrap">{relTime(r.created_at)}</span>
                {r.entity_type && (
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${opColor(r.entity_type)}`}>
                    {r.entity_type}
                  </span>
                )}
                <span className="font-medium text-sm">{r.username ?? r.admin_user_id ?? 'system'}</span>
                {r.username && (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                    admin
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-slate-700">{humanizeAction(r.action)}</p>
              {r.reason && <p className="mt-0.5 text-xs text-slate-400">{r.reason}</p>}
              {r.ip_address && <p className="mt-0.5 font-mono text-xs text-slate-300">{r.ip_address}</p>}
            </div>
          </div>
        ))}
      </div>

      {hasMore && (
        <div className="mt-4 flex justify-center">
          <button
            onClick={() => setPage((p) => p + 1)}
            className="rounded-lg border border-slate-200 bg-white px-5 py-2 text-sm text-slate-600 hover:bg-slate-50"
          >
            Show more ({filtered.length - visible.length} remaining)
          </button>
        </div>
      )}
    </div>
  );
}

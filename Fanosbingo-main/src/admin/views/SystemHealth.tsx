import { useEffect, useState, useCallback } from 'react';
import { adminApi, DashboardData, OperatorRow } from '../adminApi';

interface HealthData {
  status: string;
  db?: string;
  storage?: string;
  checkedAt?: string;
  [key: string]: unknown;
}

interface MetricsData {
  [key: string]: unknown;
}

type StatusLevel = 'ok' | 'warn' | 'error' | 'unknown';

function statusColor(s: StatusLevel): string {
  return { ok: 'text-green-600', warn: 'text-yellow-600', error: 'text-red-600', unknown: 'text-slate-400' }[s];
}

function statusBg(s: StatusLevel): string {
  return { ok: 'bg-green-100', warn: 'bg-yellow-100', error: 'bg-red-100', unknown: 'bg-slate-100' }[s];
}

function statusDot(s: StatusLevel): string {
  return { ok: 'bg-green-500', warn: 'bg-yellow-500', error: 'bg-red-500', unknown: 'bg-slate-400' }[s];
}

function parseStatus(val: unknown): StatusLevel {
  const s = String(val ?? '').toLowerCase();
  if (s === 'ok' || s === 'up' || s === 'healthy') return 'ok';
  if (s === 'warn' || s === 'degraded') return 'warn';
  if (s === 'error' || s === 'down' || s === 'unhealthy') return 'error';
  return 'unknown';
}

export function SystemHealth() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [operators, setOperators] = useState<OperatorRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const [hRes, mRes, dRes, opRes] = await Promise.allSettled([
        adminApi.getHealth(),
        adminApi.getMetrics(),
        adminApi.dashboard(),
        adminApi.listOperators(),
      ]);
      if (hRes.status === 'fulfilled') setHealth(hRes.value as HealthData);
      if (mRes.status === 'fulfilled') setMetrics(mRes.value as MetricsData);
      if (dRes.status === 'fulfilled') setDashboard(dRes.value.dashboard);
      if (opRes.status === 'fulfilled') setOperators(opRes.value as OperatorRow[]);
      setLastRefresh(new Date());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  const overallStatus: StatusLevel = health
    ? parseStatus(health.status)
    : 'unknown';

  const dbStatus: StatusLevel = health?.db ? parseStatus(health.db) : 'unknown';
  const storageStatus: StatusLevel = health?.storage ? parseStatus(health.storage) : 'unknown';

  const activeOps = operators.filter((o) => o.status === 'active').length;
  const suspendedOps = operators.filter((o) => o.status === 'suspended').length;
  const disabledOps = operators.filter((o) => o.status === 'disabled').length;

  const tiles = [
    { label: 'Database', status: dbStatus },
    { label: 'API', status: 'ok' as StatusLevel },
    { label: 'Storage', status: storageStatus },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">System Health</h1>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-xs text-slate-400">Last refresh: {lastRefresh.toLocaleTimeString()}</span>
          )}
          <button
            onClick={load}
            className="rounded-lg bg-white border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            Refresh
          </button>
        </div>
      </div>

      {err && <p className="mb-4 rounded bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}

      <div className={`mb-4 flex items-center gap-3 rounded-xl border p-4 ${statusBg(overallStatus)}`}>
        <span className={`inline-block h-3 w-3 rounded-full ${statusDot(overallStatus)}`} />
        <span className={`font-semibold ${statusColor(overallStatus)}`}>
          Platform {overallStatus === 'ok' ? 'Healthy' : overallStatus === 'warn' ? 'Degraded' : overallStatus === 'error' ? 'Unhealthy' : 'Status Unknown'}
        </span>
        <span className="text-xs text-slate-500">Auto-refresh every 30s</span>
      </div>

      <div className="mb-4 grid grid-cols-3 gap-3">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${statusDot(t.status)}`} />
              <p className="text-xs uppercase tracking-wide text-slate-400">{t.label}</p>
            </div>
            <p className={`mt-1 text-sm font-semibold capitalize ${statusColor(t.status)}`}>
              {t.status === 'unknown' ? '—' : t.status}
            </p>
          </div>
        ))}
      </div>

      <h2 className="mb-3 font-semibold text-slate-700">Platform at a Glance</h2>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: 'Total Players', value: dashboard?.total_players ?? '—' },
          { label: 'Active Games', value: dashboard?.active_games ?? '—' },
          { label: 'Pending Deposits', value: dashboard?.pending_deposits ?? '—' },
          { label: 'Pending Withdrawals', value: dashboard?.pending_withdrawals ?? '—' },
        ].map((t) => (
          <div key={t.label} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-slate-400">{t.label}</p>
            <p className="mt-1 text-lg font-bold">{String(t.value)}</p>
          </div>
        ))}
      </div>

      <h2 className="mb-3 font-semibold text-slate-700">Operators by Status</h2>
      <div className="mb-4 grid grid-cols-3 gap-3">
        {[
          { label: 'Active', count: activeOps, color: 'text-green-700 bg-green-50 border-green-200' },
          { label: 'Suspended', count: suspendedOps, color: 'text-yellow-700 bg-yellow-50 border-yellow-200' },
          { label: 'Disabled', count: disabledOps, color: 'text-slate-500 bg-slate-50 border-slate-200' },
        ].map((t) => (
          <div key={t.label} className={`rounded-xl border p-4 ${t.color}`}>
            <p className="text-xs uppercase tracking-wide opacity-70">{t.label}</p>
            <p className="mt-1 text-2xl font-bold">{t.count}</p>
          </div>
        ))}
      </div>

      {metrics && Object.keys(metrics).length > 0 && (
        <>
          <h2 className="mb-3 font-semibold text-slate-700">Raw Metrics</h2>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <pre className="overflow-x-auto text-xs text-slate-600">{JSON.stringify(metrics, null, 2)}</pre>
          </div>
        </>
      )}
    </div>
  );
}

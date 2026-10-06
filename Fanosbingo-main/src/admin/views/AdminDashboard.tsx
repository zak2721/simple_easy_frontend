import { useEffect, useState } from 'react';
import { adminApi, DashboardData } from '../adminApi';
import { formatEtb } from '../../lib/format';

export function AdminDashboard() {
  const [d, setD] = useState<DashboardData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    adminApi.dashboard().then((r) => setD(r.dashboard)).catch((e) => setErr(e.message));
  }, []);

  if (err) return <p className="text-red-500">{err}</p>;
  if (!d) return <p className="text-slate-500">Loading…</p>;

  const tiles: [string, string][] = [
    ['Total players', String(d.total_players)],
    ['Pending deposits', `${d.pending_deposits} · ${formatEtb(d.today_deposits_etb)}`],
    ['Pending withdrawals', `${d.pending_withdrawals} · ${formatEtb(d.today_withdrawals_etb)}`],
    ['Active games', String(d.active_games)],
    ['House revenue (total)', formatEtb(d.total_house_revenue_etb)],
  ];

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">Dashboard</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
            <p className="mt-1 text-lg font-bold">{value}</p>
          </div>
        ))}
        {d.rooms.map((room) => (
          <div key={room.code} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-slate-400">{room.name} available</p>
            <p className="mt-1 text-lg font-bold">{room.available} / {room.capacity}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

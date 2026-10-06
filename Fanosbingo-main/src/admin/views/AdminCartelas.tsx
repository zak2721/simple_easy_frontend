import { useEffect, useState } from 'react';
import { adminApi, CartelasData } from '../adminApi';

export function AdminCartelas() {
  const [c, setC] = useState<CartelasData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    adminApi.cartelas().then(setC).catch((e) => setErr(e.message));
  }, []);

  if (err) return <p className="text-red-500">{err}</p>;
  if (!c) return <p className="text-slate-500">Loading…</p>;

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">Cartelas</h1>
      <p className="mb-3 text-sm text-slate-500">
        Total capacity {c.total_capacity} · Max {c.max_per_player} per player (across all rooms)
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {c.rooms.map((room) => {
          const holders = c.holders[room.code] ?? [];
          return (
            <div key={room.code} className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="font-bold">{room.name} <span className="text-xs font-normal text-slate-400">({room.code})</span></p>
              <dl className="mt-2 space-y-1 text-sm text-slate-600">
                <div className="flex justify-between"><dt>Price</dt><dd>{room.price} ETB</dd></div>
                <div className="flex justify-between"><dt>Total</dt><dd>{room.capacity}</dd></div>
                <div className="flex justify-between"><dt>Sold in live game</dt><dd>{holders.length}</dd></div>
              </dl>
              {holders.length > 0 && (
                <div className="mt-3 max-h-40 overflow-y-auto border-t border-slate-100 pt-2">
                  {holders
                    .slice()
                    .sort((a, b) => a.cartelaNumber - b.cartelaNumber)
                    .map((h) => (
                      <div key={h.id} className="flex justify-between py-0.5 text-xs">
                        <span>#{h.cartelaNumber}{h.isDisqualified && <span className="ml-1 text-red-400">(DQ)</span>}</span>
                        <span className="text-slate-400">{h.user.username ? `@${h.user.username}` : h.user.firstName ?? h.user.telegramUserId}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          );
        })}
        {c.rooms.length === 0 && <p className="text-slate-400">No rooms configured.</p>}
      </div>

      <h2 className="mb-2 mt-6 text-sm font-bold text-slate-600">Per-player cartela limit violations</h2>
      {c.limit_violations.length === 0 ? (
        <p className="text-sm text-emerald-600">None — the backend prevents this.</p>
      ) : (
        <ul className="text-sm text-red-600">
          {c.limit_violations.map((v) => <li key={v.telegram_user_id}>User {v.telegram_user_id}: {v.cartelas} cartelas</li>)}
        </ul>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { adminApi, GameAdminRow, GamesListResponse } from '../adminApi';
import { Modal } from '../components/Modal';

const PATTERNS = ['row', 'column', 'diagonal', 'corners', 'full_house'];
const STATUS_COLOR: Record<string, string> = {
  scheduled: 'bg-sky-100 text-sky-700',
  waiting: 'bg-amber-100 text-amber-700',
  playing: 'bg-emerald-100 text-emerald-700',
  finished: 'bg-slate-100 text-slate-500',
};

/**
 * Scheduled-game management — only meaningful once the operator's game mode
 * is "scheduled" (set by the platform). In continuous mode the engine creates
 * games automatically and this screen has nothing to schedule.
 */
export function OperatorGames() {
  const [data, setData] = useState<GamesListResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);

  const load = useCallback(() => {
    adminApi.myGames().then(setData).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const cancel = async (g: GameAdminRow) => {
    const reason = window.prompt(`Reason for cancelling game #${g.gameNumber}:`);
    if (!reason || reason.trim().length < 3) return alert('A reason of at least 3 characters is required');
    setBusy(g.id);
    try {
      await adminApi.cancelMyGame(g.id, reason);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-xl font-bold">Games</h1>
        <button onClick={() => setScheduling(true)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white">
          + Schedule game
        </button>
      </div>
      {err && <p className="mb-3 text-sm text-red-500">{err}</p>}

      <h2 className="mb-2 text-sm font-bold text-slate-600">Upcoming / live</h2>
      <div className="mb-6 space-y-2">
        {data?.upcoming.map((g) => (
          <div key={g.id} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-bold">Game #{g.gameNumber} <span className={`ml-2 rounded px-1.5 py-0.5 text-xs font-semibold ${STATUS_COLOR[g.status]}`}>{g.status}</span></p>
                <p className="text-sm text-slate-500">Starts {new Date(g.startsAt).toLocaleString()}{g.salesOpenAt ? ` · sales open ${new Date(g.salesOpenAt).toLocaleString()}` : ''}</p>
                <p className="text-xs text-slate-400">Patterns: {g.winningPatterns.join(', ')} · {g.cartelasSold} sold · pot {g.totalPot} ETB</p>
              </div>
              {(g.status === 'scheduled' || g.status === 'waiting') && (
                <button disabled={busy === g.id} onClick={() => cancel(g)} className="shrink-0 rounded bg-red-500 px-2 py-1 text-xs text-white">Cancel</button>
              )}
            </div>
          </div>
        ))}
        {data && data.upcoming.length === 0 && <p className="text-slate-400">Nothing scheduled.</p>}
      </div>

      <h2 className="mb-2 text-sm font-bold text-slate-600">Recent</h2>
      <div className="space-y-2">
        {data?.recent.map((g) => (
          <div key={g.id} className="rounded-xl border border-slate-100 bg-white p-3 text-sm">
            <p>Game #{g.gameNumber} · {g.cartelasSold} sold · pot {g.totalPot} ETB · finished {g.finishedAt ? new Date(g.finishedAt).toLocaleString() : '—'}</p>
            {g.cancelledReason && <p className="text-xs text-red-400">Cancelled: {g.cancelledReason}</p>}
          </div>
        ))}
        {data && data.recent.length === 0 && <p className="text-slate-400">No finished games yet.</p>}
      </div>

      {scheduling && <ScheduleModal onClose={() => setScheduling(false)} onScheduled={() => { setScheduling(false); load(); }} />}
    </div>
  );
}

function ScheduleModal({ onClose, onScheduled }: { onClose: () => void; onScheduled: () => void }) {
  const [startsAt, setStartsAt] = useState('');
  const [salesOpenMinutes, setSalesOpenMinutes] = useState('10');
  const [patterns, setPatterns] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!startsAt) return setError('Pick a start time');
    setBusy(true);
    try {
      await adminApi.scheduleMyGame({
        startsAt: new Date(startsAt).toISOString(),
        salesOpenMinutes: salesOpenMinutes ? Number(salesOpenMinutes) : undefined,
        winningPatterns: patterns.size ? Array.from(patterns) : undefined,
      });
      onScheduled();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Schedule game" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-slate-700">Start time</label>
          <input type="datetime-local" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700">Sales open (minutes before start)</label>
          <input type="number" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={salesOpenMinutes} onChange={(e) => setSalesOpenMinutes(e.target.value)} />
        </div>
        <div>
          <p className="mb-1.5 text-xs font-semibold text-slate-500">Winning patterns (blank = your operator default)</p>
          <div className="flex flex-wrap gap-2">
            {PATTERNS.map((p) => (
              <label key={p} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={patterns.has(p)}
                  onChange={(e) => {
                    const next = new Set(patterns);
                    if (e.target.checked) next.add(p); else next.delete(p);
                    setPatterns(next);
                  }}
                />
                {p}
              </label>
            ))}
          </div>
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button onClick={submit} disabled={busy} className="w-full rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? 'Scheduling…' : 'Schedule'}
        </button>
      </div>
    </Modal>
  );
}

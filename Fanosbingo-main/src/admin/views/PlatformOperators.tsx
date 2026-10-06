import { useCallback, useEffect, useState } from 'react';
import { adminApi, DepositRow, OperatorRow, PlayerRow, StaffRow, WithdrawalRow } from '../adminApi';
import { Modal } from '../components/Modal';

const STATUS_COLOR: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-700',
  suspended: 'bg-amber-100 text-amber-700',
  disabled: 'bg-slate-100 text-slate-500',
};

export function PlatformOperators({ onImpersonate }: { onImpersonate: (adminId: string, reason?: string) => Promise<void> }) {
  const [rows, setRows] = useState<OperatorRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [detailFor, setDetailFor] = useState<OperatorRow | null>(null);

  const load = useCallback(() => {
    adminApi.listOperators().then(setRows).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const setStatus = async (op: OperatorRow, status: 'active' | 'suspended' | 'disabled') => {
    const reason = window.prompt(`Reason for setting "${op.slug}" to ${status}:`);
    if (!reason || reason.trim().length < 3) return alert('A reason of at least 3 characters is required');
    setBusy(op.id);
    try {
      await adminApi.setOperatorStatus(op.id, status, reason);
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
        <h1 className="text-xl font-bold">Operators</h1>
        <button onClick={() => setCreating(true)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white">+ New operator</button>
      </div>
      {err && <p className="mb-3 text-sm text-red-500">{err}</p>}

      <div className="space-y-3">
        {rows.map((op) => (
          <div key={op.id} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-bold">
                  {op.name} <span className="ml-1 text-xs font-normal text-slate-400">({op.slug})</span>
                  <span className={`ml-2 rounded px-1.5 py-0.5 text-xs font-semibold ${STATUS_COLOR[op.status]}`}>{op.status}</span>
                  {op.isDefault && <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-xs font-semibold text-sky-700">default</span>}
                </p>
                <p className="text-xs text-slate-400">
                  owner: {op.owner ? `${op.owner.username} (${op.owner.status})` : 'none'} · {op.players} players · {op.adminAccounts} admin accounts
                </p>
                <p className="text-xs text-slate-400">
                  bot: {op.bot.configured ? `@${op.bot.username ?? '?'}` : 'not connected'} · rooms: {op.rooms.map((r) => `${r.code} (${r.price} ETB, ${r.capacity})`).join(', ') || 'none'}
                </p>
                {op.suspendedReason && <p className="mt-1 text-xs text-amber-600">Suspended: {op.suspendedReason}</p>}
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                <button onClick={() => setDetailFor(op)} className="rounded bg-sky-600 px-2 py-1 text-xs text-white">Manage</button>
                {!op.isDefault && op.status !== 'active' && (
                  <button disabled={busy === op.id} onClick={() => setStatus(op, 'active')} className="rounded bg-emerald-600 px-2 py-1 text-xs text-white">Reactivate</button>
                )}
                {!op.isDefault && op.status === 'active' && (
                  <button disabled={busy === op.id} onClick={() => setStatus(op, 'suspended')} className="rounded bg-amber-500 px-2 py-1 text-xs text-white">Suspend</button>
                )}
                {!op.isDefault && op.status !== 'disabled' && (
                  <button disabled={busy === op.id} onClick={() => setStatus(op, 'disabled')} className="rounded bg-red-500 px-2 py-1 text-xs text-white">Disable</button>
                )}
              </div>
            </div>
          </div>
        ))}
        {rows.length === 0 && !err && <p className="text-slate-400">No operators yet.</p>}
      </div>

      {creating && <CreateOperatorModal onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />}
      {detailFor && <OperatorDetailModal op={detailFor} onClose={() => setDetailFor(null)} onChanged={load} onImpersonate={onImpersonate} />}
    </div>
  );
}

function CreateOperatorModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [ownerUsername, setOwnerUsername] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [ownerFullName, setOwnerFullName] = useState('');
  const [rooms, setRooms] = useState([{ code: 'etb5', name: 'ETB 5 room', price: '5', capacity: '400' }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const addRoom = () => setRooms((r) => [...r, { code: '', name: '', price: '', capacity: '' }]);
  const updateRoom = (i: number, patch: Partial<(typeof rooms)[number]>) => setRooms((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const removeRoom = (i: number) => setRooms((r) => r.filter((_, j) => j !== i));

  const submit = async () => {
    setError(null);
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) return setError('Slug: lowercase letters, digits and dashes');
    if (!name.trim()) return setError('Name is required');
    if (ownerUsername.length < 3) return setError('Owner username must be at least 3 characters');
    if (ownerPassword && ownerPassword.length < 10) return setError('Owner password must be at least 10 characters');
    if (!ownerFullName.trim()) return setError('Owner full name is required');
    if (rooms.length === 0) return setError('At least one room is required');
    for (const r of rooms) {
      if (!/^[a-z0-9_-]{1,32}$/.test(r.code)) return setError(`Room code "${r.code}" invalid`);
      if (!r.name.trim()) return setError('Every room needs a name');
      if (!(Number(r.price) > 0)) return setError('Every room needs a price greater than 0');
      if (!Number.isInteger(Number(r.capacity)) || Number(r.capacity) < 1) return setError('Every room needs a whole-number capacity');
    }
    setBusy(true);
    try {
      const r = await adminApi.createOperator({
        slug,
        name: name.trim(),
        owner: { username: ownerUsername, ...(ownerPassword ? { password: ownerPassword } : {}), fullName: ownerFullName.trim() },
        rooms: rooms.map((room) => ({ code: room.code, name: room.name.trim(), price: Number(room.price), capacity: Number(room.capacity) })),
      });
      const tempPwMsg = r.temporaryPassword ? `\n\nTemporary password (shown once, save it now): ${r.temporaryPassword}` : '';
      alert(`Operator created. ${r.nextStep}${tempPwMsg}`);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New operator" onClose={onClose} wide>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Slug (e.g. abebe-bingo)" value={slug} onChange={(e) => setSlug(e.target.value)} />
          <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <p className="text-xs font-semibold text-slate-500">Owner account</p>
        <div className="grid grid-cols-3 gap-3">
          <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Username" value={ownerUsername} onChange={(e) => setOwnerUsername(e.target.value)} />
          <input type="password" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Password (leave blank to auto-generate)" value={ownerPassword} onChange={(e) => setOwnerPassword(e.target.value)} />
          <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Full name" value={ownerFullName} onChange={(e) => setOwnerFullName(e.target.value)} />
        </div>
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-slate-500">Rooms (at least one)</p>
          <button onClick={addRoom} className="text-xs text-emerald-600">+ Add room</button>
        </div>
        <div className="space-y-2">
          {rooms.map((room, i) => (
            <div key={i} className="grid grid-cols-5 gap-2">
              <input className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm" placeholder="code" value={room.code} onChange={(e) => updateRoom(i, { code: e.target.value })} />
              <input className="col-span-2 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" placeholder="name" value={room.name} onChange={(e) => updateRoom(i, { name: e.target.value })} />
              <input type="number" className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm" placeholder="price" value={room.price} onChange={(e) => updateRoom(i, { price: e.target.value })} />
              <div className="flex gap-1">
                <input type="number" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" placeholder="capacity" value={room.capacity} onChange={(e) => updateRoom(i, { capacity: e.target.value })} />
                {rooms.length > 1 && <button onClick={() => removeRoom(i)} className="text-red-400">✕</button>}
              </div>
            </div>
          ))}
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button onClick={submit} disabled={busy} className="w-full rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? 'Creating…' : 'Create operator'}
        </button>
      </div>
    </Modal>
  );
}

function OperatorDetailModal({ op, onClose, onChanged, onImpersonate }: { op: OperatorRow; onClose: () => void; onChanged: () => void; onImpersonate: (adminId: string, reason?: string) => Promise<void> }) {
  const [tab, setTab] = useState<'staff' | 'players' | 'financials' | 'bot' | 'ownership'>('staff');
  const [staff, setStaff] = useState<StaffRow[] | null>(null);
  const [players, setPlayers] = useState<PlayerRow[] | null>(null);
  const [deposits, setDeposits] = useState<DepositRow[] | null>(null);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRow[] | null>(null);
  const [botToken, setBotToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (tab === 'staff') adminApi.listOperatorStaff(op.id).then(setStaff).catch(() => setStaff([]));
    if (tab === 'players') adminApi.listPlayers({ operatorId: op.id, take: 50 }).then((r) => setPlayers(r.players)).catch(() => setPlayers([]));
    if (tab === 'financials') {
      adminApi.listDeposits(undefined, op.id).then((r) => setDeposits(r.deposits)).catch(() => setDeposits([]));
      adminApi.listWithdrawals(undefined, op.id).then((r) => setWithdrawals(r.withdrawals)).catch(() => setWithdrawals([]));
    }
  }, [tab, op.id]);

  const viewAs = async (s: StaffRow) => {
    const reason = window.prompt(`Reason for viewing as "${s.username}" (shown to the operator):`);
    if (!reason || reason.trim().length < 3) return alert('A reason of at least 3 characters is required');
    setBusy(true);
    try {
      await onImpersonate(s.id, reason);
      onClose();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const configureBot = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await adminApi.configureOperatorBot(op.id, { botToken: botToken.trim() });
      setMsg(r.webhook.ok ? `Connected @${r.botUsername}` : `Connected @${r.botUsername}, webhook issue: ${r.webhook.description}`);
      setBotToken('');
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const toggleGameMode = async (mode: 'continuous' | 'scheduled') => {
    setBusy(true);
    setMsg(null);
    try {
      await adminApi.setOperatorGameMode(op.id, mode);
      setMsg(`Game mode set to ${mode}.`);
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const resetOwnerPassword = async () => {
    const pw = window.prompt(`New password for the owner of "${op.slug}" (min 10 characters):`);
    if (!pw) return;
    if (pw.length < 10) return alert('Password must be at least 10 characters');
    setBusy(true);
    try {
      await adminApi.resetOwnerPassword(op.id, pw);
      alert('Owner password reset. All active sessions were revoked.');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const transferOwnership = async (candidate: StaffRow) => {
    const reason = window.prompt(`Reason for transferring ownership to "${candidate.username}":`);
    if (!reason || reason.trim().length < 3) return alert('A reason of at least 3 characters is required');
    setBusy(true);
    try {
      await adminApi.transferOwnership(op.id, candidate.id, reason);
      alert('Ownership transferred.');
      onChanged();
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Manage — ${op.name}`} onClose={onClose} wide>
      <div className="mb-3 flex flex-wrap gap-2 border-b border-slate-100 pb-2 text-sm">
        <button onClick={() => setTab('staff')} className={tab === 'staff' ? 'font-bold text-emerald-600' : 'text-slate-500'}>Staff</button>
        <button onClick={() => setTab('players')} className={tab === 'players' ? 'font-bold text-emerald-600' : 'text-slate-500'}>Players</button>
        <button onClick={() => setTab('financials')} className={tab === 'financials' ? 'font-bold text-emerald-600' : 'text-slate-500'}>Financials</button>
        <button onClick={() => setTab('bot')} className={tab === 'bot' ? 'font-bold text-emerald-600' : 'text-slate-500'}>Bot & game mode</button>
        <button onClick={() => setTab('ownership')} className={tab === 'ownership' ? 'font-bold text-emerald-600' : 'text-slate-500'}>Ownership</button>
      </div>

      {msg && <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-sm">{msg}</p>}

      {tab === 'staff' && (
        <div className="space-y-2">
          {staff === null && <p className="text-slate-400">Loading…</p>}
          {staff?.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2 text-sm">
              <span>{s.username} <span className="text-xs text-slate-400">({s.role}, {s.status})</span></span>
              {s.status === 'active' && (
                <button disabled={busy} onClick={() => viewAs(s)} className="rounded bg-orange-500 px-2 py-1 text-xs text-white">View as</button>
              )}
            </div>
          ))}
          {staff?.length === 0 && <p className="text-slate-400">No staff yet.</p>}
        </div>
      )}

      {tab === 'players' && (
        <div className="space-y-1 max-h-96 overflow-y-auto">
          {players === null && <p className="text-slate-400">Loading…</p>}
          {players?.length === 0 && <p className="text-slate-400">No players yet.</p>}
          {players?.map((p) => (
            <div key={p.telegram_user_id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2 text-sm">
              <span className="font-medium">{p.username ?? p.first_name ?? String(p.telegram_user_id)}</span>
              <span className={`text-xs px-2 py-0.5 rounded ${p.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{p.status}</span>
            </div>
          ))}
          {(players?.length ?? 0) === 50 && <p className="text-center text-xs text-slate-400 pt-2">Showing first 50 players</p>}
        </div>
      )}

      {tab === 'financials' && (
        <div className="space-y-4 max-h-96 overflow-y-auto">
          <div>
            <p className="mb-2 text-xs font-semibold text-slate-500">Recent deposits</p>
            {deposits === null && <p className="text-slate-400 text-sm">Loading…</p>}
            {deposits?.length === 0 && <p className="text-slate-400 text-sm">No deposits.</p>}
            {deposits?.slice(0, 20).map((d) => (
              <div key={d.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-1.5 text-xs mb-1">
                <span>{d.amount} ETB · {new Date(d.submitted_at).toLocaleDateString()}</span>
                <span className={`px-1.5 py-0.5 rounded ${d.status === 'approved' ? 'bg-emerald-50 text-emerald-700' : d.status === 'pending' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{d.status}</span>
              </div>
            ))}
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold text-slate-500">Recent withdrawals</p>
            {withdrawals === null && <p className="text-slate-400 text-sm">Loading…</p>}
            {withdrawals?.length === 0 && <p className="text-slate-400 text-sm">No withdrawals.</p>}
            {withdrawals?.slice(0, 20).map((w) => (
              <div key={w.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-1.5 text-xs mb-1">
                <span>{w.amount} ETB · {new Date(w.requested_at).toLocaleDateString()}</span>
                <span className={`px-1.5 py-0.5 rounded ${w.status === 'approved' ? 'bg-emerald-50 text-emerald-700' : w.status === 'pending' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{w.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'bot' && (
        <div className="space-y-4">
          {!op.isDefault && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-700">Connect / reconnect bot on the operator's behalf</p>
              <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Bot token" value={botToken} onChange={(e) => setBotToken(e.target.value)} />
              <button onClick={configureBot} disabled={busy || !botToken.trim()} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {busy ? 'Connecting…' : 'Connect bot'}
              </button>
            </div>
          )}
          <div>
            <p className="mb-1 text-sm font-medium text-slate-700">Game mode</p>
            <div className="flex gap-2">
              <button onClick={() => toggleGameMode('continuous')} disabled={busy} className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white">Set continuous</button>
              <button onClick={() => toggleGameMode('scheduled')} disabled={busy} className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white">Set scheduled</button>
            </div>
          </div>
        </div>
      )}

      {tab === 'ownership' && (
        <div className="space-y-3">
          <button onClick={resetOwnerPassword} disabled={busy} className="rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
            Reset owner password
          </button>
          <div>
            <p className="mb-2 text-sm font-medium text-slate-700">Transfer ownership to an active staff member</p>
            {staff === null && <p className="text-slate-400">Open the Staff tab first to load staff.</p>}
            {staff?.filter((s) => s.role === 'OPERATOR_STAFF' && s.status === 'active').map((s) => (
              <button key={s.id} onClick={() => transferOwnership(s)} disabled={busy} className="mr-2 mb-2 rounded-lg bg-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700">
                Make {s.username} the owner
              </button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

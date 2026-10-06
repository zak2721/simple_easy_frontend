import { useCallback, useEffect, useState } from 'react';
import { adminApi, InventoryResponse, RoomInventoryRow } from '../adminApi';
import { Modal } from '../components/Modal';

const emptyForm = { code: '', name: '', price: '', capacity: '', maxPerPlayer: '' };

export function OperatorRooms() {
  const [data, setData] = useState<InventoryResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RoomInventoryRow | null>(null);

  const load = useCallback(() => {
    adminApi.myInventory().then(setData).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggleActive = async (room: RoomInventoryRow) => {
    setBusy(room.id);
    try {
      await adminApi.updateMyRoom(room.id, { isActive: !room.isActive });
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const changeCapacity = async (room: RoomInventoryRow) => {
    const next = window.prompt(`New capacity for "${room.name}" (currently ${room.capacity}). Increases require Super Admin approval.`, String(room.capacity));
    if (!next) return;
    const n = Number(next);
    if (!Number.isInteger(n) || n < 1) return alert('Enter a whole number of at least 1');
    setBusy(room.id);
    try {
      const r = await adminApi.setMyRoomCapacity(room.id, n);
      if ('pendingApproval' in r) alert('Capacity increase submitted for Super Admin approval.');
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
        <h1 className="text-xl font-bold">Rooms & Inventory</h1>
        <button onClick={() => setCreating(true)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white">
          + New room
        </button>
      </div>
      {err && <p className="mb-3 text-sm text-red-500">{err}</p>}
      {data?.limits && (
        <p className="mb-3 text-xs text-slate-400">
          Limits: max {data.limits.MAX_ROOMS} rooms · max {data.limits.MAX_TOTAL_CARTELAS} cartelas total · price {data.limits.MIN_CARTELA_PRICE}–{data.limits.MAX_CARTELA_PRICE} ETB · max {data.limits.MAX_STAFF} staff
        </p>
      )}

      <div className="space-y-3">
        {data?.rooms.map((room) => (
          <div key={room.id} className={`rounded-xl border bg-white p-4 ${room.isActive ? 'border-slate-200' : 'border-slate-200 opacity-60'}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-bold">{room.name} <span className="ml-1 text-xs font-normal text-slate-400">({room.code}){!room.isActive && ' · inactive'}</span></p>
                <p className="text-sm text-slate-500">{room.price} ETB · capacity {room.capacity} · max/player {room.maxPerPlayer ?? '—'}</p>
                {room.liveGame && <p className="mt-1 text-xs text-emerald-600">Live game: {room.liveGame.sold} sold, {room.liveGame.available} available</p>}
                <p className="mt-1 text-xs text-slate-400">All-time: {room.allTime.sold} sold · {room.allTime.revenue} ETB revenue · {room.allTime.winning} winners</p>
                {room.inactiveNumbers.length > 0 && (
                  <p className="mt-1 text-xs text-red-400">Deactivated numbers: {room.inactiveNumbers.map((n) => n.number).join(', ')}</p>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
                <button onClick={() => setEditing(room)} className="rounded bg-sky-600 px-2 py-1 text-white">Edit</button>
                <button disabled={busy === room.id} onClick={() => changeCapacity(room)} className="rounded bg-amber-500 px-2 py-1 text-white">Capacity</button>
                <button disabled={busy === room.id} onClick={() => toggleActive(room)} className="rounded bg-slate-500 px-2 py-1 text-white">{room.isActive ? 'Deactivate' : 'Activate'}</button>
              </div>
            </div>
          </div>
        ))}
        {data && data.rooms.length === 0 && <p className="text-slate-500">No rooms yet.</p>}
      </div>

      {creating && <CreateRoomModal onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />}
      {editing && <EditRoomModal room={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function CreateRoomModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const price = Number(form.price);
    const capacity = Number(form.capacity);
    if (!/^[a-z0-9_-]{1,32}$/.test(form.code)) return setError('Code: lowercase letters, digits, _ or - (max 32 chars)');
    if (!form.name.trim()) return setError('Name is required');
    if (!(price > 0)) return setError('Price must be greater than 0');
    if (!Number.isInteger(capacity) || capacity < 1) return setError('Capacity must be a whole number of at least 1');
    setBusy(true);
    try {
      await adminApi.createMyRoom({
        code: form.code,
        name: form.name.trim(),
        price,
        capacity,
        maxPerPlayer: form.maxPerPlayer ? Number(form.maxPerPlayer) : undefined,
      });
      alert('Submitted for Super Admin approval — a new room adds cartelas to your total inventory.');
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New room" onClose={onClose}>
      <div className="space-y-3">
        <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Code (e.g. vip100)" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
        <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Display name (e.g. VIP 100 room)" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <input type="number" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Price (ETB)" value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} />
        <input type="number" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Capacity (number of cartelas)" value={form.capacity} onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))} />
        <input type="number" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Max per player (optional)" value={form.maxPerPlayer} onChange={(e) => setForm((f) => ({ ...f, maxPerPlayer: e.target.value }))} />
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button onClick={submit} disabled={busy} className="w-full rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? 'Submitting…' : 'Submit for approval'}
        </button>
      </div>
    </Modal>
  );
}

function EditRoomModal({ room, onClose, onSaved }: { room: RoomInventoryRow; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(room.name);
  const [price, setPrice] = useState(String(room.price));
  const [maxPerPlayer, setMaxPerPlayer] = useState(room.maxPerPlayer ? String(room.maxPerPlayer) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await adminApi.updateMyRoom(room.id, {
        name: name.trim() || undefined,
        price: price ? Number(price) : undefined,
        maxPerPlayer: maxPerPlayer ? Number(maxPerPlayer) : null,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Edit ${room.name}`} onClose={onClose}>
      <div className="space-y-3">
        <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="number" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Price (ETB)" value={price} onChange={(e) => setPrice(e.target.value)} />
        <input type="number" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Max per player (blank = operator-wide limit)" value={maxPerPlayer} onChange={(e) => setMaxPerPlayer(e.target.value)} />
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button onClick={submit} disabled={busy} className="w-full rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { adminApi, StaffRow } from '../adminApi';
import { Modal } from '../components/Modal';
import { OPERATOR_PERMISSION_CATALOG } from '../permissionCatalog';

export function OperatorStaff() {
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [permissionsFor, setPermissionsFor] = useState<StaffRow | null>(null);

  const load = useCallback(() => {
    adminApi.listMyStaff().then(setRows).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const setStatus = async (s: StaffRow, status: 'active' | 'suspended' | 'disabled') => {
    setBusy(s.id);
    try {
      await adminApi.setMyStaffStatus(s.id, status);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const resetPassword = async (s: StaffRow) => {
    const pw = window.prompt(`New password for "${s.username}" (min 10 characters):`);
    if (!pw) return;
    if (pw.length < 10) return alert('Password must be at least 10 characters');
    setBusy(s.id);
    try {
      await adminApi.resetMyStaffPassword(s.id, pw);
      alert('Password reset. All active sessions for this account were revoked.');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (s: StaffRow) => {
    if (!window.confirm(`Delete staff account "${s.username}"?`)) return;
    setBusy(s.id);
    try {
      await adminApi.removeMyStaff(s.id);
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
        <h1 className="text-xl font-bold">Staff</h1>
        <button onClick={() => setCreating(true)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white">
          + New staff
        </button>
      </div>
      {err && <p className="mb-3 text-sm text-red-500">{err}</p>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Username</th>
              <th className="px-3 py-2">Full name</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Permissions</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-t border-slate-100 align-top">
                <td className="px-3 py-2 font-medium">{s.username}</td>
                <td className="px-3 py-2">{s.fullName}</td>
                <td className="px-3 py-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${s.role === 'OPERATOR_OWNER' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>{s.role}</span>
                </td>
                <td className="px-3 py-2"><span className={s.status === 'active' ? 'text-emerald-600' : 'text-red-500'}>{s.status}</span></td>
                <td className="px-3 py-2">
                  {s.role === 'OPERATOR_OWNER' ? (
                    <span className="text-xs text-slate-400">all operator permissions</span>
                  ) : s.permissions.length === 0 ? (
                    <span className="text-xs text-slate-400">none</span>
                  ) : (
                    <div className="flex max-w-xs flex-wrap gap-1">
                      {s.permissions.map((p) => <span key={p} className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">{p}</span>)}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  {s.role === 'OPERATOR_OWNER' ? (
                    <span className="text-xs text-slate-400">the owner</span>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      <button onClick={() => setPermissionsFor(s)} className="rounded bg-sky-600 px-2 py-1 text-xs text-white">Permissions</button>
                      {s.status === 'active' ? (
                        <button disabled={busy === s.id} onClick={() => setStatus(s, 'disabled')} className="rounded bg-slate-500 px-2 py-1 text-xs text-white">Disable</button>
                      ) : (
                        <button disabled={busy === s.id} onClick={() => setStatus(s, 'active')} className="rounded bg-emerald-600 px-2 py-1 text-xs text-white">Enable</button>
                      )}
                      <button disabled={busy === s.id} onClick={() => resetPassword(s)} className="rounded bg-amber-500 px-2 py-1 text-xs text-white">Reset PW</button>
                      <button disabled={busy === s.id} onClick={() => remove(s)} className="rounded bg-red-500 px-2 py-1 text-xs text-white">Delete</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No staff yet</td></tr>}
          </tbody>
        </table>
      </div>

      {creating && <CreateStaffModal onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />}
      {permissionsFor && <PermissionsModal staff={permissionsFor} onClose={() => setPermissionsFor(null)} onSaved={() => { setPermissionsFor(null); load(); }} />}
    </div>
  );
}

function PermissionCheckboxes({ selected, onChange }: { selected: Set<string>; onChange: (next: Set<string>) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {OPERATOR_PERMISSION_CATALOG.map((key) => (
        <label key={key} className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={selected.has(key)}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.target.checked) next.add(key); else next.delete(key);
              onChange(next);
            }}
          />
          {key}
        </label>
      ))}
    </div>
  );
}

const STAFF_PRESETS: { label: string; permissions: string[] }[] = [
  {
    label: 'Deposit Manager',
    permissions: ['VIEW_DEPOSITS', 'APPROVE_DEPOSITS', 'REJECT_DEPOSITS', 'VIEW_WALLETS'],
  },
  {
    label: 'Support Agent',
    permissions: ['VIEW_USERS', 'VIEW_DEPOSITS', 'VIEW_WITHDRAWALS', 'MANAGE_SUPPORT_TICKETS', 'VIEW_SUPPORT_TICKETS'],
  },
  {
    label: 'Marketing Manager',
    permissions: ['VIEW_REFERRALS', 'VIEW_REFERRAL_REPORTS', 'VIEW_REPORTS', 'EXPORT_REPORTS'],
  },
];

function CreateStaffModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const applyPreset = (preset: typeof STAFF_PRESETS[number]) => {
    setPermissions(new Set(preset.permissions));
  };

  const submit = async () => {
    setError(null);
    if (username.length < 3) return setError('Username must be at least 3 characters');
    if (password && password.length < 10) return setError('Password must be at least 10 characters');
    if (!fullName.trim()) return setError('Full name is required');
    setBusy(true);
    try {
      await adminApi.createMyStaff({ username, password: password || undefined, fullName, permissions: Array.from(permissions) });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Create staff account" onClose={onClose}>
      <div className="space-y-3">
        <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input type="password" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Password (leave blank to auto-generate)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        <div>
          <p className="mb-1.5 text-xs font-semibold text-slate-500">Role presets</p>
          <div className="flex flex-wrap gap-2">
            {STAFF_PRESETS.map((p) => (
              <button key={p.label} type="button" onClick={() => applyPreset(p)} className="rounded-full border border-sky-300 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-700 hover:bg-sky-100">
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-xs font-semibold text-slate-500">Permissions (you can only grant what you hold yourself)</p>
          <PermissionCheckboxes selected={permissions} onChange={setPermissions} />
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button onClick={submit} disabled={busy} className="w-full rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? 'Creating…' : 'Create staff account'}
        </button>
      </div>
    </Modal>
  );
}

function PermissionsModal({ staff, onClose, onSaved }: { staff: StaffRow; onClose: () => void; onSaved: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set(staff.permissions));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await adminApi.setMyStaffPermissions(staff.id, Array.from(selected));
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Permissions — ${staff.username}`} onClose={onClose}>
      <PermissionCheckboxes selected={selected} onChange={setSelected} />
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
      <button onClick={save} disabled={busy} className="mt-4 w-full rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white disabled:opacity-50">
        {busy ? 'Saving…' : 'Save permissions'}
      </button>
    </Modal>
  );
}

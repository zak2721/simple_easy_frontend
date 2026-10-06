import { useCallback, useEffect, useState } from 'react';
import { adminApi, AdminRow, AuditRow } from '../adminApi';

/**
 * Super-Admin-only page (route-gated in AdminApp.tsx; every action here is
 * ALSO re-enforced server-side by SuperAdminGuard regardless of what this
 * component shows — frontend visibility is never the security boundary).
 */
export function AdminManagement() {
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [activityFor, setActivityFor] = useState<AdminRow | null>(null);
  const [permissionsFor, setPermissionsFor] = useState<AdminRow | null>(null);

  const load = useCallback(() => {
    adminApi.listAdmins().then(setAdmins).catch((e) => setErr(e.message));
  }, []);

  useEffect(() => {
    load();
    adminApi.permissionCatalog().then((r) => setCatalog(r.map((p) => p.key))).catch(() => {});
  }, [load]);

  const setStatus = async (a: AdminRow, status: 'active' | 'suspended' | 'disabled') => {
    setBusy(a.id);
    try {
      await adminApi.setAdminStatus(a.id, status);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (a: AdminRow) => {
    if (!window.confirm(`Permanently delete admin "${a.username}"? This cannot be undone.`)) return;
    setBusy(a.id);
    try {
      await adminApi.deleteAdmin(a.id);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const resetPassword = async (a: AdminRow) => {
    const pw = window.prompt(`New password for "${a.username}" (min 10 characters):`);
    if (!pw) return;
    if (pw.length < 10) return alert('Password must be at least 10 characters');
    setBusy(a.id);
    try {
      await adminApi.resetPassword(a.id, pw);
      alert('Password reset. All of this admin\'s active sessions were revoked.');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const forceDisableTotp = async (a: AdminRow) => {
    if (!window.confirm(`Turn off two-factor authentication for "${a.username}"? Use this only when they've lost access to their authenticator.`)) return;
    setBusy(a.id);
    try {
      await adminApi.forceDisableTwoFactor(a.id);
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
        <h1 className="text-xl font-bold">Admins</h1>
        <button onClick={() => setCreating(true)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white">
          + Create Admin
        </button>
      </div>
      {err && <p className="text-red-500">{err}</p>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Username</th>
              <th className="px-3 py-2">Full name</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Permissions</th>
              <th className="px-3 py-2">2FA</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {admins.map((a) => (
              <tr key={a.id} className="border-t border-slate-100 align-top">
                <td className="px-3 py-2 font-medium">{a.username}</td>
                <td className="px-3 py-2">{a.fullName}</td>
                <td className="px-3 py-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${a.role === 'SUPER_ADMIN' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                    {a.role}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className={a.status === 'active' ? 'text-emerald-600' : 'text-red-500'}>{a.status}</span>
                </td>
                <td className="px-3 py-2">
                  {a.role === 'SUPER_ADMIN' ? (
                    <span className="text-xs text-slate-400">unrestricted</span>
                  ) : a.permissions.length === 0 ? (
                    <span className="text-xs text-slate-400">none</span>
                  ) : (
                    <div className="flex max-w-xs flex-wrap gap-1">
                      {a.permissions.map((p) => (
                        <span key={p} className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">{p}</span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span className={a.totpEnabled ? 'text-emerald-600' : 'text-slate-400'}>{a.totpEnabled ? 'on' : 'off'}</span>
                </td>
                <td className="px-3 py-2 text-slate-400">{new Date(a.createdAt).toLocaleDateString()}</td>
                <td className="px-3 py-2">
                  {a.role === 'SUPER_ADMIN' ? (
                    <span className="text-xs text-slate-400">protected</span>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      <button onClick={() => setPermissionsFor(a)} className="rounded bg-sky-600 px-2 py-1 text-xs text-white">Permissions</button>
                      {a.status === 'active' ? (
                        <button disabled={busy === a.id} onClick={() => setStatus(a, 'disabled')} className="rounded bg-slate-500 px-2 py-1 text-xs text-white">Disable</button>
                      ) : (
                        <button disabled={busy === a.id} onClick={() => setStatus(a, 'active')} className="rounded bg-emerald-600 px-2 py-1 text-xs text-white">Enable</button>
                      )}
                      <button disabled={busy === a.id} onClick={() => resetPassword(a)} className="rounded bg-amber-500 px-2 py-1 text-xs text-white">Reset PW</button>
                      {a.totpEnabled && (
                        <button disabled={busy === a.id} onClick={() => forceDisableTotp(a)} className="rounded bg-orange-500 px-2 py-1 text-xs text-white">Force off 2FA</button>
                      )}
                      <button onClick={() => setActivityFor(a)} className="rounded bg-slate-200 px-2 py-1 text-xs text-slate-700">Activity</button>
                      <button disabled={busy === a.id} onClick={() => remove(a)} className="rounded bg-red-500 px-2 py-1 text-xs text-white">Delete</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {admins.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">No admins yet</td></tr>}
          </tbody>
        </table>
      </div>

      {creating && (
        <CreateAdminModal
          catalog={catalog}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); load(); }}
        />
      )}
      {permissionsFor && (
        <PermissionsModal
          admin={permissionsFor}
          catalog={catalog}
          onClose={() => setPermissionsFor(null)}
          onSaved={() => { setPermissionsFor(null); load(); }}
        />
      )}
      {activityFor && <ActivityModal admin={activityFor} onClose={() => setActivityFor(null)} />}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function PermissionCheckboxes({ catalog, selected, onChange }: { catalog: string[]; selected: Set<string>; onChange: (next: Set<string>) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {catalog.map((key) => (
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

function CreateAdminModal({ catalog, onClose, onCreated }: { catalog: string[]; onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (username.length < 3) return setError('Username must be at least 3 characters');
    if (password.length < 10) return setError('Password must be at least 10 characters');
    if (!fullName.trim()) return setError('Full name is required');
    setBusy(true);
    try {
      await adminApi.createAdmin(username, password, fullName, Array.from(permissions));
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Create Admin" onClose={onClose}>
      <div className="space-y-3">
        <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input type="password" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Password (min 10 chars)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        <div>
          <p className="mb-1.5 text-xs font-semibold text-slate-500">Permissions</p>
          <PermissionCheckboxes catalog={catalog} selected={permissions} onChange={setPermissions} />
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button onClick={submit} disabled={busy} className="w-full rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? 'Creating…' : 'Create Admin'}
        </button>
      </div>
    </Modal>
  );
}

function PermissionsModal({ admin, catalog, onClose, onSaved }: { admin: AdminRow; catalog: string[]; onClose: () => void; onSaved: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set(admin.permissions));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await adminApi.setPermissions(admin.id, Array.from(selected));
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Permissions — ${admin.username}`} onClose={onClose}>
      <PermissionCheckboxes catalog={catalog} selected={selected} onChange={setSelected} />
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
      <button onClick={save} disabled={busy} className="mt-4 w-full rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white disabled:opacity-50">
        {busy ? 'Saving…' : 'Save permissions'}
      </button>
    </Modal>
  );
}

function ActivityModal({ admin, onClose }: { admin: AdminRow; onClose: () => void }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    adminApi.adminActivity(admin.id).then(setRows).catch((e) => setErr(e.message));
  }, [admin.id]);

  return (
    <Modal title={`Activity — ${admin.username}`} onClose={onClose}>
      {err && <p className="text-red-500">{err}</p>}
      <div className="max-h-96 space-y-2 overflow-y-auto">
        {rows.map((r) => (
          <div key={r.id} className="rounded-lg border border-slate-100 p-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold">{r.action}</span>
              <span className="text-slate-400">{new Date(r.created_at).toLocaleString()}</span>
            </div>
            <div className="text-slate-500">{r.entity_type}{r.entity_id ? ` · ${r.entity_id}` : ''}{r.ip_address ? ` · ${r.ip_address}` : ''}</div>
            {r.reason && <div className="mt-1 text-slate-600">{r.reason}</div>}
          </div>
        ))}
        {rows.length === 0 && !err && <p className="py-6 text-center text-slate-400">No recorded activity</p>}
      </div>
    </Modal>
  );
}

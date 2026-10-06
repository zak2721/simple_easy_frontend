import { useEffect, useState } from 'react';
import { adminApi, ContactRow } from '../adminApi';

const FIELDS: { key: keyof Omit<ContactRow, 'configured'>; label: string; placeholder?: string }[] = [
  { key: 'telegram', label: 'Telegram username', placeholder: '@yena_support' },
  { key: 'phone', label: 'Phone number', placeholder: '09xxxxxxxx' },
  { key: 'whatsapp', label: 'WhatsApp number', placeholder: '2519xxxxxxxx' },
  { key: 'email', label: 'Email address', placeholder: 'support@example.com' },
  { key: 'support_hours', label: 'Support hours', placeholder: 'Mon–Fri, 9am–6pm' },
];

export function AdminContactCenter({ role, permissions }: { role: string; permissions: string[] }) {
  const isSuperAdmin = role === 'SUPER_ADMIN';
  const canManage = isSuperAdmin || permissions.includes('MANAGE_CONTACT_CENTER');
  const [values, setValues] = useState<ContactRow | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    adminApi.getContact().then(setValues).catch(() => {});
  }, []);

  const save = async () => {
    if (!values) return;
    setSaving(true);
    setStatus(null);
    try {
      const updated = await adminApi.updateContact({
        telegram: values.telegram,
        phone: values.phone,
        whatsapp: values.whatsapp,
        email: values.email,
        supportHours: values.support_hours,
      });
      setValues(updated);
      setStatus('Saved ✓');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  if (!values) return <p className="text-slate-500">Loading…</p>;

  return (
    <div className="max-w-xl">
      <h1 className="mb-1 text-xl font-bold">Contact Center</h1>
      <p className="mb-4 text-sm text-slate-500">Shown to players in the Mini App's Contact & Support screen.</p>

      <div className="space-y-4">
        {FIELDS.map((f) => (
          <div key={f.key} className="rounded-xl border border-slate-200 bg-white p-4">
            <label className="block text-sm font-medium text-slate-700">{f.label}</label>
            <input
              type="text"
              disabled={!canManage}
              value={values[f.key]}
              placeholder={f.placeholder}
              onChange={(e) => setValues((v) => (v ? { ...v, [f.key]: e.target.value } : v))}
              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
            />
          </div>
        ))}
      </div>

      {canManage && (
        <button onClick={save} disabled={saving} className="mt-4 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
      {status && <p className="mt-2 text-xs text-slate-500">{status}</p>}
    </div>
  );
}

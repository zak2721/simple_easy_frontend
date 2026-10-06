import { useEffect, useState } from 'react';
import { adminApi, BonusSettings } from '../adminApi';

export function AdminBonusSettings({ role, permissions }: { role: string; permissions: string[] }) {
  const canManage = role === 'SUPER_ADMIN' || permissions.includes('MANAGE_BONUS_SETTINGS');
  const [settings, setSettings] = useState<BonusSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    adminApi.getBonusSettings().then(setSettings).catch((e) => setErr(e.message));
  }, []);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setStatus(null);
    try {
      const updated = await adminApi.updateBonusSettings(settings);
      setSettings(updated);
      setStatus('Saved ✓');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  if (err) return <p className="text-sm text-red-500">{err}</p>;
  if (!settings) return <p className="text-slate-500">Loading…</p>;

  return (
    <div className="max-w-xl">
      <h1 className="mb-1 text-xl font-bold">Welcome Bonus</h1>
      <p className="mb-4 text-sm text-slate-500">
        Granted automatically, once per player, on their first Mini App login.
        Changing these values only affects bonuses granted after saving —
        existing grants are never retroactively altered.
      </p>

      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={!canManage}
            onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
          />
          Enabled
        </label>

        <div>
          <label className="block text-sm font-medium text-slate-700">Amount (ETB)</label>
          <input
            type="number"
            min={0}
            step="0.01"
            disabled={!canManage}
            value={settings.amountEtb}
            onChange={(e) => setSettings({ ...settings, amountEtb: Number(e.target.value) })}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700">Wagering multiplier</label>
          <p className="text-xs text-slate-400">The bonus must be wagered this many times its amount before it becomes withdrawable.</p>
          <input
            type="number"
            min={0}
            step="0.5"
            disabled={!canManage}
            value={settings.wageringMultiplier}
            onChange={(e) => setSettings({ ...settings, wageringMultiplier: Number(e.target.value) })}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
          />
        </div>

        {canManage && (
          <button onClick={save} disabled={saving} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
        {!canManage && <p className="text-xs text-slate-400">You don't have permission to change these settings.</p>}
        {status && <p className="text-xs text-slate-500">{status}</p>}
      </div>
    </div>
  );
}

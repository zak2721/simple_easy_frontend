import { useCallback, useEffect, useState } from 'react';
import { adminApi, ThemeRow } from '../adminApi';
import { fileToBase64 } from '../../lib/api-client';

const COLOR_FIELDS: { key: keyof ThemeRow; label: string }[] = [
  { key: 'primaryColor', label: 'Primary' },
  { key: 'secondaryColor', label: 'Secondary' },
  { key: 'backgroundColor', label: 'Background' },
  { key: 'textColor', label: 'Text' },
  { key: 'surfaceColor', label: 'Surface' },
  { key: 'surfaceAltColor', label: 'Surface (alt)' },
  { key: 'mutedTextColor', label: 'Muted text' },
  { key: 'accentColor', label: 'Accent' },
  { key: 'buttonBackgroundColor', label: 'Button background' },
  { key: 'buttonTextColor', label: 'Button text' },
];

const emptyForm = {
  name: '', slug: '',
  primaryColor: '#12a150', secondaryColor: '#0b7d3e', backgroundColor: '#0b1220', textColor: '#e8edf6',
  surfaceColor: '#131c2e', surfaceAltColor: '#1b2740', mutedTextColor: '#93a1b8', accentColor: '#ffd166',
  buttonBackgroundColor: '#0b7d3e', buttonTextColor: '#ffffff',
  logoUrl: '', bannerUrl: '',
  scheduledStartAt: '', scheduledEndAt: '',
};

export function AdminThemes({ role, permissions }: { role: string; permissions: string[] }) {
  const isSuperAdmin = role === 'SUPER_ADMIN';
  const canManage = isSuperAdmin || permissions.includes('MANAGE_THEMES');
  const [rows, setRows] = useState<ThemeRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi.themes().then(setRows).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const startCreate = () => {
    setCreating(true);
    setEditingId(null);
    setForm(emptyForm);
  };

  const startEdit = (row: ThemeRow) => {
    setEditingId(row.id);
    setCreating(false);
    setForm({
      name: row.name, slug: row.slug,
      primaryColor: row.primaryColor, secondaryColor: row.secondaryColor, backgroundColor: row.backgroundColor, textColor: row.textColor,
      surfaceColor: row.surfaceColor, surfaceAltColor: row.surfaceAltColor, mutedTextColor: row.mutedTextColor, accentColor: row.accentColor,
      buttonBackgroundColor: row.buttonBackgroundColor ?? '#000000', buttonTextColor: row.buttonTextColor ?? '#ffffff',
      logoUrl: row.logoUrl ?? '', bannerUrl: row.bannerUrl ?? '',
      scheduledStartAt: row.scheduledStartAt ? row.scheduledStartAt.slice(0, 16) : '',
      scheduledEndAt: row.scheduledEndAt ? row.scheduledEndAt.slice(0, 16) : '',
    });
  };

  const cancel = () => { setCreating(false); setEditingId(null); };

  const upload = async (kind: 'logo' | 'banner', file: File) => {
    setBusy(`upload-${kind}`);
    try {
      const base64 = await fileToBase64(file);
      const { url } = await adminApi.uploadThemeAsset(base64, kind);
      setForm((f) => ({ ...f, [kind === 'logo' ? 'logoUrl' : 'bannerUrl']: url }));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    try {
      const dto = {
        name: form.name,
        ...(creating ? { slug: form.slug } : {}),
        primaryColor: form.primaryColor, secondaryColor: form.secondaryColor, backgroundColor: form.backgroundColor, textColor: form.textColor,
        surfaceColor: form.surfaceColor, surfaceAltColor: form.surfaceAltColor, mutedTextColor: form.mutedTextColor, accentColor: form.accentColor,
        buttonBackgroundColor: form.buttonBackgroundColor, buttonTextColor: form.buttonTextColor,
        logoUrl: form.logoUrl || undefined, bannerUrl: form.bannerUrl || undefined,
        scheduledStartAt: form.scheduledStartAt ? new Date(form.scheduledStartAt).toISOString() : null,
        scheduledEndAt: form.scheduledEndAt ? new Date(form.scheduledEndAt).toISOString() : null,
      };
      if (editingId) {
        await adminApi.updateTheme(editingId, dto);
      } else {
        await adminApi.createTheme(dto);
      }
      cancel();
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const act = async (id: string, action: 'activate' | 'deactivate' | 'setDefault' | 'delete') => {
    setBusy(id);
    try {
      if (action === 'activate') await adminApi.activateTheme(id);
      else if (action === 'deactivate') await adminApi.deactivateTheme(id);
      else if (action === 'setDefault') await adminApi.setDefaultTheme(id);
      else if (action === 'delete') {
        if (!window.confirm('Delete this theme?')) { setBusy(null); return; }
        await adminApi.deleteTheme(id);
      }
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
        <h1 className="text-xl font-bold">Themes</h1>
        {canManage && !creating && !editingId && (
          <button onClick={startCreate} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white">+ New theme</button>
        )}
      </div>

      {err && <p className="text-sm text-red-500">{err}</p>}

      {(creating || editingId) && (
        <div className="mb-4 space-y-4 rounded-xl border border-slate-200 bg-white p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700">Name</label>
              <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </div>
            {creating && (
              <div>
                <label className="block text-sm font-medium text-slate-700">Slug</label>
                <input value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value.toLowerCase() }))} placeholder="dark-mode" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </div>
            )}
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-slate-700">Colors</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {COLOR_FIELDS.map((f) => (
                <label key={f.key} className="text-xs text-slate-500">
                  {f.label}
                  <input
                    type="color"
                    value={(form as Record<string, string>)[f.key] || '#000000'}
                    onChange={(e) => setForm((cur) => ({ ...cur, [f.key]: e.target.value }))}
                    className="mt-1 block h-8 w-full cursor-pointer rounded border border-slate-300"
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700">Logo</label>
              <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && upload('logo', e.target.files[0])} className="mt-1 text-xs" />
              {form.logoUrl && <img src={form.logoUrl} alt="logo preview" className="mt-2 h-10 w-10 rounded object-contain" />}
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Banner</label>
              <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && upload('banner', e.target.files[0])} className="mt-1 text-xs" />
              {form.bannerUrl && <img src={form.bannerUrl} alt="banner preview" className="mt-2 h-10 w-full rounded object-cover" />}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700">Schedule start (optional)</label>
              <input type="datetime-local" value={form.scheduledStartAt} onChange={(e) => setForm((f) => ({ ...f, scheduledStartAt: e.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Schedule end (optional)</label>
              <input type="datetime-local" value={form.scheduledEndAt} onChange={(e) => setForm((f) => ({ ...f, scheduledEndAt: e.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </div>
          </div>

          <div className="flex gap-2">
            <button onClick={save} disabled={busy === 'save' || !form.name || (creating && !form.slug)} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            <button onClick={cancel} className="rounded-lg bg-slate-200 px-3 py-2 text-sm font-semibold text-slate-700">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.id} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="h-8 w-8 shrink-0 rounded-full border border-slate-200" style={{ background: row.primaryColor }} />
                <div>
                  <p className="font-bold">
                    {row.name}
                    {row.isDefault && <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">DEFAULT</span>}
                    {!row.isActive && <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">INACTIVE</span>}
                  </p>
                  <p className="text-xs text-slate-400">
                    {row.slug}
                    {row.scheduledStartAt && ` · scheduled ${new Date(row.scheduledStartAt).toLocaleDateString()}–${row.scheduledEndAt ? new Date(row.scheduledEndAt).toLocaleDateString() : '…'}`}
                  </p>
                </div>
              </div>
              {canManage && (
                <div className="flex shrink-0 flex-wrap justify-end gap-2 text-xs">
                  <button onClick={() => startEdit(row)} className="text-emerald-600">Edit</button>
                  {row.isActive ? (
                    <button onClick={() => act(row.id, 'deactivate')} disabled={busy === row.id} className="text-slate-500">Deactivate</button>
                  ) : (
                    <button onClick={() => act(row.id, 'activate')} disabled={busy === row.id} className="text-slate-500">Activate</button>
                  )}
                  {!row.isDefault && <button onClick={() => act(row.id, 'setDefault')} disabled={busy === row.id} className="text-slate-500">Set default</button>}
                  {!row.isDefault && <button onClick={() => act(row.id, 'delete')} disabled={busy === row.id} className="text-red-500">Delete</button>}
                </div>
              )}
            </div>
          </div>
        ))}
        {rows.length === 0 && !err && <p className="text-slate-500">No themes yet.</p>}
      </div>
    </div>
  );
}

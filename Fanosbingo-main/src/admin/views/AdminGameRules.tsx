import { useCallback, useEffect, useState } from 'react';
import { adminApi, GameRuleRow } from '../adminApi';

const emptyForm = { title: '', body: '', category: '' };

export function AdminGameRules({ role, permissions }: { role: string; permissions: string[] }) {
  const isSuperAdmin = role === 'SUPER_ADMIN';
  const canManage = isSuperAdmin || permissions.includes('MANAGE_GAME_RULES');
  const [rows, setRows] = useState<GameRuleRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi.gameRules().then(setRows).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const startEdit = (row: GameRuleRow) => {
    setEditingId(row.id);
    setCreating(false);
    setForm({ title: row.title, body: row.body, category: row.category ?? '' });
  };

  const startCreate = () => {
    setCreating(true);
    setEditingId(null);
    setForm(emptyForm);
  };

  const cancel = () => {
    setCreating(false);
    setEditingId(null);
    setForm(emptyForm);
  };

  const save = async () => {
    setBusy('save');
    try {
      const dto = { title: form.title, body: form.body, category: form.category.trim() || undefined };
      if (editingId) {
        await adminApi.updateGameRule(editingId, dto);
      } else {
        await adminApi.createGameRule(dto);
      }
      cancel();
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const toggleActive = async (row: GameRuleRow) => {
    setBusy(row.id);
    try {
      await adminApi.updateGameRule(row.id, { isActive: !row.isActive });
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (row: GameRuleRow) => {
    if (!window.confirm(`Delete rule "${row.title}"?`)) return;
    setBusy(row.id);
    try {
      await adminApi.deleteGameRule(row.id);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const reorder = async (row: GameRuleRow, direction: 'up' | 'down') => {
    setBusy(row.id);
    try {
      const updated = await adminApi.reorderGameRule(row.id, direction);
      setRows(updated);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-xl font-bold">Game Rules</h1>
        {canManage && !creating && !editingId && (
          <button onClick={startCreate} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white">
            + New rule
          </button>
        )}
      </div>

      {err && <p className="text-sm text-red-500">{err}</p>}

      {(creating || editingId) && (
        <div className="mb-4 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <div>
            <label className="block text-sm font-medium text-slate-700">Title</label>
            <input
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">Body</label>
            <textarea
              rows={4}
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              className="mt-1 w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">Category (optional)</label>
            <input
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              placeholder="e.g. How to play, Winning patterns, Deposits"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={busy === 'save' || !form.title || !form.body} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            <button onClick={cancel} className="rounded-lg bg-slate-200 px-3 py-2 text-sm font-semibold text-slate-700">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={row.id} className={`rounded-xl border bg-white p-4 ${row.isActive ? 'border-slate-200' : 'border-slate-200 opacity-60'}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-bold">{row.title} {!row.isActive && <span className="ml-1 text-xs font-normal text-slate-400">(inactive)</span>}</p>
                {row.category && <p className="text-xs text-slate-400">{row.category}</p>}
                <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{row.body}</p>
              </div>
              {canManage && (
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <div className="flex gap-1">
                    <button onClick={() => reorder(row, 'up')} disabled={i === 0 || busy === row.id} className="rounded border border-slate-200 px-2 py-0.5 text-xs disabled:opacity-30">↑</button>
                    <button onClick={() => reorder(row, 'down')} disabled={i === rows.length - 1 || busy === row.id} className="rounded border border-slate-200 px-2 py-0.5 text-xs disabled:opacity-30">↓</button>
                  </div>
                  <div className="flex gap-2 text-xs">
                    <button onClick={() => startEdit(row)} className="text-emerald-600">Edit</button>
                    <button onClick={() => toggleActive(row)} className="text-slate-500">{row.isActive ? 'Deactivate' : 'Activate'}</button>
                    <button onClick={() => remove(row)} className="text-red-500">Delete</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
        {rows.length === 0 && !err && <p className="text-slate-500">No rules yet.</p>}
      </div>
    </div>
  );
}

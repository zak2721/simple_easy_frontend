import { useCallback, useEffect, useState } from 'react';
import { adminApi, FaqRow } from '../adminApi';

const emptyForm = { question: '', answer: '' };

export function AdminFaq({ role, permissions }: { role: string; permissions: string[] }) {
  const canManage = role === 'SUPER_ADMIN' || role === 'OPERATOR_OWNER' || permissions.includes('MANAGE_GAME_RULES');
  const [rows, setRows] = useState<FaqRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi.faqList().then(setRows).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const startEdit = (row: FaqRow) => { setEditingId(row.id); setCreating(false); setForm({ question: row.question, answer: row.answer }); };
  const startCreate = () => { setCreating(true); setEditingId(null); setForm(emptyForm); };
  const cancel = () => { setCreating(false); setEditingId(null); setForm(emptyForm); };

  const save = async () => {
    setBusy('save');
    try {
      if (editingId) await adminApi.updateFaq(editingId, form);
      else await adminApi.createFaq(form);
      cancel();
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const toggleActive = async (row: FaqRow) => {
    setBusy(row.id);
    try {
      await adminApi.updateFaq(row.id, { isActive: !row.isActive });
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (row: FaqRow) => {
    if (!window.confirm(`Delete FAQ entry "${row.question}"?`)) return;
    setBusy(row.id);
    try {
      await adminApi.deleteFaq(row.id);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const reorder = async (row: FaqRow, direction: 'up' | 'down') => {
    setBusy(row.id);
    try {
      const updated = await adminApi.reorderFaq(row.id, direction);
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
        <h1 className="text-xl font-bold">FAQ</h1>
        {canManage && !creating && !editingId && (
          <button onClick={startCreate} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white">+ New entry</button>
        )}
      </div>
      {err && <p className="text-sm text-red-500">{err}</p>}

      {(creating || editingId) && (
        <div className="mb-4 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <div>
            <label className="block text-sm font-medium text-slate-700">Question</label>
            <input value={form.question} onChange={(e) => setForm((f) => ({ ...f, question: e.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">Answer</label>
            <textarea rows={4} value={form.answer} onChange={(e) => setForm((f) => ({ ...f, answer: e.target.value }))} className="mt-1 w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={busy === 'save' || !form.question || !form.answer} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
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
                <p className="font-bold">{row.question} {!row.isActive && <span className="ml-1 text-xs font-normal text-slate-400">(inactive)</span>}</p>
                <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{row.answer}</p>
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
        {rows.length === 0 && !err && <p className="text-slate-500">No FAQ entries yet.</p>}
      </div>
    </div>
  );
}

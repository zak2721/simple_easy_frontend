import { useCallback, useEffect, useState } from 'react';
import { adminApi, BrandingResponse, fileToBase64 } from '../adminApi';

export function OperatorBranding() {
  const [data, setData] = useState<BrandingResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi.myBranding().then((r) => {
      setData(r);
      setDisplayName(r.displayName);
      setWelcomeMessage(r.welcomeMessage ?? '');
    }).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const submitName = async () => {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      const r = await adminApi.updateMyBranding({ displayName });
      setMsg(r.submittedForApproval.length ? 'Name change submitted for Super Admin approval.' : 'No change.');
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const submitWelcome = async () => {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      await adminApi.updateMyBranding({ welcomeMessage: welcomeMessage.trim() || null });
      setMsg('Welcome message updated.');
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const uploadLogo = async (file: File) => {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      const b64 = await fileToBase64(file);
      const { url } = await adminApi.uploadMyBrandingAsset(b64);
      const r = await adminApi.updateMyBranding({ logoUrl: url });
      setMsg(r.submittedForApproval.length ? 'Logo change submitted for Super Admin approval.' : 'Logo updated.');
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const cancelPending = async (id: string) => {
    setBusy(true);
    try {
      await adminApi.cancelMyApproval(id);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <div>{err ? <p className="text-red-500">{err}</p> : <p className="text-slate-500">Loading…</p>}</div>;

  return (
    <div className="max-w-xl">
      <h1 className="mb-1 text-xl font-bold">Branding</h1>
      <p className="mb-4 text-sm text-slate-500">Name, logo and theme changes need Super Admin approval. Welcome message and banners apply immediately.</p>

      {err && <p className="mb-3 text-sm text-red-500">{err}</p>}
      {msg && <p className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{msg}</p>}

      {data.pendingChanges && data.pendingChanges.length > 0 && (
        <div className="mb-4 space-y-2">
          {data.pendingChanges.map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
              <span>{p.label} pending approval (submitted {new Date(p.submittedAt).toLocaleString()})</span>
              <button disabled={busy} onClick={() => cancelPending(p.id)} className="text-xs text-red-500">Cancel</button>
            </div>
          ))}
        </div>
      )}

      <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
        <p className="mb-2 text-sm font-bold">Current logo</p>
        {data.logoUrl ? <img src={data.logoUrl} alt="logo" className="h-16 w-16 rounded object-cover" /> : <p className="text-sm text-slate-400">No logo set</p>}
        <input
          type="file"
          accept="image/*"
          className="mt-3 text-sm"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo(f); }}
          disabled={busy}
        />
      </div>

      <div className="mb-4 space-y-2 rounded-xl border border-slate-200 bg-white p-4">
        <label className="block text-sm font-medium text-slate-700">Bingo name</label>
        <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <button onClick={submitName} disabled={busy || displayName === data.displayName} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          Submit for approval
        </button>
      </div>

      <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
        <label className="block text-sm font-medium text-slate-700">Welcome message (applies immediately)</label>
        <textarea rows={3} className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm" value={welcomeMessage} onChange={(e) => setWelcomeMessage(e.target.value)} />
        <button onClick={submitWelcome} disabled={busy} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          Save
        </button>
      </div>
    </div>
  );
}

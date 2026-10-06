import { useCallback, useEffect, useState } from 'react';
import { adminApi, ApprovalRow } from '../adminApi';

const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-100 text-slate-500',
  superseded: 'bg-slate-100 text-slate-400',
};

function describe(r: ApprovalRow): string {
  const p = r.proposedValue as Record<string, unknown>;
  switch (r.type) {
    case 'BRANDING_NAME': return `New name: ${p.displayName}`;
    case 'BRANDING_LOGO': return 'New logo uploaded';
    case 'BRANDING_THEME': return `New theme: ${p.themeId ?? 'platform default'}`;
    case 'ROOM_CREATE': return `Room "${p.name}" (${r.targetKey}): ${p.capacity} cartelas at ${p.price} ETB`;
    case 'ROOM_CAPACITY_INCREASE': return `Capacity -> ${p.capacity}`;
    case 'SETTING_CHANGE': return `${r.targetKey} = ${p.value}`;
    default: return JSON.stringify(p);
  }
}

/** Platform review queue: approve/reject any operator's pending changes (used when signed in as a platform admin). */
export function PlatformApprovalsQueue() {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [status, setStatus] = useState('pending');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi.platformApprovals(status || undefined).then(setRows).catch((e) => setErr(e.message));
  }, [status]);
  useEffect(() => { load(); }, [load]);

  const approve = async (r: ApprovalRow) => {
    setBusy(r.id);
    try {
      await adminApi.approveRequest(r.id);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const reject = async (r: ApprovalRow) => {
    const note = window.prompt('Reason for rejecting (shown to the operator):');
    if (!note || note.trim().length < 3) return alert('A reason of at least 3 characters is required');
    setBusy(r.id);
    try {
      await adminApi.rejectRequest(r.id, note);
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
        <h1 className="text-xl font-bold">Approvals</h1>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1 text-sm">
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
      </div>
      {err && <p className="mb-3 text-sm text-red-500">{err}</p>}

      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-bold">{r.label} <span className={`ml-2 rounded px-1.5 py-0.5 text-xs font-semibold ${STATUS_COLOR[r.status]}`}>{r.status}</span></p>
                <p className="text-xs text-slate-400">{r.operator?.slug ?? r.operatorId} · submitted {new Date(r.submittedAt).toLocaleString()}</p>
                <p className="mt-1 text-sm text-slate-600">{describe(r)}</p>
                {r.reviewNote && <p className="mt-1 text-xs text-slate-500">Note: {r.reviewNote}</p>}
              </div>
              {r.status === 'pending' && (
                <div className="flex shrink-0 gap-1.5">
                  <button disabled={busy === r.id} onClick={() => approve(r)} className="rounded bg-emerald-600 px-2 py-1 text-xs text-white">Approve</button>
                  <button disabled={busy === r.id} onClick={() => reject(r)} className="rounded bg-red-500 px-2 py-1 text-xs text-white">Reject</button>
                </div>
              )}
            </div>
          </div>
        ))}
        {rows.length === 0 && !err && <p className="text-slate-400">No requests.</p>}
      </div>
    </div>
  );
}

/** Operator's own view: what it has submitted, plus a cancel option while still pending. */
export function OperatorApprovals() {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi.myApprovals().then(setRows).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const cancel = async (r: ApprovalRow) => {
    setBusy(r.id);
    try {
      await adminApi.cancelMyApproval(r.id);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h1 className="mb-3 text-xl font-bold">My Approval Requests</h1>
      {err && <p className="mb-3 text-sm text-red-500">{err}</p>}
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-bold">{r.label} <span className={`ml-2 rounded px-1.5 py-0.5 text-xs font-semibold ${STATUS_COLOR[r.status]}`}>{r.status}</span></p>
                <p className="text-xs text-slate-400">submitted {new Date(r.submittedAt).toLocaleString()}</p>
                <p className="mt-1 text-sm text-slate-600">{describe(r)}</p>
                {r.reviewNote && <p className="mt-1 text-xs text-slate-500">Note: {r.reviewNote}</p>}
              </div>
              {r.status === 'pending' && (
                <button disabled={busy === r.id} onClick={() => cancel(r)} className="shrink-0 rounded bg-slate-500 px-2 py-1 text-xs text-white">Cancel</button>
              )}
            </div>
          </div>
        ))}
        {rows.length === 0 && !err && <p className="text-slate-400">No requests yet.</p>}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { adminApi, TicketDetail, TicketRow } from '../adminApi';

const STATUS_COLOR: Record<string, string> = {
  open: 'bg-amber-100 text-amber-700',
  pending: 'bg-sky-100 text-sky-700',
  resolved: 'bg-emerald-100 text-emerald-700',
  closed: 'bg-slate-100 text-slate-500',
};

export function SupportTicketsAdmin({ permissions, role }: { permissions: string[]; role: string }) {
  const canManage = role === 'SUPER_ADMIN' || role === 'OPERATOR_OWNER' || permissions.includes('MANAGE_SUPPORT_TICKETS');
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [status, setStatus] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi.myTickets(status || undefined).then(setRows).catch((e) => setErr(e.message));
  }, [status]);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-xl font-bold">Support Tickets</h1>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1 text-sm">
          <option value="">All</option>
          <option value="open">Open</option>
          <option value="pending">Pending</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>
      </div>
      {err && <p className="mb-3 text-sm text-red-500">{err}</p>}

      <div className="space-y-2">
        {rows.map((t) => (
          <button key={t.id} onClick={() => setOpenId(t.id)} className="block w-full rounded-xl border border-slate-200 bg-white p-4 text-left hover:border-emerald-300">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-bold">{t.subject} <span className={`ml-2 rounded px-1.5 py-0.5 text-xs font-semibold ${STATUS_COLOR[t.status]}`}>{t.status}</span></p>
                <p className="text-xs text-slate-400">{t.user?.username ? `@${t.user.username}` : t.user?.firstName ?? 'player'} · last message {new Date(t.lastMessageAt).toLocaleString()}</p>
              </div>
            </div>
          </button>
        ))}
        {rows.length === 0 && !err && <p className="text-slate-400">No tickets.</p>}
      </div>

      {openId && <TicketModal id={openId} canManage={canManage} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

function TicketModal({ id, canManage, onClose, onChanged }: { id: string; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi.getMyTicket(id).then(setTicket).catch((e) => setErr(e.message));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const send = async () => {
    if (!reply.trim()) return;
    setBusy(true);
    try {
      await adminApi.replyMyTicket(id, reply.trim());
      setReply('');
      load();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: 'resolved' | 'closed' | 'open') => {
    setBusy(true);
    try {
      await adminApi.setMyTicketStatus(id, status);
      load();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">{ticket?.subject ?? '…'}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        {err && <p className="mb-2 text-sm text-red-500">{err}</p>}
        <div className="mb-3 flex-1 space-y-2 overflow-y-auto">
          {ticket?.messages.map((m) => (
            <div key={m.id} className={`max-w-[85%] rounded-lg p-2 text-sm ${m.authorType === 'admin' ? 'ml-auto bg-emerald-50' : 'bg-slate-100'}`}>
              <p>{m.body}</p>
              <p className="mt-1 text-[10px] text-slate-400">{m.authorType} · {new Date(m.createdAt).toLocaleString()}</p>
            </div>
          ))}
        </div>
        {canManage && ticket && ticket.status !== 'closed' && (
          <>
            <div className="mb-2 flex gap-2">
              <input className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Reply…" value={reply} onChange={(e) => setReply(e.target.value)} />
              <button onClick={send} disabled={busy || !reply.trim()} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Send</button>
            </div>
            <div className="flex gap-2 text-xs">
              {ticket.status !== 'resolved' && <button onClick={() => setStatus('resolved')} disabled={busy} className="rounded bg-emerald-100 px-2 py-1 text-emerald-700">Mark resolved</button>}
              <button onClick={() => setStatus('closed')} disabled={busy} className="rounded bg-slate-200 px-2 py-1 text-slate-600">Close</button>
              {ticket.status !== 'open' && <button onClick={() => setStatus('open')} disabled={busy} className="rounded bg-amber-100 px-2 py-1 text-amber-700">Reopen</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

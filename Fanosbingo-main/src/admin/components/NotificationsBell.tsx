import { useCallback, useEffect, useState } from 'react';
import { adminApi, NotificationRow } from '../adminApi';

const SEVERITY_COLOR: Record<string, string> = {
  info: 'border-slate-200',
  warning: 'border-amber-300 bg-amber-50',
  critical: 'border-red-300 bg-red-50',
};

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationRow[]>([]);

  const load = useCallback(() => {
    adminApi.notifications({ limit: 30 }).then((r) => { setUnread(r.unread); setItems(r.items); }).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 20000);
    return () => clearInterval(iv);
  }, [load]);

  const markRead = async (id: string) => {
    await adminApi.markNotificationRead(id).catch(() => {});
    load();
  };

  const markAllRead = async () => {
    await adminApi.markAllNotificationsRead().catch(() => {});
    load();
  };

  return (
    <div className="relative">
      <button onClick={() => { setOpen((o) => !o); if (!open) load(); }} className="relative rounded-lg px-2 py-1.5 text-slate-500 hover:bg-slate-100">
        🔔
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 max-h-96 w-96 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
              <span className="text-sm font-bold">Notifications</span>
              {unread > 0 && <button onClick={markAllRead} className="text-xs text-emerald-600">Mark all read</button>}
            </div>
            {items.length === 0 && <p className="p-4 text-center text-sm text-slate-400">No notifications</p>}
            {items.map((n) => (
              <button
                key={n.id}
                onClick={() => !n.readAt && markRead(n.id)}
                className={`block w-full border-b border-slate-50 p-3 text-left text-xs ${SEVERITY_COLOR[n.severity] ?? ''} ${n.readAt ? 'opacity-60' : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{n.title}</span>
                  <span className="shrink-0 text-slate-400">{new Date(n.createdAt).toLocaleString()}</span>
                </div>
                {n.body && <p className="mt-1 text-slate-500">{n.body}</p>}
                {n.operator?.slug && <p className="mt-1 text-slate-400">operator: {n.operator.slug}</p>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

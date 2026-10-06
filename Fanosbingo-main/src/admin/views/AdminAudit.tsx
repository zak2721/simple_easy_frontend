import { useEffect, useState } from 'react';
import { adminApi, AuditRow } from '../adminApi';

export function AdminAudit() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    adminApi.audit().then((r) => setRows(r.audit)).catch((e) => setErr(e.message));
  }, []);

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">Audit log</h1>
      {err && <p className="text-red-500">{err}</p>}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Admin</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Entity</th><th className="px-3 py-2">Reason</th></tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="border-t border-slate-100">
                <td className="px-3 py-2 text-slate-400">{new Date(a.created_at).toLocaleString()}</td>
                <td className="px-3 py-2">
                  {a.username ?? a.admin_user_id ?? 'system'}
                  {a.impersonated_by_username && (
                    <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800" title="Performed by a Super Admin viewing as this account">
                      via {a.impersonated_by_username}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 font-medium">{a.action}</td>
                <td className="px-3 py-2 text-slate-500">{a.entity_type} {a.entity_id?.slice(0, 8)}</td>
                <td className="px-3 py-2 text-slate-500">{a.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

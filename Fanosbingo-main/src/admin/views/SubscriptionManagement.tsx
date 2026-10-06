import { useEffect, useState } from 'react';
import { adminApi, SubscriptionPlanRow, SubscriptionPaymentRow, PlatformRevenueData, OperatorRow } from '../adminApi';

type Tab = 'plans' | 'payments' | 'revenue';

export function SubscriptionManagement() {
  const [tab, setTab] = useState<Tab>('plans');

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">Subscription Management</h1>
      <div className="mb-4 flex gap-2">
        {(['plans', 'payments', 'revenue'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-4 py-2 text-sm font-medium capitalize ${tab === t ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'plans' && <PlansTab />}
      {tab === 'payments' && <PaymentsTab />}
      {tab === 'revenue' && <RevenueTab />}
    </div>
  );
}

function PlansTab() {
  const [plans, setPlans] = useState<SubscriptionPlanRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', key: '', monthly_price_minor: '', limits: '{}', features: '' });
  const [saving, setSaving] = useState(false);

  const load = () => adminApi.listSubscriptionPlans().then((r) => setPlans(r.plans)).catch((e) => setErr(e.message));

  useEffect(() => { load(); }, []);

  const submit = async () => {
    setSaving(true);
    try {
      let limits: Record<string, unknown> = {};
      try { limits = JSON.parse(form.limits); } catch { setErr('Limits must be valid JSON'); setSaving(false); return; }
      await adminApi.createSubscriptionPlan({
        name: form.name,
        key: form.key,
        monthly_price_minor: Number(form.monthly_price_minor),
        limits,
        features: form.features.split(',').map((s) => s.trim()).filter(Boolean),
      });
      setShowForm(false);
      setForm({ name: '', key: '', monthly_price_minor: '', limits: '{}', features: '' });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {err && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}
      <div className="flex justify-end">
        <button onClick={() => setShowForm(!showForm)} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
          {showForm ? 'Cancel' : '+ New Plan'}
        </button>
      </div>
      {showForm && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <h2 className="font-semibold text-slate-700">Create Subscription Plan</h2>
          <div className="grid grid-cols-2 gap-3">
            <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Plan name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Key (e.g. BASIC)" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />
            <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Monthly price (minor units)" type="number" value={form.monthly_price_minor} onChange={(e) => setForm({ ...form, monthly_price_minor: e.target.value })} />
            <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Features (comma-separated)" value={form.features} onChange={(e) => setForm({ ...form, features: e.target.value })} />
          </div>
          <textarea className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono" rows={3} placeholder='Limits JSON e.g. {"MAX_ROOMS":5}' value={form.limits} onChange={(e) => setForm({ ...form, limits: e.target.value })} />
          <button onClick={submit} disabled={saving} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {saving ? 'Saving…' : 'Create Plan'}
          </button>
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Key</th>
              <th className="px-3 py-2">Monthly (ETB)</th>
              <th className="px-3 py-2">Limits</th>
              <th className="px-3 py-2">Features</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {plans.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No plans yet</td></tr>
            )}
            {plans.map((p) => (
              <tr key={p.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-medium">{p.name}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-500">{p.key}</td>
                <td className="px-3 py-2">{(p.monthlyPriceMinor / 100).toFixed(2)}</td>
                <td className="px-3 py-2">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">{JSON.stringify(p.limits)}</span>
                </td>
                <td className="px-3 py-2 text-slate-500">{p.features.join(', ')}</td>
                <td className="px-3 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${p.isActive ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-500'}`}>
                    {p.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PaymentsTab() {
  const [payments, setPayments] = useState<SubscriptionPaymentRow[]>([]);
  const [operators, setOperators] = useState<OperatorRow[]>([]);
  const [plans, setPlans] = useState<SubscriptionPlanRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ operatorId: '', planId: '', amount: '', periodStart: '', periodEnd: '', notes: '' });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const [pr, or, plr] = await Promise.all([
        adminApi.listSubscriptionPayments(),
        adminApi.listOperators(),
        adminApi.listSubscriptionPlans(),
      ]);
      setPayments(pr.payments);
      setOperators(or);
      setPlans(plr.plans);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load');
    }
  };

  useEffect(() => { load(); }, []);

  const submit = async () => {
    setSaving(true);
    try {
      await adminApi.recordSubscriptionPayment({
        operatorId: form.operatorId,
        planId: form.planId,
        amountMinor: Math.round(Number(form.amount) * 100),
        periodStart: form.periodStart,
        periodEnd: form.periodEnd,
        notes: form.notes || null,
      });
      setShowForm(false);
      setForm({ operatorId: '', planId: '', amount: '', periodStart: '', periodEnd: '', notes: '' });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  const statusBadge = (s: SubscriptionPaymentRow['status']) => {
    const cls = { paid: 'bg-green-100 text-green-800', pending: 'bg-yellow-100 text-yellow-800', failed: 'bg-red-100 text-red-800' }[s];
    return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{s}</span>;
  };

  return (
    <div className="space-y-4">
      {err && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}
      <div className="flex justify-end">
        <button onClick={() => setShowForm(!showForm)} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
          {showForm ? 'Cancel' : '+ Record Payment'}
        </button>
      </div>
      {showForm && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <h2 className="font-semibold text-slate-700">Record Subscription Payment</h2>
          <div className="grid grid-cols-2 gap-3">
            <select className="rounded-lg border border-slate-300 px-3 py-2 text-sm" value={form.operatorId} onChange={(e) => setForm({ ...form, operatorId: e.target.value })}>
              <option value="">Select operator</option>
              {operators.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <select className="rounded-lg border border-slate-300 px-3 py-2 text-sm" value={form.planId} onChange={(e) => setForm({ ...form, planId: e.target.value })}>
              <option value="">Select plan</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" type="number" placeholder="Amount (ETB)" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" type="text" placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            <div>
              <label className="mb-1 block text-xs text-slate-500">Period Start</label>
              <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" type="date" value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">Period End</label>
              <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" type="date" value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} />
            </div>
          </div>
          <button onClick={submit} disabled={saving} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {saving ? 'Saving…' : 'Record Payment'}
          </button>
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Operator</th>
              <th className="px-3 py-2">Plan</th>
              <th className="px-3 py-2">Amount (ETB)</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Period</th>
              <th className="px-3 py-2">Paid At</th>
            </tr>
          </thead>
          <tbody>
            {payments.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No payments recorded</td></tr>
            )}
            {payments.map((p) => (
              <tr key={p.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-medium">{p.operatorName}</td>
                <td className="px-3 py-2">{p.planName}</td>
                <td className="px-3 py-2">{(p.amountMinor / 100).toFixed(2)}</td>
                <td className="px-3 py-2">{statusBadge(p.status)}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">
                  {p.periodStart ? new Date(p.periodStart).toLocaleDateString() : '—'} – {p.periodEnd ? new Date(p.periodEnd).toLocaleDateString() : '—'}
                </td>
                <td className="px-3 py-2 text-slate-400 text-xs">{p.paidAt ? new Date(p.paidAt).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RevenueTab() {
  const [data, setData] = useState<PlatformRevenueData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    adminApi.getPlatformRevenue().then(setData).catch((e) => setErr(e.message));
  }, []);

  if (err) return <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>;
  if (!data) return <p className="text-slate-500">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-slate-400">Total Revenue</p>
          <p className="mt-1 text-lg font-bold">{(data.totalPaidMinor / 100).toFixed(2)} ETB</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-slate-400">Total Payments</p>
          <p className="mt-1 text-lg font-bold">{data.paymentCount}</p>
        </div>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 className="font-semibold text-slate-700">Revenue by Plan</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Plan</th>
              <th className="px-3 py-2">Payments</th>
              <th className="px-3 py-2">Total (ETB)</th>
            </tr>
          </thead>
          <tbody>
            {data.byPlan.length === 0 && (
              <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-400">No data</td></tr>
            )}
            {data.byPlan.map((row) => (
              <tr key={row.planName} className="border-t border-slate-100">
                <td className="px-3 py-2 font-medium">{row.planName}</td>
                <td className="px-3 py-2">{row.count}</td>
                <td className="px-3 py-2">{(row.totalMinor / 100).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

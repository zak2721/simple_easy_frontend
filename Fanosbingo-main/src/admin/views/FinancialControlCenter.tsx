import { useEffect, useState } from 'react';
import { adminApi, FinanceDashboard, WalletDetail, GameSettlement, Reconciliation, FinancialReport, UnpaidWithdrawal, FinancialAlert } from '../adminApi';
import { formatEtb } from '../../lib/format';

// SUPER_ADMIN's complete financial control authority — dashboard, wallet
// lookup/adjustment, game settlements, reconciliation, reports + exports,
// and financial alerts. Every mutation here (wallet adjust, house-percentage
// change) goes through backend endpoints that are already SUPER_ADMIN-gated
// and audit-logged; this view is presentation only.
type Tab = 'dashboard' | 'wallets' | 'settlements' | 'reconciliation' | 'reports' | 'alerts' | 'house';
const TABS: { key: Tab; label: string }[] = [
  { key: 'dashboard', label: 'Financial Dashboard' },
  { key: 'wallets', label: 'Wallets' },
  { key: 'settlements', label: 'Game Settlements' },
  { key: 'reconciliation', label: 'Reconciliation' },
  { key: 'reports', label: 'Reports & Exports' },
  { key: 'alerts', label: 'Financial Alerts' },
  { key: 'house', label: 'House Revenue Settings' },
];

export function FinancialControlCenter() {
  const [tab, setTab] = useState<Tab>('dashboard');
  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">Financial Control Center</h1>
      <p className="mb-4 text-sm text-slate-500">
        Super Admin authority over deposits, withdrawals, wallets, house revenue, and reconciliation. Every wallet
        adjustment and house-percentage change is ledger-backed, reason-required, and permanently audit-logged.
      </p>
      <div className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-t-lg px-3 py-2 text-sm font-medium ${tab === t.key ? 'border-b-2 border-emerald-600 text-emerald-700' : 'text-slate-500 hover:text-slate-700'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'dashboard' && <FinanceDashboardTab />}
      {tab === 'wallets' && <WalletsTab />}
      {tab === 'settlements' && <SettlementsTab />}
      {tab === 'reconciliation' && <ReconciliationTab />}
      {tab === 'reports' && <ReportsTab />}
      {tab === 'alerts' && <AlertsTab />}
      {tab === 'house' && <HouseSettingsTab />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-lg font-bold">{value}</p>
    </div>
  );
}

function PeriodBlock({ title, snap }: { title: string; snap: { deposits_total: number; withdrawals_paid_total: number; house_revenue: number; winner_payouts: number; refunds: number; bonus_activity: number } }) {
  return (
    <div className="mb-4">
      <h2 className="mb-2 text-sm font-bold text-slate-600">{title}</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Deposits" value={formatEtb(snap.deposits_total)} />
        <Stat label="Withdrawals paid" value={formatEtb(snap.withdrawals_paid_total)} />
        <Stat label="House revenue" value={formatEtb(snap.house_revenue)} />
        <Stat label="Winner payouts" value={formatEtb(snap.winner_payouts)} />
        <Stat label="Refunds" value={formatEtb(snap.refunds)} />
        <Stat label="Bonus activity" value={formatEtb(snap.bonus_activity)} />
      </div>
    </div>
  );
}

function FinanceDashboardTab() {
  const [d, setD] = useState<FinanceDashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => adminApi.financeDashboard().then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <p className="text-red-500">{err}</p>;
  if (!d) return <p className="text-slate-500">Loading…</p>;

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Pending deposits" value={String(d.today.pending_deposits)} />
        <Stat label="Pending withdrawals" value={String(d.today.pending_withdrawals)} />
        <Stat label="Unpaid (approved) withdrawals" value={String(d.today.unpaid_withdrawals)} />
        <Stat label="Current wallet liability" value={formatEtb(d.all_time.current_wallet_liability)} />
      </div>
      <PeriodBlock title="Today" snap={d.today} />
      <PeriodBlock title="This week" snap={d.this_week} />
      <PeriodBlock title="This month" snap={d.this_month} />
      <PeriodBlock title="All time" snap={d.all_time} />
    </div>
  );
}

function WalletsTab() {
  const [id, setId] = useState('');
  const [detail, setDetail] = useState<WalletDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bucket, setBucket] = useState<'deposited' | 'won' | 'bonus'>('bonus');
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const lookup = async () => {
    setErr(null);
    try {
      const numericId = Number(id);
      setDetail(await adminApi.walletDetail(numericId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Lookup failed');
      setDetail(null);
    }
  };

  const adjust = async () => {
    setErr(null);
    setBusy(true);
    try {
      await adminApi.adjustWallet(Number(id), bucket, Number(amount), direction, reason);
      setAmount('');
      setReason('');
      await lookup();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Adjustment failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <div className="mb-4 flex gap-2">
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="Telegram user ID"
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button onClick={lookup} className="rounded-lg bg-slate-700 px-3 py-2 text-sm font-semibold text-white">Look up</button>
      </div>
      {err && <p className="mb-3 text-sm text-red-500">{err}</p>}

      {detail && (
        <>
          <div className="mb-4 grid grid-cols-3 gap-3">
            <Stat label="Deposited" value={formatEtb(detail.wallet.deposited_balance)} />
            <Stat label="Won (withdrawable)" value={formatEtb(detail.wallet.won_balance)} />
            <Stat label="Bonus" value={formatEtb(detail.wallet.bonus_balance)} />
          </div>

          <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-bold">Adjust wallet</h2>
            <p className="mb-3 text-xs text-slate-500">
              Never a direct overwrite — this posts a signed delta against one bucket, with a mandatory reason, through
              the same lock + ledger + audit path as every other financial mutation.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <select value={bucket} onChange={(e) => setBucket(e.target.value as typeof bucket)} className="rounded-lg border border-slate-300 px-2 py-2 text-sm">
                <option value="deposited">Deposited</option>
                <option value="won">Won</option>
                <option value="bonus">Bonus</option>
              </select>
              <select value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)} className="rounded-lg border border-slate-300 px-2 py-2 text-sm">
                <option value="credit">Credit (+)</option>
                <option value="debit">Debit (−)</option>
              </select>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Amount"
                type="number"
                className="w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason (required)"
                className="min-w-[12rem] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <button onClick={adjust} disabled={busy || !amount || reason.trim().length < 3} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {busy ? '…' : 'Apply'}
              </button>
            </div>
          </div>

          <h2 className="mb-2 text-sm font-bold text-slate-600">Ledger history</h2>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <tbody>
                {detail.ledger.map((l) => (
                  <tr key={l.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">{l.entryType.replace(/_/g, ' ').toLowerCase()}</td>
                    <td className={`px-3 py-2 ${l.direction === 'credit' ? 'text-emerald-600' : 'text-red-500'}`}>{l.direction}</td>
                    <td className="px-3 py-2 text-right">{formatEtb(l.amount)}</td>
                    <td className="px-3 py-2 text-slate-500">{l.note}</td>
                    <td className="px-3 py-2 text-right text-slate-400">{new Date(l.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function SettlementsTab() {
  const [rows, setRows] = useState<GameSettlement[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { adminApi.gameSettlements().then(setRows).catch((e) => setErr(e.message)); }, []);

  if (err) return <p className="text-red-500">{err}</p>;
  if (!rows) return <p className="text-slate-500">Loading…</p>;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
            <th className="px-3 py-2">Game</th>
            <th className="px-3 py-2">Finished</th>
            <th className="px-3 py-2 text-right">Gross revenue</th>
            <th className="px-3 py-2 text-right">House cut</th>
            <th className="px-3 py-2 text-right">Payout pool</th>
            <th className="px-3 py-2 text-right">Winners</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.game_id} className="border-b border-slate-100 last:border-0">
              <td className="px-3 py-2">#{g.game_number}</td>
              <td className="px-3 py-2 text-slate-500">{new Date(g.finished_at).toLocaleString()}</td>
              <td className="px-3 py-2 text-right">{formatEtb(g.gross_entry_revenue)}</td>
              <td className="px-3 py-2 text-right">{formatEtb(g.house_percentage_amount)}</td>
              <td className="px-3 py-2 text-right">{formatEtb(g.player_payout_pool)}</td>
              <td className="px-3 py-2 text-right">{g.winner_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReconciliationTab() {
  const [r, setR] = useState<Reconciliation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = () => {
    setBusy(true);
    adminApi.reconciliation().then(setR).catch((e) => setErr(e.message)).finally(() => setBusy(false));
  };
  useEffect(run, []);

  if (err) return <p className="text-red-500">{err}</p>;

  return (
    <div>
      <button onClick={run} disabled={busy} className="mb-4 rounded-lg bg-slate-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
        {busy ? 'Checking…' : 'Re-run check'}
      </button>
      {r && (
        <>
          <p className={`mb-4 inline-block rounded-lg px-3 py-1 text-sm font-bold ${r.status === 'BALANCED' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
            {r.status} — {r.checked_players} players checked
          </p>
          {r.discrepancies.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                    <th className="px-3 py-2">Player</th>
                    <th className="px-3 py-2 text-right">Expected</th>
                    <th className="px-3 py-2 text-right">Actual</th>
                    <th className="px-3 py-2 text-right">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {r.discrepancies.map((d) => (
                    <tr key={d.telegram_user_id} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-2">{d.username ?? d.telegram_user_id}</td>
                      <td className="px-3 py-2 text-right">{formatEtb(d.expected_total_balance)}</td>
                      <td className="px-3 py-2 text-right">{formatEtb(d.actual_total_balance)}</td>
                      <td className="px-3 py-2 text-right text-red-500">{formatEtb(d.difference)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="p-3 text-xs text-slate-400">
                Resolution is intentional not automated — investigate and correct via the Wallets tab's adjustment tool.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ReportsTab() {
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly' | 'alltime'>('daily');
  const [report, setReport] = useState<FinancialReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [unpaid, setUnpaid] = useState<UnpaidWithdrawal[] | null>(null);

  useEffect(() => {
    adminApi.financialReport(period).then(setReport).catch((e) => setErr(e.message));
  }, [period]);
  useEffect(() => {
    adminApi.unpaidWithdrawals('longest_pending').then(setUnpaid).catch(() => {});
  }, []);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select value={period} onChange={(e) => setPeriod(e.target.value as typeof period)} className="rounded-lg border border-slate-300 px-2 py-2 text-sm">
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="alltime">All time</option>
        </select>
        <button onClick={() => adminApi.downloadFinancialReportCsv(period).catch((e) => setErr(e.message))} className="rounded-lg bg-slate-700 px-3 py-2 text-sm font-semibold text-white">
          Export report CSV
        </button>
        <button onClick={() => adminApi.downloadRawExport('deposits').catch((e) => setErr(e.message))} className="rounded-lg bg-slate-200 px-3 py-2 text-sm font-semibold text-slate-700">
          Export deposits
        </button>
        <button onClick={() => adminApi.downloadRawExport('withdrawals').catch((e) => setErr(e.message))} className="rounded-lg bg-slate-200 px-3 py-2 text-sm font-semibold text-slate-700">
          Export withdrawals
        </button>
        <button onClick={() => adminApi.downloadRawExport('audit').catch((e) => setErr(e.message))} className="rounded-lg bg-slate-200 px-3 py-2 text-sm font-semibold text-slate-700">
          Export audit log
        </button>
      </div>
      {err && <p className="mb-3 text-sm text-red-500">{err}</p>}

      {report && (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Deposits" value={formatEtb(report.deposits_total)} />
          <Stat label="Withdrawals paid" value={formatEtb(report.withdrawals_paid_total)} />
          <Stat label="House revenue" value={formatEtb(report.house_revenue)} />
          <Stat label="Winner payouts" value={formatEtb(report.winner_payouts)} />
          <Stat label="Pending transactions" value={String(report.pending_transactions)} />
          <Stat label="Unpaid withdrawals" value={String(report.unpaid_withdrawals)} />
          <Stat label="Failed transactions" value={String(report.failed_transactions)} />
        </div>
      )}

      <h2 className="mb-2 text-sm font-bold text-slate-600">Unpaid (approved) withdrawals — longest pending first</h2>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <tbody>
            {(unpaid ?? []).map((w) => (
              <tr key={w.id} className="border-b border-slate-100 last:border-0">
                <td className="px-3 py-2">{w.username ?? w.telegram_user_id}</td>
                <td className="px-3 py-2 text-right">{formatEtb(w.amount)}</td>
                <td className="px-3 py-2 text-right text-slate-500">{w.age_hours}h pending</td>
              </tr>
            ))}
            {unpaid && unpaid.length === 0 && (
              <tr><td className="px-3 py-3 text-slate-400">None</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AlertsTab() {
  const [alerts, setAlerts] = useState<FinancialAlert[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => adminApi.financialAlerts().then(setAlerts).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);

  const ack = async (id: string) => {
    try {
      await adminApi.acknowledgeAlert(id);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to acknowledge');
    }
  };

  if (err) return <p className="text-red-500">{err}</p>;
  if (!alerts) return <p className="text-slate-500">Loading…</p>;
  if (alerts.length === 0) return <p className="text-slate-500">No active alerts.</p>;

  return (
    <div className="space-y-2">
      {alerts.map((a) => (
        <div key={a.id} className={`flex items-center justify-between rounded-xl border p-3 ${a.severity === 'critical' ? 'border-red-300 bg-red-50' : 'border-amber-300 bg-amber-50'}`}>
          <div>
            <p className="text-sm font-semibold">{a.type.replace(/_/g, ' ')}</p>
            <p className="text-sm text-slate-600">{a.message}</p>
            <p className="text-xs text-slate-400">{new Date(a.createdAt).toLocaleString()}</p>
          </div>
          <button onClick={() => ack(a.id)} className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm font-semibold text-white">Acknowledge</button>
        </div>
      ))}
    </div>
  );
}

function HouseSettingsTab() {
  const [pct, setPct] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const res = await adminApi.updateHousePercentage(Number(pct), reason);
      setMsg(`House ${res.housePercentage}% / Winner ${res.winnerPercentage}% — saved.`);
      setReason('');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-lg rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="mb-2 text-sm font-bold">House / winner split</h2>
      <p className="mb-3 text-xs text-slate-500">
        The only way to change the house cut. Requires the Super Admin role (not just a permission) plus an explicit
        reason — both old and new values are captured in the audit log automatically.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={pct}
          onChange={(e) => setPct(e.target.value)}
          type="number"
          min={0}
          max={100}
          placeholder="House %"
          className="w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (required)"
          className="min-w-[14rem] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button onClick={submit} disabled={busy || !pct || reason.trim().length < 3} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? '…' : 'Apply'}
        </button>
      </div>
      {msg && <p className="mt-2 text-sm text-slate-600">{msg}</p>}
    </div>
  );
}

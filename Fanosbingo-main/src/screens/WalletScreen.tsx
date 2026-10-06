import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { useFinance } from '../lib/useFinance';
import { useT } from '../i18n/LangProvider';
import type { TKey } from '../i18n';
import { Screen, Card, StatusPill } from '../components/common/Screen';
import { formatEtb } from '../lib/format';

export function WalletScreen({ onDeposit, onWithdraw }: { onDeposit: () => void; onWithdraw: () => void }) {
  const { data, loading } = useFinance();
  const t = useT();
  const w = data?.wallet;

  return (
    <Screen title={t('wallet.title')}>
      <Card className="mb-3">
        <p className="text-xs uppercase tracking-wide text-[var(--eds-muted)]">{t('wallet.totalBalance')}</p>
        <p className="mt-1 text-3xl font-extrabold">{formatEtb(w?.total_balance ?? 0)}</p>
        <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded-lg bg-white/5 p-2">
            <p className="text-[var(--eds-muted)]">{t('wallet.deposited')}</p>
            <p className="font-bold">{formatEtb(w?.deposited_balance ?? 0, { symbol: false })}</p>
          </div>
          <div className="rounded-lg bg-white/5 p-2">
            <p className="text-[var(--eds-muted)]">{t('wallet.winnings')}</p>
            <p className="font-bold text-emerald-300">{formatEtb(w?.won_balance ?? 0, { symbol: false })}</p>
          </div>
          <div className="rounded-lg bg-white/5 p-2">
            <p className="text-[var(--eds-muted)]">{t('wallet.onHold')}</p>
            <p className="font-bold text-amber-300">{formatEtb(w?.on_hold ?? 0, { symbol: false })}</p>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-[var(--eds-muted)]">{t('wallet.onlyWinningsNote')}</p>
        <div className="mt-3 flex gap-2">
          <button onClick={onDeposit} className="eds-btn flex flex-1 items-center justify-center gap-1.5 text-sm">
            <ArrowDownToLine className="h-4 w-4" /> {t('wallet.deposit')}
          </button>
          <button onClick={onWithdraw} className="eds-btn eds-btn-ghost flex flex-1 items-center justify-center gap-1.5 text-sm">
            <ArrowUpFromLine className="h-4 w-4" /> {t('wallet.withdraw')}
          </button>
        </div>
      </Card>

      <p className="mb-2 text-sm font-bold">{t('wallet.recentTransactions')}</p>
      {loading && <p className="text-sm text-[var(--eds-muted)]">{t('common.loading')}</p>}
      <div className="space-y-2">
        {(data?.ledger ?? []).map((l) => (
          <div key={l.id} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-sm">
            <div>
              <p className="font-medium">{t(`tx.${String(l.entry_type).toLowerCase()}` as TKey)}</p>
              <p className="text-[11px] text-[var(--eds-muted)]">{new Date(l.created_at).toLocaleString()}</p>
            </div>
            <span className={l.direction === 'credit' ? 'text-emerald-400' : l.direction === 'debit' ? 'text-red-400' : 'text-[var(--eds-muted)]'}>
              {l.direction === 'debit' ? '−' : l.direction === 'credit' ? '+' : ''}{formatEtb(l.amount, { symbol: false })}
            </span>
          </div>
        ))}
        {data && data.ledger.length === 0 && <p className="text-sm text-[var(--eds-muted)]">{t('wallet.noTransactions')}</p>}
      </div>

      {data && (data.deposits.length > 0 || data.withdrawals.length > 0) && (
        <>
          <p className="mb-2 mt-4 text-sm font-bold">{t('wallet.pendingRequests')}</p>
          <div className="space-y-2">
            {data.deposits.filter((d) => d.status === 'pending').map((d) => (
              <div key={d.id} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-sm">
                <span>{t('wallet.depositRow', { amount: formatEtb(d.amount) })}</span>
                <StatusPill status={d.status} />
              </div>
            ))}
            {data.withdrawals.filter((x) => ['pending', 'approved'].includes(x.status)).map((x) => (
              <div key={x.id} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-sm">
                <span>{t('wallet.withdrawRow', { amount: formatEtb(x.amount) })}</span>
                <StatusPill status={x.status} />
              </div>
            ))}
          </div>
        </>
      )}
    </Screen>
  );
}

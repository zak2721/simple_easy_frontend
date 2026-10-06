import { useFinance } from '../lib/useFinance';
import { useT } from '../i18n/LangProvider';
import { Screen, Card, StatusPill } from '../components/common/Screen';
import { formatEtb } from '../lib/format';

export function HistoryScreen() {
  const { data, loading } = useFinance();
  const t = useT();

  return (
    <Screen title={t('history.title')}>
      {loading && <p className="text-sm text-[var(--eds-muted)]">{t('common.loading')}</p>}

      <p className="mb-2 text-sm font-bold">{t('history.deposits')}</p>
      <div className="mb-4 space-y-2">
        {(data?.deposits ?? []).map((d) => (
          <Card key={d.id} className="!p-3">
            <div className="flex items-center justify-between">
              <span className="font-bold">{formatEtb(d.amount)}</span>
              <StatusPill status={d.status} />
            </div>
            <p className="text-[11px] text-[var(--eds-muted)]">
              {new Date(d.submitted_at).toLocaleString()}
            </p>
            {d.status === 'rejected' && d.rejection_reason && (
              <p className="mt-1 text-xs text-red-300">{t('history.reason', { r: d.rejection_reason })}</p>
            )}
          </Card>
        ))}
        {data && data.deposits.length === 0 && <p className="text-sm text-[var(--eds-muted)]">{t('history.noDeposits')}</p>}
      </div>

      <p className="mb-2 text-sm font-bold">{t('history.withdrawals')}</p>
      <div className="space-y-2">
        {(data?.withdrawals ?? []).map((x) => (
          <Card key={x.id} className="!p-3">
            <div className="flex items-center justify-between">
              <span className="font-bold">{formatEtb(x.amount)}</span>
              <StatusPill status={x.status} />
            </div>
            <p className="text-[11px] text-[var(--eds-muted)]">
              {t('history.to', { acct: x.telebirr_account })} · {new Date(x.requested_at).toLocaleString()}
            </p>
            {x.status === 'rejected' && x.rejection_reason && (
              <p className="mt-1 text-xs text-red-300">{t('history.reason', { r: x.rejection_reason })}</p>
            )}
          </Card>
        ))}
        {data && data.withdrawals.length === 0 && <p className="text-sm text-[var(--eds-muted)]">{t('history.noWithdrawals')}</p>}
      </div>
    </Screen>
  );
}

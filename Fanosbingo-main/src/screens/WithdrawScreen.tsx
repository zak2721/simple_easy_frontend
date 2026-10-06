import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { useFinance } from '../lib/useFinance';
import { useT } from '../i18n/LangProvider';
import type { TKey } from '../i18n';
import { api } from '../lib/api';
import { Screen, Card } from '../components/common/Screen';
import { TelebirrBrandBar } from '../components/common/TelebirrBrand';
import { formatEtb } from '../lib/format';

export function WithdrawScreen({ onDone }: { onDone: () => void }) {
  const { data, reload } = useFinance();
  const t = useT();
  const [amount, setAmount] = useState('');
  const [account, setAccount] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const w = data?.wallet;
  const pending = (data?.withdrawals ?? []).find((x) => ['pending', 'approved'].includes(x.status));

  const submit = async () => {
    setError(null);
    const amt = Number(amount);
    if (!amt || amt <= 0) return setError(t('withdraw.err.amount'));
    if ((w?.won_balance ?? 0) < amt) return setError(t('withdraw.err.winnings'));
    if (account.trim().length < 9) return setError(t('withdraw.err.account'));
    setBusy(true);
    try {
      await api.requestWithdrawal({ amount: amt, telebirrAccount: account.trim(), notes: notes.trim() || undefined });
      setDone(true);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('withdraw.err.generic'));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Screen title={t('withdraw.title')} onBack={onDone}>
        <Card className="flex flex-col items-center gap-3 text-center">
          <CheckCircle2 className="h-12 w-12 text-emerald-400" />
          <p className="font-bold">{t('withdraw.doneTitle')}</p>
          <p className="text-sm text-[var(--eds-muted)]">{t('withdraw.donePending')}</p>
          <button onClick={onDone} className="eds-btn w-full">{t('withdraw.backToWallet')}</button>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen title={t('withdraw.title')} onBack={onDone}>
      <TelebirrBrandBar />
      <Card className="mb-3">
        <div className="flex justify-between text-sm">
          <span className="text-[var(--eds-muted)]">{t('withdraw.availableWinnings')}</span>
          <span className="font-bold text-emerald-300">{formatEtb(w?.won_balance ?? 0)}</span>
        </div>
      </Card>

      {pending ? (
        <Card>
          <p className="text-sm">
            {t('withdraw.alreadyPending', {
              amount: formatEtb(pending.amount),
              status: t(`status.${pending.status}` as TKey),
            })}
          </p>
        </Card>
      ) : (
        <Card className="space-y-3">
          <label className="block text-sm">
            <span className="text-[var(--eds-muted)]">{t('withdraw.amountLabel')}</span>
            <input className="eds-input mt-1" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t('withdraw.amountPlaceholder')} />
          </label>
          <label className="block text-sm">
            <span className="text-[var(--eds-muted)]">{t('withdraw.accountLabel')}</span>
            <input className="eds-input mt-1" inputMode="tel" value={account} onChange={(e) => setAccount(e.target.value)} placeholder={t('withdraw.accountPlaceholder')} />
          </label>
          <label className="block text-sm">
            <span className="text-[var(--eds-muted)]">{t('withdraw.notesLabel')}</span>
            <textarea className="eds-input mt-1 resize-none" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('withdraw.notesPlaceholder')} />
          </label>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button onClick={submit} disabled={busy} className="eds-btn w-full">
            {busy ? t('withdraw.requesting') : t('withdraw.submit')}
          </button>
        </Card>
      )}
    </Screen>
  );
}

import { useState } from 'react';
import { Copy, Upload, CheckCircle2 } from 'lucide-react';
import { useFinance } from '../lib/useFinance';
import { useT } from '../i18n/LangProvider';
import { api, fileToBase64 } from '../lib/api';
import { Screen, Card } from '../components/common/Screen';
import { TelebirrBrandBar } from '../components/common/TelebirrBrand';
import { formatEtb } from '../lib/format';

export function DepositScreen({ onDone }: { onDone: () => void }) {
  const { data, reload } = useFinance();
  const t = useT();
  const [amount, setAmount] = useState('');
  const [telebirrReference, setTelebirrReference] = useState('');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const tb = data?.telebirr;

  const submit = async () => {
    setError(null);
    if (!file) return setError(t('deposit.err.attach'));
    const amt = Number(amount);
    if (!amt || amt <= 0) return setError(t('deposit.err.amount'));
    const ref = telebirrReference.trim();
    if (!/^[A-Za-z0-9-]{6,40}$/.test(ref)) return setError(t('deposit.err.reference'));
    setBusy(true);
    try {
      const receiptBase64 = await fileToBase64(file);
      await api.submitDeposit({
        amount: amt,
        receiptBase64,
        telebirrReference: ref,
        notes: notes.trim() || undefined,
      });
      setDone(true);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('deposit.err.generic'));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Screen title={t('deposit.title')} onBack={onDone}>
        <Card className="flex flex-col items-center gap-3 text-center">
          <CheckCircle2 className="h-12 w-12 text-emerald-400" />
          <p className="font-bold">{t('deposit.doneTitle')}</p>
          <p className="text-sm text-[var(--eds-muted)]">{t('deposit.donePending')}</p>
          <button onClick={onDone} className="eds-btn w-full">{t('deposit.backToWallet')}</button>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen title={t('deposit.title')} onBack={onDone}>
      <TelebirrBrandBar />
      <Card className="mb-3">
        <p className="text-sm font-bold">{t('deposit.payToAccount')}</p>
        {tb?.configured === false && (
          <p className="mt-1 text-xs text-amber-300">{t('deposit.notConfigured')}</p>
        )}
        <div className="mt-2 space-y-1 text-sm">
          <Row label={t('deposit.accountName')} value={tb?.account_name ?? '—'} />
          <Row label={t('deposit.accountNumber')} value={tb?.account_number ?? '—'} copyable />
        </div>
        {tb?.instructions && <p className="mt-2 whitespace-pre-line text-xs text-[var(--eds-muted)]">{tb.instructions}</p>}
      </Card>

      <Card className="space-y-3">
        <label className="block text-sm">
          <span className="text-[var(--eds-muted)]">{t('deposit.amountLabel', { min: formatEtb(tb?.min_etb ?? 10), max: formatEtb(tb?.max_etb ?? 50000) })}</span>
          <input className="eds-input mt-1" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t('deposit.amountPlaceholder')} />
        </label>
        <label className="block text-sm">
          <span className="text-[var(--eds-muted)]">{t('deposit.referenceLabel')}</span>
          <input
            className="eds-input mt-1"
            value={telebirrReference}
            onChange={(e) => setTelebirrReference(e.target.value)}
            placeholder={t('deposit.referencePlaceholder')}
            maxLength={40}
          />
        </label>
        <label className="block text-sm">
          <span className="text-[var(--eds-muted)]">{t('deposit.receiptLabel')}</span>
          <div className="eds-input mt-1 flex items-center gap-2">
            <Upload className="h-4 w-4 text-[var(--eds-muted)]" />
            <input type="file" accept="image/png,image/jpeg,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-xs" />
          </div>
          {file && <span className="mt-1 block text-[11px] text-emerald-300">{file.name}</span>}
        </label>
        <label className="block text-sm">
          <span className="text-[var(--eds-muted)]">{t('deposit.notesLabel')}</span>
          <textarea className="eds-input mt-1 resize-none" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('deposit.notesPlaceholder')} />
        </label>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button onClick={submit} disabled={busy} className="eds-btn w-full">
          {busy ? t('deposit.submitting') : t('deposit.submit')}
        </button>
      </Card>
    </Screen>
  );
}

function Row({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[var(--eds-muted)]">{label}</span>
      <span className="flex items-center gap-2 font-semibold">
        {value}
        {copyable && (
          <button onClick={() => navigator.clipboard?.writeText(value)} className="text-[var(--eds-muted)]">
            <Copy className="h-3.5 w-3.5" />
          </button>
        )}
      </span>
    </div>
  );
}

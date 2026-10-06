import { useEffect, useState } from 'react';
import { Copy, Share2 } from 'lucide-react';
import { useT } from '../i18n/LangProvider';
import { api } from '../lib/api';
import { Screen, Card } from '../components/common/Screen';
import { formatEtb } from '../lib/format';

interface ReferralStats {
  link: string;
  web_link: string;
  referral_code: string;
  totalReferred: number;
  successfulReferred: number;
  earnedEtb: number;
}
interface HistoryRow {
  id: string;
  invited_name: string;
  joined_date: string;
  rewarded: boolean;
  reward_amount: number;
}

export function ReferralScreen({ onBack }: { onBack: () => void }) {
  const t = useT();
  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);

  useEffect(() => {
    api.referralStats().then(setStats).catch((e) => setError(e instanceof Error ? e.message : t('referral.err.generic')));
    api.referralHistory().then(setHistory).catch(() => setHistory([]));
  }, [t]);

  const copy = (value: string, which: 'code' | 'link') => {
    navigator.clipboard?.writeText(value);
    setCopied(which);
    setTimeout(() => setCopied(null), 2000);
  };

  const share = () => {
    if (!stats?.link) return;
    const url = `https://t.me/share/url?url=${encodeURIComponent(stats.link)}`;
    window.open(url, '_blank');
  };

  return (
    <Screen title={t('referral.title')} onBack={onBack}>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      {stats && (
        <>
          <Card className="mb-3">
            <p className="text-sm font-bold">{t('referral.yourCode')}</p>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-2xl font-bold tracking-widest">{stats.referral_code}</span>
              <button onClick={() => copy(stats.referral_code, 'code')} className="eds-btn-ghost flex items-center gap-1 px-3 py-1.5 text-xs">
                <Copy className="h-3.5 w-3.5" /> {copied === 'code' ? t('referral.copied') : t('referral.copy')}
              </button>
            </div>

            <p className="mt-4 text-sm font-bold">{t('referral.yourLink')}</p>
            <p className="mt-1 truncate text-xs text-[var(--eds-muted)]">{stats.link}</p>
            <div className="mt-2 flex gap-2">
              <button onClick={() => copy(stats.link, 'link')} className="eds-btn-ghost flex flex-1 items-center justify-center gap-1 py-2 text-xs">
                <Copy className="h-3.5 w-3.5" /> {copied === 'link' ? t('referral.copied') : t('referral.copy')}
              </button>
              <button onClick={share} className="eds-btn flex flex-1 items-center justify-center gap-1 py-2 text-xs">
                <Share2 className="h-3.5 w-3.5" /> {t('referral.share')}
              </button>
            </div>
          </Card>

          <div className="mb-3 grid grid-cols-3 gap-2">
            <StatTile label={t('referral.statInvited')} value={String(stats.totalReferred)} />
            <StatTile label={t('referral.statSuccessful')} value={String(stats.successfulReferred)} />
            <StatTile label={t('referral.statEarned')} value={formatEtb(stats.earnedEtb)} />
          </div>
        </>
      )}

      <Card>
        <p className="mb-2 text-sm font-bold">{t('referral.historyTitle')}</p>
        {history === null && <p className="text-xs text-[var(--eds-muted)]">{t('common.loading')}</p>}
        {history?.length === 0 && <p className="text-xs text-[var(--eds-muted)]">{t('referral.historyEmpty')}</p>}
        <div className="space-y-2">
          {history?.map((row) => (
            <div key={row.id} className="flex items-center justify-between border-b border-white/5 pb-2 text-sm last:border-0 last:pb-0">
              <div>
                <p className="font-medium">{row.invited_name}</p>
                <p className="text-xs text-[var(--eds-muted)]">{new Date(row.joined_date).toLocaleDateString()}</p>
              </div>
              <span className={row.rewarded ? 'text-emerald-300' : 'text-[var(--eds-muted)]'}>
                {row.rewarded ? `+${formatEtb(row.reward_amount)}` : t('referral.historyPending')}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </Screen>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="eds-card p-3 text-center">
      <p className="stat-value text-lg font-bold">{value}</p>
      <p className="text-[10px] text-[var(--eds-muted)]">{label}</p>
    </div>
  );
}

import { History, HelpCircle, RefreshCw, Settings as SettingsIcon, Gift, BookOpen, LifeBuoy } from 'lucide-react';
import { useSession } from '../lib/session';
import { useT } from '../i18n/LangProvider';
import { Screen, Card } from '../components/common/Screen';
import { Logo } from '../components/common/Logo';
import { formatEtb } from '../lib/format';
import { Tab } from '../components/BottomNav';

export function ProfileScreen({ onNavigate }: { onNavigate?: (t: Tab) => void }) {
  const { user, wallet, config, refresh } = useSession();
  const t = useT();

  return (
    <Screen title={t('profile.title')}>
      <div className="mb-4 flex flex-col items-center gap-2">
        <Logo className="h-10 w-auto" />
      </div>

      <Card className="mb-3">
        <p className="text-lg font-bold">{user?.first_name}</p>
        {user?.username && <p className="text-sm text-[var(--eds-muted)]">@{user.username}</p>}
        <p className="mt-1 text-xs text-[var(--eds-muted)]">{t('profile.telegramId', { id: user?.telegram_user_id ?? '' })}</p>
        <div className="mt-3 flex justify-between text-sm">
          <span className="text-[var(--eds-muted)]">{t('profile.balance')}</span>
          <span className="font-bold">{formatEtb(wallet?.total_balance ?? 0)}</span>
        </div>
      </Card>

      <div className="space-y-2">
        <button onClick={() => onNavigate?.('settings')} className="eds-card flex w-full items-center gap-3 p-3 text-left text-sm">
          <SettingsIcon className="h-4 w-4 text-[var(--eds-muted)]" /> {t('profile.settings')}
        </button>
        <button onClick={() => onNavigate?.('referral')} className="eds-card flex w-full items-center gap-3 p-3 text-left text-sm">
          <Gift className="h-4 w-4 text-[var(--eds-muted)]" /> {t('profile.referral')}
        </button>
        <button onClick={() => onNavigate?.('history')} className="eds-card flex w-full items-center gap-3 p-3 text-left text-sm">
          <History className="h-4 w-4 text-[var(--eds-muted)]" /> {t('profile.txHistory')}
        </button>
        <button onClick={() => onNavigate?.('rules')} className="eds-card flex w-full items-center gap-3 p-3 text-left text-sm">
          <BookOpen className="h-4 w-4 text-[var(--eds-muted)]" /> {t('profile.rules')}
        </button>
        <button onClick={() => onNavigate?.('help')} className="eds-card flex w-full items-center gap-3 p-3 text-left text-sm">
          <HelpCircle className="h-4 w-4 text-[var(--eds-muted)]" /> {t('profile.helpRules')}
        </button>
        <button onClick={() => onNavigate?.('support')} className="eds-card flex w-full items-center gap-3 p-3 text-left text-sm">
          <LifeBuoy className="h-4 w-4 text-[var(--eds-muted)]" /> {t('profile.support')}
        </button>
        <button onClick={refresh} className="eds-card flex w-full items-center gap-3 p-3 text-left text-sm">
          <RefreshCw className="h-4 w-4 text-[var(--eds-muted)]" /> {t('profile.refreshSession')}
        </button>
      </div>

      {config && (
        <Card className="mt-4 text-xs text-[var(--eds-muted)]">
          <p>{(config.rooms ?? []).map((r) => `${r.name}: ${r.capacity}`).join(' · ')}</p>
          <p>{t('profile.configLimit', { n: config.max_cartelas_per_player })}</p>
          <p>{t('profile.configSplit', { w: config.winner_percentage, h: config.house_percentage })}</p>
        </Card>
      )}
    </Screen>
  );
}

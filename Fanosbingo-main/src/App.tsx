import { useState, useCallback, useEffect } from 'react';
import { SessionProvider, useSession } from './lib/session';
import { api } from './lib/api';
import { Logo, Wordmark } from './components/common/Logo';
import { BottomNav, Tab } from './components/BottomNav';
import { LangProvider } from './i18n/LangProvider';
import { ThemeProvider } from './lib/theme';
import { translate, DEFAULT_LANG } from './i18n';
import { HomeScreen } from './screens/HomeScreen';
import { BingoScreen } from './screens/BingoScreen';
import { MyCartelasScreen } from './screens/MyCartelasScreen';
import { WalletScreen } from './screens/WalletScreen';
import { DepositScreen } from './screens/DepositScreen';
import { WithdrawScreen } from './screens/WithdrawScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { ProfileScreen } from './screens/ProfileScreen';
import { HelpScreen } from './screens/HelpScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { ReferralScreen } from './screens/ReferralScreen';
import { RulesScreen } from './screens/RulesScreen';
import { ContactScreen } from './screens/ContactScreen';
import { GameRoom } from './components/GameRoom';
import { AdminApp } from './admin/AdminApp';

function Splash({ message, error, onRetry }: { message: string; error?: boolean; onRetry?: () => void }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-5 bg-[var(--eds-bg)] p-6 text-center">
      <Logo className="h-14 w-auto" />
      <Wordmark className="text-lg" />
      <p className={`text-sm ${error ? 'text-red-400' : 'text-emerald-200/80'}`}>{message}</p>
      {error && onRetry && (
        <button onClick={onRetry} className="rounded-xl bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-500">
          {translate(DEFAULT_LANG, 'common.tryAgain')}
        </button>
      )}
    </div>
  );
}

function Shell() {
  const { loading, error, user, lang, theme, refresh } = useSession();
  const [tab, setTab] = useState<Tab>('home');
  const [activeGameId, setActiveGameId] = useState<string | null>(null);
  const isAdminPath = typeof window !== 'undefined' && window.location.pathname.startsWith('/admin');

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    // Polling only (see SUPABASE_MIGRATION_REPORT.md §3) — reuses the same
    // lobby snapshot every other screen already polls, rather than a
    // separate direct table read.
    const check = async () => {
      const snap = await api.lobby();
      if (cancelled) return;
      const playing = snap.game && (snap.game as { status?: string }).status === 'playing';
      setActiveGameId(playing && snap.my_cartelas.length > 0 ? (snap.game as { id: string }).id : null);
    };
    check();
    const iv = setInterval(check, 8000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [user]);

  const goDeposit = useCallback(() => setTab('deposit'), []);
  const goWithdraw = useCallback(() => setTab('withdraw'), []);

  if (isAdminPath) return <AdminApp />;
  if (loading) return <Splash message={translate(DEFAULT_LANG, 'session.loading')} />;
  if (error || !user) {
    return <Splash message={error ?? translate(DEFAULT_LANG, 'session.error')} error onRetry={refresh} />;
  }

  return (
    <ThemeProvider theme={theme}>
    <LangProvider lang={lang}>
      {activeGameId ? (
        <GameRoom gameId={activeGameId} onExit={() => setActiveGameId(null)} onWithdraw={goWithdraw} />
      ) : (
        <div className="min-h-screen bg-[var(--eds-bg)] pb-20 text-[var(--eds-fg)]">
          <div className="mx-auto max-w-lg">
            {tab === 'home' && <HomeScreen onNavigate={setTab} />}
            {tab === 'bingo' && <BingoScreen onNeedDeposit={goDeposit} />}
            {tab === 'cartelas' && <MyCartelasScreen />}
            {tab === 'wallet' && <WalletScreen onDeposit={goDeposit} onWithdraw={goWithdraw} />}
            {tab === 'deposit' && <DepositScreen onDone={() => setTab('wallet')} />}
            {tab === 'withdraw' && <WithdrawScreen onDone={() => setTab('wallet')} />}
            {tab === 'history' && <HistoryScreen />}
            {tab === 'profile' && <ProfileScreen onNavigate={setTab} />}
            {tab === 'settings' && <SettingsScreen onDone={() => setTab('profile')} />}
            {tab === 'help' && <HelpScreen />}
            {tab === 'referral' && <ReferralScreen onBack={() => setTab('profile')} />}
            {tab === 'rules' && <RulesScreen onBack={() => setTab('profile')} />}
            {tab === 'support' && <ContactScreen onBack={() => setTab('profile')} />}
          </div>
          <BottomNav tab={tab} onChange={setTab} />
        </div>
      )}
    </LangProvider>
    </ThemeProvider>
  );
}

export default function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}

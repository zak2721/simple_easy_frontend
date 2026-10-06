import { ArrowDownToLine, ArrowUpFromLine, Trophy, Users } from 'lucide-react';
import { useSession } from '../lib/session';
import { useLobby } from '../lib/useLobby';
import { useT } from '../i18n/LangProvider';
import { Screen, Card } from '../components/common/Screen';
import { Logo } from '../components/common/Logo';
import { formatEtb } from '../lib/format';
import { Tab } from '../components/BottomNav';
import { FALLBACK_ROOMS } from '../config/brand';

export function HomeScreen({ onNavigate }: { onNavigate: (t: Tab) => void }) {
  const { user, config } = useSession();
  const t = useT();
  const { data } = useLobby(user?.telegram_user_id);

  const wallet = data?.wallet;
  const counts = data?.my_counts ?? { total: 0 };
  const max = config?.max_cartelas_per_player ?? 4;
  const game = data?.game;
  const rooms = data?.room_list ?? FALLBACK_ROOMS;

  return (
    <Screen right={<span className="text-xs text-[var(--eds-muted)]">{t('home.greeting', { name: user?.first_name ?? '' })}</span>}>
      <div className="mb-4 flex flex-col items-center gap-2">
        <Logo className="h-12 w-auto" />
      </div>

      <Card className="mb-3 bg-gradient-to-br from-emerald-700/40 to-emerald-900/30">
        <p className="text-xs uppercase tracking-wide text-emerald-200/70">{t('home.walletBalance')}</p>
        <p className="mt-1 text-3xl font-extrabold">{formatEtb(wallet?.total_balance ?? 0)}</p>
        <div className="mt-1 flex gap-4 text-xs text-[var(--eds-muted)]">
          <span>{t('home.winnings', { amount: formatEtb(wallet?.won_balance ?? 0, { symbol: false }) })}</span>
          {(wallet?.on_hold ?? 0) > 0 && <span>{t('home.onHold', { amount: formatEtb(wallet!.on_hold, { symbol: false }) })}</span>}
        </div>
        <div className="mt-3 flex gap-2">
          <button onClick={() => onNavigate('deposit')} className="eds-btn flex flex-1 items-center justify-center gap-1.5 text-sm">
            <ArrowDownToLine className="h-4 w-4" /> {t('home.deposit')}
          </button>
          <button onClick={() => onNavigate('withdraw')} className="eds-btn eds-btn-ghost flex flex-1 items-center justify-center gap-1.5 text-sm">
            <ArrowUpFromLine className="h-4 w-4" /> {t('home.withdraw')}
          </button>
        </div>
      </Card>

      <div className="mb-3 grid grid-cols-2 gap-3">
        {rooms.map((room) => {
          const taken = 'taken' in room ? room.taken.length : 0;
          const cap = room.capacity;
          return (
            <button key={room.code} onClick={() => onNavigate('bingo')} className="eds-card p-3 text-left">
              <p className="text-sm font-bold">{room.name}</p>
              <p className="text-xs text-[var(--eds-muted)]">{t('home.roomSub', { price: formatEtb(room.price), cap })}</p>
              <p className="mt-2 text-xs text-emerald-300">{t('home.available', { n: cap - taken })}</p>
            </button>
          );
        })}
      </div>

      <Card className="mb-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-bold">{t('home.myCartelas')}</p>
            <p className="text-xs text-[var(--eds-muted)]">
              {rooms.map((room) => `${room.name}: ${counts[room.code] ?? 0}`).join(' · ')}
            </p>
          </div>
          <p className={`text-2xl font-extrabold ${counts.total >= max ? 'text-amber-400' : 'text-emerald-400'}`}>
            {t('home.countOfMax', { owned: counts.total, max })}
          </p>
        </div>
      </Card>

      <Card>
        <p className="mb-1 text-sm font-bold">{t('home.gameStatus')}</p>
        {game ? (
          <div className="text-sm text-[var(--eds-muted)]">
            <p>
              {t('home.gameLine', {
                n: game.game_number,
                state: game.status === 'playing' ? t('home.stateLive') : t('home.stateAccepting'),
              })}
            </p>
            <div className="mt-1 flex gap-4 text-xs">
              <span className="flex items-center gap-1"><Trophy className="h-3.5 w-3.5" /> {t('home.pot', { amount: formatEtb(game.total_pot) })}</span>
              <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" /> {t('home.calls', { n: game.called_numbers.length })}</span>
            </div>
            <button onClick={() => onNavigate('bingo')} className="eds-btn mt-3 w-full text-sm">
              {t('home.goToBingo')}
            </button>
          </div>
        ) : (
          <p className="text-sm text-[var(--eds-muted)]">{t('home.noGame')}</p>
        )}
      </Card>
    </Screen>
  );
}

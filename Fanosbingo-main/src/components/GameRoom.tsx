import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trophy, Eye, LogOut } from 'lucide-react';
import type { Game, Player } from '../lib/types';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useT } from '../i18n/LangProvider';
import { BingoCard } from './BingoCard';
import { LogoMark } from './common/Logo';
import { formatEtb, bingoLetter } from '../lib/format';

interface Props {
  gameId: string;
  onExit: () => void;
  onWithdraw: () => void;
}

const BOARD = Array.from({ length: 75 }, (_, i) => i + 1);

const roomLabel = (p: Player) => p.room_name || p.room_type;

export function GameRoom({ gameId, onExit, onWithdraw }: Props) {
  const { refresh } = useSession();
  const t = useT();
  const [game, setGame] = useState<Game | null>(null);
  const [mine, setMine] = useState<Player[]>([]);
  const [tab, setTab] = useState(0);
  const [claimMsg, setClaimMsg] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const exitedRef = useRef(false);

  const load = useCallback(async () => {
    const { game: g, my_cartelas: ps } = await api.getGame(gameId);
    if (g) setGame(g as unknown as Game);
    if (ps) setMine(ps as unknown as Player[]);
  }, [gameId]);

  useEffect(() => {
    load();
    // Polling only — see SUPABASE_MIGRATION_REPORT.md §3: this exact 3s poll
    // already ran in parallel with Realtime as a defensive fallback, so
    // dropping Realtime here is a proven path, not new behavior.
    const iv = setInterval(load, 3000);
    return () => { clearInterval(iv); };
  }, [gameId, load]);

  // return everyone to the lobby together
  useEffect(() => {
    if (game?.status !== 'finished') return;
    const at = game.return_to_lobby_at ? new Date(game.return_to_lobby_at).getTime() : Date.now() + 8000;
    const t = setTimeout(() => {
      if (exitedRef.current) return;
      exitedRef.current = true;
      refresh();
      onExit();
    }, Math.max(1500, at - Date.now()));
    return () => clearTimeout(t);
  }, [game?.status, game?.return_to_lobby_at, onExit, refresh]);

  const called = useMemo(() => new Set(game?.called_numbers ?? []), [game]);
  const isSpectator = mine.length === 0;
  const active = mine[tab];

  const markedFor = useCallback((p: Player): boolean[][] => {
    return (p.card_numbers ?? []).map((col, ci) =>
      col.map((n, ri) => (ci === 2 && ri === 2) || called.has(n)),
    );
  }, [called]);

  const claim = async () => {
    if (!active || claiming) return;
    setClaiming(true);
    setClaimMsg(null);
    try {
      const r = await api.claimBingo(active.id) as { isWinner?: boolean; disqualified?: boolean; alreadyClaimed?: boolean };
      if (r.disqualified) setClaimMsg(t('game.claimDq', { n: active.selected_number }));
      else if (r.alreadyClaimed) setClaimMsg(t('game.claimAlready'));
      else if (r.isWinner) setClaimMsg(t('game.claimWin'));
      else setClaimMsg(t('game.claimSubmitted'));
      load();
    } catch (e) {
      setClaimMsg(e instanceof Error ? e.message : t('game.claimFailed'));
    } finally {
      setClaiming(false);
    }
  };

  if (!game) {
    return <div className="flex min-h-screen items-center justify-center text-[var(--eds-muted)]">{t('common.loading')}</div>;
  }

  const myWinningId = mine.find((p) => (game.winner_ids ?? []).includes(p.id))?.id;
  const iWon = !!myWinningId;
  const prizeEach =
    (myWinningId && game.winner_payouts?.[myWinningId]) ||
    game.winner_prize_each ||
    Math.floor(game.winner_prize || 0);

  return (
    <div className="min-h-screen bg-[var(--eds-bg)] p-3 text-[var(--eds-fg)]">
      <div className="mx-auto max-w-lg">
        <header className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <LogoMark className="h-7 w-7" />
            <span className="text-sm font-bold">{t('game.gameNum', { n: game.game_number })}</span>
          </div>
          <span className={`text-xs font-bold ${game.status === 'playing' ? 'text-emerald-400' : 'text-amber-300'}`}>
            {game.status === 'playing' ? t('game.statusLive') : game.status === 'waiting' ? t('game.statusWaiting') : t('game.statusFinished')}
          </span>
        </header>

        <div className="mb-3 grid grid-cols-3 gap-2 text-center">
          <Stat label={t('game.statPot')} value={formatEtb(game.total_pot)} />
          <Stat label={t('game.statWinner')} value={formatEtb(game.winner_prize || 0)} />
          <Stat label={t('game.statCalls')} value={String(game.called_numbers.length)} />
        </div>

        {/* called-numbers board */}
        <div className="eds-card mb-3 p-2">
          {game.current_number && (
            <div className="mb-2 text-center">
              <span className="rounded-full bg-amber-500 px-3 py-1 text-lg font-extrabold text-black">
                {bingoLetter(game.current_number)}-{game.current_number}
              </span>
            </div>
          )}
          <div className="grid grid-cols-5 gap-1">
            {[0, 1, 2, 3, 4].map((c) => (
              <div key={c} className="flex flex-col gap-1">
                <div className="rounded bg-[var(--eds-surface-2)] py-0.5 text-center text-[10px] font-bold">{'BINGO'[c]}</div>
                {BOARD.slice(c * 15, c * 15 + 15).map((n) => (
                  <div key={n} className={`rounded py-0.5 text-center text-[10px] font-semibold ${called.has(n) ? 'bg-emerald-600 text-white' : 'bg-white/5 text-[var(--eds-muted)]'}`}>
                    {n}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {isSpectator ? (
          <div className="eds-card flex flex-col items-center gap-2 p-6 text-center">
            <Eye className="h-8 w-8 text-[var(--eds-muted)]" />
            <p className="font-bold">{t('game.spectating')}</p>
            <p className="text-sm text-[var(--eds-muted)]">{t('game.spectatingBody')}</p>
          </div>
        ) : (
          <>
            {mine.length > 1 && (
              <div className="mb-2 flex gap-1 overflow-x-auto">
                {mine.map((p, i) => (
                  <button
                    key={p.id}
                    onClick={() => setTab(i)}
                    className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-bold ${i === tab ? 'bg-emerald-600 text-white' : 'bg-white/5 text-[var(--eds-muted)]'} ${p.is_disqualified ? 'line-through opacity-60' : ''}`}
                  >
                    {roomLabel(p)} #{p.selected_number}
                  </button>
                ))}
              </div>
            )}

            {active && (
              <>
                <p className="mb-1 text-xs text-[var(--eds-muted)]">
                  {t('game.cartelaLabel', { room: roomLabel(active), n: active.selected_number })}
                  {active.is_disqualified && ` · ${t('game.disqualified')}`}
                </p>
                <BingoCard
                  card={active.card_numbers}
                  markedCells={markedFor(active)}
                  onCellClick={() => {}}
                  disabled
                  isDarkMode
                />
                {game.status === 'playing' && !active.is_disqualified && (
                  <button onClick={claim} disabled={claiming} className="eds-btn mt-3 w-full bg-amber-500 text-lg text-black">
                    {claiming ? t('game.claiming') : t('game.bingoBtn')}
                  </button>
                )}
              </>
            )}
            {claimMsg && <p className="mt-2 rounded-lg bg-white/5 px-3 py-2 text-center text-sm">{claimMsg}</p>}
          </>
        )}

        {game.status === 'finished' && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <div className="eds-card w-full max-w-sm p-6 text-center">
              <Trophy className="mx-auto h-14 w-14 text-amber-400" />
              {(game.winner_ids?.length ?? 0) === 0 ? (
                <>
                  <h2 className="mt-2 text-xl font-extrabold">{t('game.noWinner')}</h2>
                  <p className="mt-1 text-sm text-[var(--eds-muted)]">{t('game.noWinnerBody')}</p>
                </>
              ) : iWon ? (
                <>
                  <h2 className="mt-2 text-2xl font-extrabold text-emerald-400">{t('game.youWon')}</h2>
                  <p className="mt-1 text-xs uppercase text-[var(--eds-muted)]">{t('game.yourPrize')}</p>
                  <p className="text-3xl font-extrabold">{formatEtb(prizeEach)}</p>
                  <button onClick={() => { onExit(); onWithdraw(); }} className="eds-btn mt-4 w-full">{t('wallet.withdraw')}</button>
                </>
              ) : (
                <>
                  <h2 className="mt-2 text-xl font-extrabold">{t('game.over')}</h2>
                  <p className="mt-1 text-sm text-[var(--eds-muted)]">
                    {game.winner_ids!.length > 1
                      ? t('game.winnersSplit', { amount: formatEtb(game.winner_prize || 0) })
                      : t('game.winnerTakes', { amount: formatEtb(game.winner_prize || 0) })}
                  </p>
                </>
              )}
              <button onClick={onExit} className="eds-btn eds-btn-ghost mt-3 flex w-full items-center justify-center gap-2">
                <LogOut className="h-4 w-4" /> {t('game.backToLobby')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="eds-card p-2">
      <p className="text-[10px] text-[var(--eds-muted)]">{label}</p>
      <p className="text-sm font-bold">{value}</p>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../lib/session';
import { useLobby } from '../lib/useLobby';
import { useT } from '../i18n/LangProvider';
import type { RoomKey } from '../lib/types';
import { api } from '../lib/api';
import { apiErrorMessage } from '../lib/api-client';
import { Screen, Card } from '../components/common/Screen';
import { RoomBoard } from '../components/RoomBoard';
import { formatEtb } from '../lib/format';
import { FALLBACK_ROOMS } from '../config/brand';

export function BingoScreen({ onNeedDeposit }: { onNeedDeposit: () => void }) {
  const { user, config, refresh } = useSession();
  const { data, reload, serverNow } = useLobby(user?.telegram_user_id);
  const t = useT();
  const [pending, setPending] = useState<Record<RoomKey, number[]>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number>(0);

  const rooms = data?.room_list ?? FALLBACK_ROOMS;
  const max = config?.max_cartelas_per_player ?? 4;
  const game = data?.game ?? null;
  const owned = data?.my_counts.total ?? 0;
  const pendingTotal = useMemo(() => Object.values(pending).reduce((sum, list) => sum + list.length, 0), [pending]);
  const selectionOpen = game?.status === 'waiting';

  useEffect(() => {
    if (data && !data.game) api.ensureWaitingGame().then(() => reload());
  }, [data, reload]);

  useEffect(() => {
    if (!game?.starts_at) return;
    const tick = () => setCountdown(Math.max(0, Math.floor((new Date(game.starts_at).getTime() - serverNow()) / 1000)));
    tick();
    const iv = setInterval(tick, 500);
    return () => clearInterval(iv);
  }, [game?.starts_at, serverNow]);

  const mineByRoom = useMemo(() => {
    const m: Record<RoomKey, number[]> = {};
    for (const c of data?.my_cartelas ?? []) m[c.room] = [...(m[c.room] ?? []), c.number];
    return m;
  }, [data]);

  const toggle = (room: RoomKey, n: number) => {
    setMsg(null);
    const owns = data?.my_cartelas.find((c) => c.room === room && c.number === n);
    if (owns) {
      if (!selectionOpen) return;
      setBusy(true);
      api.releaseCartela(owns.player_id)
        .then(() => { reload(); refresh(); })
        .catch((e) => setMsg(apiErrorMessage(e)))
        .finally(() => setBusy(false));
      return;
    }
    setPending((p) => {
      const list = p[room] ?? [];
      if (list.includes(n)) return { ...p, [room]: list.filter((x) => x !== n) };
      if (owned + pendingTotal >= max) {
        setMsg(t('bingo.msgLimit', { max }));
        return p;
      }
      return { ...p, [room]: [...list, n] };
    });
  };

  const confirm = async () => {
    if (!game || pendingTotal === 0 || !user) return;
    setBusy(true);
    setMsg(null);
    const jobs: Array<{ room: RoomKey; n: number }> = Object.entries(pending).flatMap(([room, list]) => list.map((n) => ({ room, n })));
    let ok = 0;
    for (const j of jobs) {
      try {
        await api.selectCartela({ gameId: game.id, room: j.room, cartelaNumber: j.n });
        ok++;
      } catch (e) {
        const code = apiErrorMessage(e);
        if (code === 'INSUFFICIENT_BALANCE') {
          setMsg(t('bingo.msgInsufficient'));
          setBusy(false); onNeedDeposit(); reload();
          return;
        }
        setMsg(
          code === 'CARD_TAKEN' ? t('bingo.err.cartelaTaken') :
          code === 'SELECTION_CLOSED' ? t('bingo.err.selectionClosed') :
          code.startsWith('Maximum') ? t('bingo.msgLimit', { max }) :
          t('bingo.err.generic'),
        );
        break;
      }
    }
    setPending({});
    if (ok) setMsg(t('bingo.msgSecured', { n: ok, plural: ok > 1 ? 's' : '' }));
    await reload();
    await refresh();
    setBusy(false);
  };

  const cost = rooms.reduce((sum, room) => sum + (pending[room.code]?.length ?? 0) * room.price, 0);

  return (
    <Screen title={t('bingo.title')}>
      <Card className="mb-3">
        <div className="flex items-center justify-between text-sm">
          <span className="font-bold">
            {game ? t('bingo.gameNumber', { n: game.game_number }) : t('bingo.starting')}
          </span>
          {game?.status === 'waiting' && (
            <span className={countdown <= 5 ? 'font-bold text-red-400' : 'text-[var(--eds-muted)]'}>
              {countdown > 0 ? t('bingo.startsIn', { s: countdown }) : t('bingo.starting')}
            </span>
          )}
          {game?.status === 'playing' && <span className="font-bold text-emerald-400">{t('bingo.live')}</span>}
        </div>
        <p className="mt-1 text-xs text-[var(--eds-muted)]">
          {t('bingo.limitNoteIntro', { max })} {rooms.map((room) => `${room.name}: ${mineByRoom[room.code]?.length ?? 0}`).join(' · ')} · {t('bingo.limitNoteTotal', { t: owned, max })}
        </p>
      </Card>

      {msg && <div className="mb-3 rounded-lg bg-white/5 px-3 py-2 text-sm text-amber-300">{msg}</div>}

      <div className="space-y-3">
        {rooms.map((room) => (
          <RoomBoard
            key={room.code}
            room={room.code} label={room.name} price={room.price}
            capacity={room.capacity}
            taken={data?.rooms?.[room.code]?.taken ?? []} mine={mineByRoom[room.code] ?? []} pending={pending[room.code] ?? []}
            disabled={!selectionOpen || busy} onToggle={(n) => toggle(room.code, n)}
          />
        ))}
      </div>

      {pendingTotal > 0 && (
        <div className="fixed inset-x-0 bottom-16 mx-auto max-w-lg px-3">
          <button onClick={confirm} disabled={busy} className="eds-btn w-full">
            {busy ? t('bingo.securing') : t('bingo.confirmBtn', { n: pendingTotal, plural: pendingTotal > 1 ? 's' : '', cost: formatEtb(cost) })}
          </button>
        </div>
      )}
    </Screen>
  );
}

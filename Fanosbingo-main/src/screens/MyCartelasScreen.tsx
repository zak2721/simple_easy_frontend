import { useState } from 'react';
import { useSession } from '../lib/session';
import { useLobby } from '../lib/useLobby';
import { useT } from '../i18n/LangProvider';
import { api } from '../lib/api';
import { Screen, Card } from '../components/common/Screen';
import type { RoomKey } from '../lib/types';
import { FALLBACK_ROOMS } from '../config/brand';

function MiniCard({ card }: { card: number[][] }) {
  if (!card?.length) return null;
  return (
    <div className="grid grid-cols-5 gap-0.5">
      {Array.from({ length: 5 }, (_, row) =>
        card.map((col, ci) => {
          const free = ci === 2 && row === 2;
          return (
            <div key={`${ci}-${row}`} className={`flex h-6 items-center justify-center rounded text-[10px] font-bold ${free ? 'bg-emerald-600 text-white' : 'bg-[var(--eds-surface-2)]'}`}>
              {free ? '★' : col[row]}
            </div>
          );
        }),
      )}
    </div>
  );
}

export function MyCartelasScreen() {
  const { user, config, refresh } = useSession();
  const { data, reload } = useLobby(user?.telegram_user_id);
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const max = config?.max_cartelas_per_player ?? 4;

  const waiting = data?.game?.status === 'waiting';
  const rooms = data?.room_list ?? FALLBACK_ROOMS;
  type Cart = { player_id: string; room: RoomKey; number: number; card: number[][]; is_disqualified: boolean };
  const byRoom: Record<RoomKey, Cart[]> = {};
  for (const c of data?.my_cartelas ?? []) byRoom[c.room] = [...(byRoom[c.room] ?? []), c];

  const release = async (playerId: string) => {
    setBusy(playerId);
    try {
      await api.releaseCartela(playerId);
      await reload();
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const total = data?.my_cartelas.length ?? 0;

  return (
    <Screen title={t('cartelas.title')}>
      <Card className="mb-3 flex items-center justify-between">
        <span className="text-sm text-[var(--eds-muted)]">{t('cartelas.totalThisGame')}</span>
        <span className={`text-xl font-extrabold ${total >= max ? 'text-amber-400' : 'text-emerald-400'}`}>{t('home.countOfMax', { owned: total, max })}</span>
      </Card>

      {rooms.map((room) => (
        <div key={room.code} className="mb-4">
          <p className="mb-2 text-sm font-bold">
            {room.name} <span className="text-[var(--eds-muted)]">· {byRoom[room.code]?.length ?? 0}</span>
          </p>
          {!byRoom[room.code]?.length ? (
            <p className="text-xs text-[var(--eds-muted)]">{t('cartelas.noneInRoom')}</p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {byRoom[room.code].map((c) => (
                <Card key={c.player_id} className="!p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-bold">#{c.number}</span>
                    {c.is_disqualified && <span className="text-[10px] text-red-400">{t('cartelas.dq')}</span>}
                  </div>
                  <MiniCard card={c.card} />
                  {waiting && (
                    <button
                      onClick={() => release(c.player_id)}
                      disabled={busy === c.player_id}
                      className="mt-2 w-full rounded-lg bg-white/5 py-1.5 text-[11px] text-red-300"
                    >
                      {busy === c.player_id ? '…' : t('cartelas.release')}
                    </button>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>
      ))}

      {total === 0 && <p className="text-sm text-[var(--eds-muted)]">{t('cartelas.hint')}</p>}
    </Screen>
  );
}

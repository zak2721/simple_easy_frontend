import { useMemo } from 'react';
import type { RoomKey } from '../lib/types';
import { useT } from '../i18n/LangProvider';

export interface RoomBoardProps {
  room: RoomKey;
  label: string;
  price: number;
  capacity: number;
  taken: number[];
  mine: number[];
  pending: number[];
  disabled?: boolean;
  onToggle: (n: number) => void;
}

export function RoomBoard({ label, price, capacity, taken, mine, pending, disabled, onToggle }: RoomBoardProps) {
  const t = useT();
  const takenSet = useMemo(() => new Set(taken), [taken]);
  const mineSet = useMemo(() => new Set(mine), [mine]);
  const pendingSet = useMemo(() => new Set(pending), [pending]);
  const nums = useMemo(() => Array.from({ length: capacity }, (_, i) => i + 1), [capacity]);
  const available = capacity - takenSet.size;

  return (
    <div className="eds-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <p className="text-sm font-bold">{label}</p>
          <p className="text-[11px] text-[var(--eds-muted)]">{t('bingo.roomSub', { price, cap: capacity })}</p>
        </div>
        <span className="text-[11px] text-emerald-300">{t('bingo.left', { n: available })}</span>
      </div>
      <div className="grid max-h-52 grid-cols-8 gap-1 overflow-y-auto p-0.5 sm:grid-cols-10">
        {nums.map((n) => {
          const isMine = mineSet.has(n);
          const isPending = pendingSet.has(n);
          const isTaken = takenSet.has(n) && !isMine;
          const cls = isMine
            ? 'bg-emerald-600 text-white ring-2 ring-emerald-400'
            : isPending
            ? 'bg-amber-500 text-black ring-2 ring-amber-300'
            : isTaken
            ? 'bg-red-900/40 text-red-400/70 cursor-not-allowed'
            : 'bg-[var(--eds-surface-2)] text-[var(--eds-fg)]';
          return (
            <button
              key={n}
              disabled={isTaken || (disabled && !isMine && !isPending)}
              onClick={() => onToggle(n)}
              className={`h-8 rounded text-xs font-bold transition-colors ${cls}`}
            >
              {n}
            </button>
          );
        })}
      </div>
    </div>
  );
}

import { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { LogoMark, Wordmark } from './Logo';
import { useT } from '../../i18n/LangProvider';
import type { TKey } from '../../i18n';

export function Screen({
  title,
  children,
  onBack,
  right,
}: {
  title?: string;
  children: ReactNode;
  onBack?: () => void;
  right?: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-white/10 bg-[var(--eds-surface)]/95 px-3 py-3 backdrop-blur">
        {onBack ? (
          <button onClick={onBack} className="rounded-lg p-1 text-[var(--eds-muted)] hover:text-[var(--eds-fg)]">
            <ChevronLeft className="h-5 w-5" />
          </button>
        ) : (
          <LogoMark className="h-7 w-7" />
        )}
        <div className="flex-1">
          {title ? (
            <h1 className="text-base font-bold">{title}</h1>
          ) : (
            <Wordmark className="text-sm" />
          )}
        </div>
        {right}
      </header>
      <main className="px-3 py-4">{children}</main>
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`eds-card p-4 ${className}`}>{children}</div>;
}

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-amber-500/15 text-amber-300',
  approved: 'bg-sky-500/15 text-sky-300',
  paid: 'bg-emerald-500/15 text-emerald-300',
  rejected: 'bg-red-500/15 text-red-300',
  cancelled: 'bg-white/10 text-[var(--eds-muted)]',
};

const LOCALIZED_STATUSES = new Set(['pending', 'approved', 'paid', 'rejected', 'cancelled']);

/** `status` is the DB value — never translated; only the displayed label is. */
export function StatusPill({ status }: { status: string }) {
  const t = useT();
  const label = LOCALIZED_STATUSES.has(status) ? t(`status.${status}` as TKey) : status.toUpperCase();
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${STATUS_STYLE[status] ?? 'bg-white/10 text-[var(--eds-muted)]'}`}>
      {label}
    </span>
  );
}

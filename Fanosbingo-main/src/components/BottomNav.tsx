import { Home, Grid3x3, Ticket, Wallet as WalletIcon, User } from 'lucide-react';
import { useT } from '../i18n/LangProvider';
import type { TKey } from '../i18n';

export type Tab =
  | 'home' | 'bingo' | 'cartelas' | 'wallet' | 'deposit'
  | 'withdraw' | 'history' | 'profile' | 'settings' | 'help' | 'referral' | 'rules' | 'support';

const items: { key: Tab; label: TKey; icon: typeof Home }[] = [
  { key: 'home', label: 'nav.home', icon: Home },
  { key: 'bingo', label: 'nav.bingo', icon: Grid3x3 },
  { key: 'cartelas', label: 'nav.cartelas', icon: Ticket },
  { key: 'wallet', label: 'nav.wallet', icon: WalletIcon },
  { key: 'profile', label: 'nav.profile', icon: User },
];

export function BottomNav({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const t = useT();
  const active: Tab =
    tab === 'deposit' || tab === 'withdraw' ? 'wallet' :
    tab === 'history' || tab === 'help' || tab === 'settings' || tab === 'referral' || tab === 'rules' || tab === 'support' ? 'profile' : tab;

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 mx-auto flex max-w-lg items-stretch justify-between border-t border-white/10 bg-[var(--eds-surface)] px-2 pb-[env(safe-area-inset-bottom)]">
      {items.map(({ key, label, icon: Icon }) => {
        const on = active === key;
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium transition-colors ${
              on ? 'text-emerald-400' : 'text-[var(--eds-muted)]'
            }`}
          >
            <Icon className="h-5 w-5" strokeWidth={on ? 2.5 : 2} />
            {t(label)}
          </button>
        );
      })}
    </nav>
  );
}

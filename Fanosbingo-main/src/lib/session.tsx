import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import WebApp from '@twa-dev/sdk';
import { playerApi, playerTokens, apiErrorMessage } from './api-client';
import { currentOperatorSlug } from './operator';
import type { Wallet, YenaBingoConfig, ContactInfo, EffectiveTheme } from './types';
import { Lang, DEFAULT_LANG, isLang } from '../i18n';

export interface PlayerUser {
  telegram_user_id: number;
  first_name: string;
  username?: string;
}

interface SessionState {
  loading: boolean;
  error: string | null;
  user: PlayerUser | null;
  wallet: Wallet | null;
  config: YenaBingoConfig | null;
  contact: ContactInfo | null;
  lang: Lang;
  theme: EffectiveTheme | null;
  selectedThemeId: string | null;
  refresh: () => Promise<void>;
  setWallet: (w: Wallet) => void;
  /** persist a new UI language for this player (Profile → Settings → Language) */
  setLang: (lang: Lang) => Promise<boolean>;
  /**
   * Persist a new theme selection (Profile → Settings → Theme). `themeId`
   * null reverts to the system default. `resolvedTheme` is the theme object
   * to apply immediately (the caller already has it from `api.themes()`) —
   * avoids a full session re-fetch (and the loading-splash flash that would
   * cause) just to redraw CSS variables.
   */
  setTheme: (themeId: string | null, resolvedTheme: EffectiveTheme | null) => Promise<boolean>;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<PlayerUser | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [config, setConfig] = useState<YenaBingoConfig | null>(null);
  const [contact, setContact] = useState<ContactInfo | null>(null);
  const [lang, setLangState] = useState<Lang>(DEFAULT_LANG);
  const [theme, setThemeState] = useState<EffectiveTheme | null>(null);
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);

  const establish = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      try {
        WebApp.ready();
        WebApp.expand();
      } catch { /* not in Telegram */ }

      const initData = WebApp?.initData ?? '';
      const devUserRaw = import.meta.env.VITE_DEV_TELEGRAM_USER;
      const devUser = devUserRaw ? JSON.parse(devUserRaw) : undefined;

      if (!initData && !devUser) {
        throw new Error('Open የኛ bingo from the Telegram bot to play.');
      }

      // Referral code: either the Telegram deep-link start_param (bot's
      // /invite link, "?start=ref_<code>" -> initDataUnsafe.start_param =
      // "ref_<code>") or a plain "?ref=<code>" URL param for links shared
      // outside Telegram. Without this, ReferralsService.recordReferral on
      // the backend never receives a code and no referral is ever recorded.
      const startParam = WebApp?.initDataUnsafe?.start_param;
      const refFromUrl = new URLSearchParams(window.location.search).get('ref');
      const referralCode = startParam?.startsWith('ref_') ? startParam.slice(4) : (refFromUrl ?? undefined);

      const { data } = await playerApi.post('/auth/telegram', {
        initData: initData || undefined,
        devTelegramUserId: devUser?.id,
        referralCode: referralCode || undefined,
        operatorSlug: currentOperatorSlug(),
      });

      playerTokens.setAccess(data.accessToken);

      setUser({
        telegram_user_id: data.user.telegram_user_id,
        first_name: data.user.first_name,
        username: data.user.username ?? undefined,
      });
      setLangState(isLang(data.user?.language_code) ? data.user.language_code : DEFAULT_LANG);
      setWallet(data.wallet);
      setConfig(data.config);
      setContact(data.contact ?? null);
      setThemeState(data.theme?.effective ?? null);
      setSelectedThemeId(data.theme?.selectedThemeId ?? null);
    } catch (e) {
      setError(apiErrorMessage(e, 'Session error'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { establish(); }, [establish]);

  const setLang = useCallback(async (next: Lang): Promise<boolean> => {
    if (!user) return false;
    const prev = lang;
    setLangState(next); // optimistic — instant UI switch
    try {
      await playerApi.post('/users/language', { languageCode: next });
      return true;
    } catch {
      setLangState(prev); // roll back on failure
      return false;
    }
  }, [user, lang]);

  const setTheme = useCallback(async (themeId: string | null, resolvedTheme: EffectiveTheme | null): Promise<boolean> => {
    if (!user) return false;
    const prevId = selectedThemeId;
    const prevTheme = theme;
    setSelectedThemeId(themeId);
    if (resolvedTheme) setThemeState(resolvedTheme); // optimistic — instant repaint, matches setLang's pattern
    try {
      await playerApi.post('/users/theme', { themeId });
      return true;
    } catch {
      setSelectedThemeId(prevId);
      setThemeState(prevTheme);
      return false;
    }
  }, [user, selectedThemeId, theme]);

  return (
    <Ctx.Provider value={{ loading, error, user, wallet, config, contact, lang, theme, selectedThemeId, refresh: establish, setWallet, setLang, setTheme }}>
      {children}
    </Ctx.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- Provider + hook colocated by convention
export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used inside <SessionProvider>');
  return v;
}

import { createContext, useContext, useMemo, ReactNode } from 'react';
import { Lang, TKey, Vars, makeT, DEFAULT_LANG } from './index';

interface LangCtx {
  lang: Lang;
  t: (key: TKey, vars?: Vars) => string;
}

const Ctx = createContext<LangCtx>({ lang: DEFAULT_LANG, t: makeT(DEFAULT_LANG) });

/** Wrap the app; `lang` comes from the player's session (telegram_users.language_code). */
export function LangProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  const value = useMemo<LangCtx>(() => ({ lang, t: makeT(lang) }), [lang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** `const t = useT(); t('wallet.title')` */
export function useT() {
  return useContext(Ctx).t;
}

export function useLang() {
  return useContext(Ctx).lang;
}

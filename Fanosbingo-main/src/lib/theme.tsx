import { createContext, useContext, useEffect, ReactNode } from 'react';
import type { EffectiveTheme } from './types';

const CSS_VAR_MAP: Record<keyof Pick<
  EffectiveTheme,
  'backgroundColor' | 'surfaceColor' | 'surfaceAltColor' | 'textColor' | 'mutedTextColor' | 'primaryColor' | 'secondaryColor' | 'accentColor'
>, string> = {
  backgroundColor: '--eds-bg',
  surfaceColor: '--eds-surface',
  surfaceAltColor: '--eds-surface-2',
  textColor: '--eds-fg',
  mutedTextColor: '--eds-muted',
  primaryColor: '--eds-brand',
  secondaryColor: '--eds-brand-strong',
  accentColor: '--eds-accent',
};

const Ctx = createContext<EffectiveTheme | null>(null);

/**
 * Applies the effective theme by overwriting the same CSS custom properties
 * every screen already reads (src/index.css's :root block) — zero component
 * changes needed anywhere else in the app. Falls back to whatever index.css
 * already has statically if `theme` is null (e.g. before the session loads).
 */
export function ThemeProvider({ theme, children }: { theme: EffectiveTheme | null; children: ReactNode }) {
  useEffect(() => {
    if (!theme) return;
    const root = document.documentElement.style;
    for (const [key, cssVar] of Object.entries(CSS_VAR_MAP) as [keyof typeof CSS_VAR_MAP, string][]) {
      root.setProperty(cssVar, theme[key]);
    }
  }, [theme]);

  return <Ctx.Provider value={theme}>{children}</Ctx.Provider>;
}

/** The currently-applied theme, if any component needs its raw values (e.g. previewing button colors). */
// eslint-disable-next-line react-refresh/only-export-components -- Provider + hook colocated by convention
export function useTheme() {
  return useContext(Ctx);
}

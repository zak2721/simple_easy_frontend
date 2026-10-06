/*
 * የኛ — centralized i18n.
 *
 *   translate('am', 'wallet.title')                -> 'ዋሌት'
 *   translate('en', 'home.greeting', { name: 'A' }) -> 'Hi, A'
 *
 * Fallback chain: requested language -> Amharic (default) -> English -> the key.
 * The bot uses the same dictionaries via supabase/functions/_shared/i18n.ts
 * (kept structurally identical).
 */
import { en, type TKey } from './en';
import { am } from './am';
import { om } from './om';
import { ti } from './ti';
import { BRAND } from '../config/brand';

export type Lang = 'en' | 'am' | 'om' | 'ti';
export const LANGS: Lang[] = ['en', 'am', 'om', 'ti'];
export const DEFAULT_LANG: Lang = 'am';
export type { TKey };

const DICTS: Record<Lang, Record<TKey, string>> = { en, am, om, ti };

export function isLang(x: unknown): x is Lang {
  return x === 'en' || x === 'am' || x === 'om' || x === 'ti';
}

export type Vars = Record<string, string | number>;

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_m, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

/** Resolve a key for a language with the fallback chain. Never throws. */
export function translate(lang: Lang, key: TKey, vars?: Vars): string {
  const raw =
    DICTS[lang]?.[key] ??
    DICTS[DEFAULT_LANG]?.[key] ??
    DICTS.en?.[key] ??
    (key as string);
  return interpolate(raw, { app: BRAND.fullName, ...vars });
}

/** Bind a language once: `const t = makeT(lang); t('wallet.title')`. */
export function makeT(lang: Lang) {
  return (key: TKey, vars?: Vars) => translate(lang, key, vars);
}

export { en, am, om, ti };

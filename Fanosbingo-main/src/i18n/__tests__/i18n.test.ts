/*
 * የኛ — i18n guarantees.
 *
 * The compiler already enforces that am.ts / om.ts implement every TKey
 * (they are `Record<TKey, string>`). These runtime tests cover what the
 * type system can't: the fallback chain, placeholder parity across
 * languages, the default language, and that the Telegram bot's separate
 * dictionary (supabase/functions/_shared/i18n.ts) stays in sync with the
 * `bot.*` keys here.
 */
import { describe, it, expect } from 'vitest';
import { en } from '../en';
import { am } from '../am';
import { om } from '../om';
import { ti } from '../ti';
import { translate, makeT, DEFAULT_LANG, LANGS, isLang, type Lang, type TKey } from '../index';
import { botT, normalizeLang, DEFAULT_LANG as BOT_DEFAULT_LANG } from '../../../supabase/functions/_shared/i18n';

const KEYS = Object.keys(en) as TKey[];
const DICTS: Record<Lang, Record<string, string>> = { en, am, om, ti };

/*
 * `plural` is an English-only grammatical helper ('s' | '') that the caller
 * appends to a noun; Amharic and Afaan Oromoo do not inflect the noun for
 * number, so those translations legitimately omit it. Every *data* placeholder
 * ({name}, {amount}, {n}, …) must still be identical across all languages.
 */
const GRAMMAR_ONLY = new Set(['plural']);

const placeholders = (s: string): string[] =>
  [...s.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .filter((p) => !GRAMMAR_ONLY.has(p))
    .sort();

describe('key coverage', () => {
  it('am, om and ti define exactly the same keys as en', () => {
    const enKeys = new Set(KEYS);
    for (const [name, dict] of Object.entries({ am, om, ti })) {
      const dictKeys = new Set(Object.keys(dict));
      expect([...enKeys].filter((k) => !dictKeys.has(k)), `${name} missing keys`).toEqual([]);
      expect([...dictKeys].filter((k) => !enKeys.has(k as TKey)), `${name} extra keys`).toEqual([]);
    }
  });

  it('no language has an empty string for any key', () => {
    for (const lang of LANGS) {
      for (const k of KEYS) {
        expect(DICTS[lang][k]?.trim().length, `${lang}:${k}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('placeholder parity', () => {
  it('every key uses the same {placeholders} in all languages', () => {
    for (const k of KEYS) {
      const ref = placeholders(en[k]);
      expect(placeholders(am[k]), `am mismatch for ${k}`).toEqual(ref);
      expect(placeholders(om[k]), `om mismatch for ${k}`).toEqual(ref);
      expect(placeholders(ti[k]), `ti mismatch for ${k}`).toEqual(ref);
    }
  });
});

describe('default language', () => {
  it('is Amharic on both the app and the bot', () => {
    expect(DEFAULT_LANG).toBe('am');
    expect(BOT_DEFAULT_LANG).toBe('am');
  });
});

describe('isLang / normalizeLang', () => {
  it('accepts only the three supported codes', () => {
    expect(isLang('en')).toBe(true);
    expect(isLang('am')).toBe(true);
    expect(isLang('om')).toBe(true);
    expect(isLang('ti')).toBe(true);
    expect(isLang('fr')).toBe(false);
    expect(isLang(undefined)).toBe(false);
    expect(isLang(null)).toBe(false);
  });

  it('normalizeLang falls back to am for anything unknown', () => {
    expect(normalizeLang('en')).toBe('en');
    expect(normalizeLang('om')).toBe('om');
    expect(normalizeLang('ti')).toBe('ti');
    expect(normalizeLang('xx')).toBe('am');
    expect(normalizeLang(undefined)).toBe('am');
    expect(normalizeLang(null)).toBe('am');
  });
});

describe('translate() fallback chain', () => {
  it('returns the requested language when present', () => {
    expect(translate('en', 'nav.home')).toBe('Home');
    expect(translate('am', 'nav.home')).toBe(am['nav.home']);
    expect(translate('om', 'nav.home')).toBe(om['nav.home']);
    expect(translate('ti', 'nav.home')).toBe(ti['nav.home']);
  });

  it('falls back requested -> am -> en -> key and never throws', () => {
    const missing = 'this.key.does.not.exist' as TKey;
    // no dictionary has it -> returns the key itself, no throw
    expect(() => translate('om', missing)).not.toThrow();
    expect(translate('om', missing)).toBe(missing);
    expect(translate('en', missing)).toBe(missing);
  });

  it('interpolates {name} / {amount} and leaves unknown placeholders intact', () => {
    expect(translate('en', 'home.greeting', { name: 'Sara' })).toBe('Hi, Sara');
    expect(translate('en', 'home.winnings', { amount: '120 ETB' })).toBe('Winnings: 120 ETB');
    // a key whose placeholder we didn't supply stays literal rather than crashing
    expect(translate('en', 'home.greeting')).toBe('Hi, {name}');
  });

  it('auto-injects {app} as the brand name', () => {
    expect(translate('en', 'session.loading')).toContain('የኛ bingo');
    expect(translate('am', 'session.loading')).toContain('የኛ bingo');
  });

  it('makeT binds a language', () => {
    const t = makeT('om');
    expect(t('nav.wallet')).toBe(om['nav.wallet']);
  });
});

describe('bot dictionary sync', () => {
  const botKeys = KEYS.filter((k) => k.startsWith('bot.')).map((k) => k.slice('bot.'.length));

  it('there is at least one bot.* key', () => {
    expect(botKeys.length).toBeGreaterThan(0);
  });

  it('every bot.* key resolves in the bot dictionary for all three languages', () => {
    for (const bk of botKeys) {
      for (const lang of LANGS) {
        const out = botT(lang, bk);
        // botT returns the key verbatim only when it resolved nowhere
        expect(out, `${lang}:${bk} not in bot dict`).not.toBe(bk);
      }
    }
  });

  it('bot English strings match the app dictionary (single source of truth)', () => {
    for (const bk of botKeys) {
      // botT resolves {app} inline; normalize the app-dict value the same way
      const appValue = en[`bot.${bk}` as TKey].replace(/\{app\}/g, 'የኛ bingo');
      expect(botT('en', bk), `bot en drift for ${bk}`).toBe(appValue);
    }
  });

  it('bot placeholder parity across languages', () => {
    for (const bk of botKeys) {
      const ref = placeholders(botT('en', bk));
      expect(placeholders(botT('am', bk)), `bot am mismatch for ${bk}`).toEqual(ref);
      expect(placeholders(botT('om', bk)), `bot om mismatch for ${bk}`).toEqual(ref);
      expect(placeholders(botT('ti', bk)), `bot ti mismatch for ${bk}`).toEqual(ref);
    }
  });
});

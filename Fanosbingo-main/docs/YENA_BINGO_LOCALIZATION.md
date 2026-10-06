# የኛ bingo — Localization (i18n)

The player-facing surface of የኛ bingo (Telegram Mini App **and** bot) is
fully localized. Everything a player reads goes through one dictionary set; the
database, logs, enums, IDs and money math are never translated.

## Supported languages

| Code | Name (native)    | Notes                        |
|------|------------------|------------------------------|
| `en` | English          |                              |
| `am` | አማርኛ (Amharic)   | **Default** for every user   |
| `om` | Afaan Oromoo     | Latin script                 |
| `ti` | ትግርኛ (Tigrinya)  | Geʼez script                 |

`am` is the default for **new and existing users**. The DB column
`telegram_users.language_code` is `NOT NULL DEFAULT 'am'`, so the migration
backfills every existing row to Amharic. Only these four codes are valid
(`CHECK` constraint).

> The Amharic, Afaan Oromoo and Tigrinya strings were drafted for this
> migration and carry a `TODO(review)` header comment. Have a native speaker
> review `src/i18n/am.ts`, `src/i18n/om.ts` and `src/i18n/ti.ts` before
> production.

## How a player changes language

Mini App → **Profile → Settings → Language** → pick one of the four.

1. `SettingsScreen` calls `session.setLang(code)`.
2. The UI switches **immediately** (optimistic — `LangProvider` re-renders).
3. `POST /functions/v1/set-language` (`X-Player-Token`) → `eds_set_language(p_user, p_lang)`
   writes `telegram_users.language_code`.
4. On failure the UI rolls back to the previous language and shows
   `settings.langError`.

The choice is durable: it survives logout, app restart and device change,
because it lives in the database, not in `localStorage`. On next session start
`player-session` → `eds_ensure_player` returns `user.language_code` and the app
boots in that language. The bot reads the same column on every command.

## Architecture

```
src/i18n/
  en.ts            SOURCE OF TRUTH. `export const en = {…} as const`
                   `export type TKey = keyof typeof en`
  am.ts            `const am: Record<TKey, string>`  ← compiler forces completeness
  om.ts            `const om: Record<TKey, string>`
  ti.ts            `const ti: Record<TKey, string>`
  index.ts         translate(lang, key, vars) · makeT(lang) · DEFAULT_LANG · LANGS · isLang
  LangProvider.tsx <LangProvider lang> + useT() + useLang()
  __tests__/i18n.test.ts

supabase/functions/_shared/i18n.ts
                   Bot-side mirror. botT(lang, key, vars) · playerLang(supabase, id)
                   · normalizeLang(x). Holds only the `bot.*` subset; kept in sync
                   with the `bot.*` keys in en.ts (enforced by the test).
```

### Fallback chain (never throws)

```
requested language  →  am (default)  →  en  →  the key string itself
```

`translate('om', 'x')` where `x` is missing everywhere returns `'x'` — no crash,
no blank screen.

### Placeholders

`{name}`, `{amount}`, `{n}`, `{cost}`, … are interpolated by a regex. An unknown
placeholder is left literal (`{foo}`) rather than throwing. **Placeholder names
are identical across all languages** for every key (test-enforced). `{app}`
is injected automatically as the brand name — translations must not hard-code
"የኛ bingo" where `{app}` will do.

`{plural}` is the one exception: an English-only grammatical helper (`'s'` / `''`).
Amharic, Afaan Oromoo and Tigrinya do not inflect the noun for number, so those
translations legitimately omit it. The parity test ignores `{plural}` and checks
every other (data) placeholder.

### What is NOT translated — by design

- DB enum / status values: `GAME_ENTRY`, `WINNING_CREDIT`, `pending`, `approved`,
  `paid`, … The **stored value** stays English; only its **display label** is
  localized (`tx.*`, `status.*` keys). `StatusPill` translates the label,
  `l.entry_type` stays raw.
- Internal identifiers, `callback_data`, `error_code` (`BAD_LANG`, `CARTELA_TAKEN`,
  …) — business logic keys off these, never off translated text.
- `console.*`, `RAISE NOTICE`, audit-log messages — developer text, English only.
- Money, ETB amounts, Telebirr account numbers / references.

## Adding or changing a string

1. Add the key + English text to **`src/i18n/en.ts`**.
2. `tsc` now fails until you add the same key to `am.ts`, `om.ts` and `ti.ts`.
3. If it is a **bot** string (`bot.*`), also add it to the four dicts in
   `supabase/functions/_shared/i18n.ts` (same key **without** the `bot.` prefix).
   `npm test` fails if the two drift.
4. Use it: `const t = useT(); t('my.key', { name })` in a component, or
   `botT(lang, 'myKey', { name })` in an edge function
   (`lang = normalizeLang(existingUser.language_code)` or
   `await playerLang(supabase, telegramUserId)`).
5. Keep `{placeholders}` identical in every language.

## Adding another language

(Tigrinya `ti` was added this way — see migration
`20260907090000_yena_bingo_add_tigrinya.sql` for the DB step.)

1. `src/i18n/xx.ts` → `const xx: Record<TKey, string> = { … }`.
2. `src/i18n/index.ts`: add `'xx'` to `Lang`, `LANGS`, `DICTS`, `isLang`, and the
   re-export at the bottom.
3. `supabase/functions/_shared/i18n.ts`: add `'xx'` to `Lang`, `normalizeLang`,
   a `xx` `Dict`, `CMD_DESCRIPTIONS`, `BOT_COMMAND_LANGS`, and `DICTS`.
4. Add `lang.xx` (native name) to all dictionaries.
5. DB: new migration extending the `telegram_users_language_code_check`
   constraint and `eds_set_language`, plus the `set-language` edge-function
   validation.
6. Update the parity checks in `src/i18n/__tests__/i18n.test.ts`.

No new environment variables are needed for languages, now or later.

## Tests

`src/i18n/__tests__/i18n.test.ts` (run with `npm test`):

- every `TKey` present in `en` / `am` / `om` / `ti`, none extra, none empty
- placeholder parity across languages (data placeholders; `{plural}` exempt)
- `DEFAULT_LANG === 'am'` on both app and bot
- `isLang` / `normalizeLang` accept only `en` / `am` / `om` / `ti`, fall back to `am`
- `translate()` fallback chain requested → am → en → key, never throws
- `{name}` / `{amount}` interpolation, `{app}` auto-injection, `makeT`
- every `bot.*` key resolves in the bot dictionary for all languages
- bot English strings match the app dictionary (single source of truth)

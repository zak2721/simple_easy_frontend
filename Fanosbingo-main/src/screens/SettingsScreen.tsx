import { useEffect, useState } from 'react';
import { Check, Globe, Palette } from 'lucide-react';
import { useSession } from '../lib/session';
import { useT } from '../i18n/LangProvider';
import { LANGS, Lang } from '../i18n';
import { Screen, Card } from '../components/common/Screen';
import { api } from '../lib/api';
import type { Theme } from '../lib/types';

type Section = 'none' | 'language' | 'theme';

export function SettingsScreen({ onDone }: { onDone: () => void }) {
  const { lang, setLang, theme, selectedThemeId, setTheme } = useSession();
  const t = useT();
  const [section, setSection] = useState<Section>('none');
  const [msg, setMsg] = useState<string | null>(null);
  const [busyLang, setBusyLang] = useState<Lang | null>(null);
  const [themes, setThemes] = useState<Theme[]>([]);
  const [busyThemeId, setBusyThemeId] = useState<string | 'default' | null>(null);

  useEffect(() => {
    api.themes().then(setThemes).catch(() => {});
  }, []);

  const pickLang = async (code: Lang) => {
    if (code === lang) { setSection('none'); return; }
    setBusyLang(code);
    setMsg(null);
    const ok = await setLang(code); // instant UI switch + persist
    setBusyLang(null);
    setSection('none');
    setMsg(ok ? t('settings.langSaved') : t('settings.langError'));
  };

  const pickTheme = async (id: string | null) => {
    if (id === selectedThemeId) { setSection('none'); return; }
    setBusyThemeId(id ?? 'default');
    setMsg(null);
    const resolved = id ? themes.find((th) => th.id === id) ?? null : themes.find((th) => th.isDefault) ?? null;
    const ok = await setTheme(id, resolved);
    setBusyThemeId(null);
    setSection('none');
    setMsg(ok ? t('settings.themeSaved') : t('settings.themeError'));
  };

  return (
    <Screen title={t('settings.title')} onBack={onDone}>
      {section === 'none' && (
        <>
          <button onClick={() => setSection('language')} className="eds-card mb-2 flex w-full items-center gap-3 p-4 text-left">
            <Globe className="h-5 w-5 text-[var(--eds-muted)]" />
            <div className="flex-1">
              <p className="text-sm font-bold">{t('settings.language')}</p>
              <p className="text-xs text-[var(--eds-muted)]">{t(`lang.${lang}`)}</p>
            </div>
          </button>
          <button onClick={() => setSection('theme')} className="eds-card flex w-full items-center gap-3 p-4 text-left">
            <Palette className="h-5 w-5 text-[var(--eds-muted)]" />
            <div className="flex-1">
              <p className="text-sm font-bold">{t('settings.theme')}</p>
              <p className="text-xs text-[var(--eds-muted)]">{theme?.name ?? t('settings.themeDefault')}</p>
            </div>
          </button>
          {msg && <p className="mt-3 text-center text-sm text-emerald-300">{msg}</p>}
        </>
      )}

      {section === 'language' && (
        <Card>
          <p className="text-sm font-bold">{t('settings.language')}</p>
          <p className="mb-3 text-xs text-[var(--eds-muted)]">{t('settings.languageDesc')}</p>
          <div className="space-y-2">
            {LANGS.map((code) => (
              <button
                key={code}
                onClick={() => pickLang(code)}
                disabled={busyLang !== null}
                className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-sm font-medium ${
                  code === lang ? 'border-emerald-500 bg-emerald-600/15 text-emerald-300' : 'border-white/10 bg-[var(--eds-surface-2)]'
                }`}
              >
                {/* native language names stay in their own script */}
                <span>{t(`lang.${code}`)}</span>
                {busyLang === code ? <span className="text-xs">…</span> : code === lang ? <Check className="h-4 w-4" /> : null}
              </button>
            ))}
          </div>
          <button onClick={() => setSection('none')} className="mt-3 w-full rounded-lg bg-white/5 py-2 text-xs text-[var(--eds-muted)]">
            {t('common.back')}
          </button>
        </Card>
      )}

      {section === 'theme' && (
        <Card>
          <p className="text-sm font-bold">{t('settings.theme')}</p>
          <p className="mb-3 text-xs text-[var(--eds-muted)]">{t('settings.themeDesc')}</p>
          <div className="space-y-2">
            <button
              onClick={() => pickTheme(null)}
              disabled={busyThemeId !== null}
              className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-sm font-medium ${
                selectedThemeId === null ? 'border-emerald-500 bg-emerald-600/15 text-emerald-300' : 'border-white/10 bg-[var(--eds-surface-2)]'
              }`}
            >
              <span>{t('settings.themeDefault')}</span>
              {busyThemeId === 'default' ? <span className="text-xs">…</span> : selectedThemeId === null ? <Check className="h-4 w-4" /> : null}
            </button>
            {themes.map((th) => (
              <button
                key={th.id}
                onClick={() => pickTheme(th.id)}
                disabled={busyThemeId !== null}
                className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-sm font-medium ${
                  selectedThemeId === th.id ? 'border-emerald-500 bg-emerald-600/15 text-emerald-300' : 'border-white/10 bg-[var(--eds-surface-2)]'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 rounded-full border border-white/20" style={{ background: th.primaryColor }} />
                  {th.name}
                </span>
                {busyThemeId === th.id ? <span className="text-xs">…</span> : selectedThemeId === th.id ? <Check className="h-4 w-4" /> : null}
              </button>
            ))}
          </div>
          <button onClick={() => setSection('none')} className="mt-3 w-full rounded-lg bg-white/5 py-2 text-xs text-[var(--eds-muted)]">
            {t('common.back')}
          </button>
        </Card>
      )}
    </Screen>
  );
}

import { useEffect, useState } from 'react';
import { useT } from '../i18n/LangProvider';
import { api } from '../lib/api';
import { Screen, Card } from '../components/common/Screen';

interface GameRule {
  id: string;
  title: string;
  body: string;
  category: string | null;
}

export function RulesScreen({ onBack }: { onBack: () => void }) {
  const t = useT();
  const [rules, setRules] = useState<GameRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.gameRules().then(setRules).catch(() => setError(t('rules.err.generic')));
  }, [t]);

  const groups = new Map<string, GameRule[]>();
  for (const rule of rules ?? []) {
    const key = rule.category || t('rules.general');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(rule);
  }

  return (
    <Screen title={t('rules.title')} onBack={onBack}>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {rules === null && !error && <p className="text-sm text-[var(--eds-muted)]">{t('common.loading')}</p>}
      {rules?.length === 0 && <p className="text-sm text-[var(--eds-muted)]">{t('rules.empty')}</p>}

      {[...groups.entries()].map(([category, categoryRules]) => (
        <div key={category} className="mb-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-[var(--eds-muted)]">{category}</p>
          <div className="space-y-2">
            {categoryRules.map((rule) => (
              <Card key={rule.id} className="space-y-1 text-sm">
                <p className="font-bold">{rule.title}</p>
                <p className="whitespace-pre-line text-[var(--eds-muted)]">{rule.body}</p>
              </Card>
            ))}
          </div>
        </div>
      ))}
    </Screen>
  );
}

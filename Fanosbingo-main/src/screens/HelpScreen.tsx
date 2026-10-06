import { useT } from '../i18n/LangProvider';
import { Screen, Card } from '../components/common/Screen';

export function HelpScreen() {
  const t = useT();
  return (
    <Screen title={t('help.title')}>
      <Card className="mb-3 space-y-2 text-sm">
        <p className="font-bold">{t('help.howTitle')}</p>
        <p className="text-[var(--eds-muted)]">{t('help.howBody')}</p>
      </Card>

      <Card className="mb-3 space-y-2 text-sm">
        <p className="font-bold">{t('help.roomsTitle')}</p>
        <ul className="list-disc space-y-1 pl-4 text-[var(--eds-muted)]">
          <li>{t('help.roomsB1')}</li>
          <li>{t('help.roomsB2')}</li>
          <li>{t('help.roomsB3')}</li>
          <li>{t('help.roomsB4')}</li>
        </ul>
      </Card>

      <Card className="mb-3 space-y-2 text-sm">
        <p className="font-bold">{t('help.prizesTitle')}</p>
        <p className="text-[var(--eds-muted)]">{t('help.prizesBody')}</p>
      </Card>

      <Card className="mb-3 space-y-2 text-sm">
        <p className="font-bold">{t('help.paymentsTitle')}</p>
        <p className="text-[var(--eds-muted)]">{t('help.paymentsBody')}</p>
      </Card>

      <Card className="text-sm">
        <p className="font-bold">{t('help.supportTitle')}</p>
        <p className="text-[var(--eds-muted)]">{t('help.supportBody')}</p>
      </Card>
    </Screen>
  );
}

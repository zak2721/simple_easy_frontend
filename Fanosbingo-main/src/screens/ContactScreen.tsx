import { useEffect, useState } from 'react';
import { Phone, MessageCircle, Mail, Clock, Send } from 'lucide-react';
import { useT } from '../i18n/LangProvider';
import { useSession } from '../lib/session';
import { api } from '../lib/api';
import { Screen, Card } from '../components/common/Screen';

export function ContactScreen({ onBack }: { onBack: () => void }) {
  const t = useT();
  const session = useSession();
  const [contact, setContact] = useState(session.contact);

  useEffect(() => {
    api.contact().then(setContact).catch(() => {});
  }, []);

  if (!contact?.configured) {
    return (
      <Screen title={t('support.title')} onBack={onBack}>
        <Card className="text-sm text-[var(--eds-muted)]">{t('support.notConfigured')}</Card>
      </Screen>
    );
  }

  return (
    <Screen title={t('support.title')} onBack={onBack}>
      <Card className="space-y-3 text-sm">
        {contact.telegram && (
          <a href={`https://t.me/${contact.telegram.replace(/^@/, '')}`} target="_blank" rel="noreferrer" className="flex items-center gap-3">
            <Send className="h-4 w-4 text-[var(--eds-muted)]" /> {contact.telegram}
          </a>
        )}
        {contact.phone && (
          <a href={`tel:${contact.phone}`} className="flex items-center gap-3">
            <Phone className="h-4 w-4 text-[var(--eds-muted)]" /> {contact.phone}
          </a>
        )}
        {contact.whatsapp && (
          <a href={`https://wa.me/${contact.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noreferrer" className="flex items-center gap-3">
            <MessageCircle className="h-4 w-4 text-[var(--eds-muted)]" /> {contact.whatsapp}
          </a>
        )}
        {contact.email && (
          <a href={`mailto:${contact.email}`} className="flex items-center gap-3">
            <Mail className="h-4 w-4 text-[var(--eds-muted)]" /> {contact.email}
          </a>
        )}
        {contact.support_hours && (
          <div className="flex items-center gap-3">
            <Clock className="h-4 w-4 text-[var(--eds-muted)]" /> {contact.support_hours}
          </div>
        )}
      </Card>
    </Screen>
  );
}

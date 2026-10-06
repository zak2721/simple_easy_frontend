import { useState } from 'react';
import { adminApi } from '../adminApi';

const FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: 'GAME_URL', label: 'Mini App URL', hint: 'https://your-domain — the bot Play button' },
  { key: 'TELEBIRR_ACCOUNT_NAME', label: 'Telebirr account name' },
  { key: 'TELEBIRR_ACCOUNT_NUMBER', label: 'Telebirr account / phone number' },
  { key: 'TELEBIRR_INSTRUCTIONS', label: 'Telebirr instructions (shown to players)' },
];

export function AdminSettings({ role }: { role: string }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, string>>({});

  if (role !== 'SUPER_ADMIN') {
    return <p className="text-slate-500">Only the owner can change settings.</p>;
  }

  const save = async (key: string) => {
    setStatus((s) => ({ ...s, [key]: 'saving…' }));
    try {
      await adminApi.updateSetting(key, values[key] ?? '');
      setStatus((s) => ({ ...s, [key]: 'saved ✓' }));
    } catch (e) {
      setStatus((s) => ({ ...s, [key]: e instanceof Error ? e.message : 'failed' }));
    }
  };

  return (
    <div className="max-w-xl">
      <h1 className="mb-1 text-xl font-bold">Settings</h1>
      <p className="mb-4 text-sm text-slate-500">
        Room prices/capacities, the 80/20 split, and cartela limits are set via
        environment configuration and protected by backend validation. This
        panel covers operational config only.
      </p>
      <p className="mb-4 text-xs text-slate-400">
        The Telegram bot token/username are configured via backend environment
        variables (TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME) — set those
        first, then register the webhook below.
      </p>

      <div className="space-y-4">
        {FIELDS.map((f) => (
          <div key={f.key} className="rounded-xl border border-slate-200 bg-white p-4">
            <label className="block text-sm font-medium text-slate-700">{f.label}</label>
            {f.hint && <p className="text-xs text-slate-400">{f.hint}</p>}
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <button onClick={() => save(f.key)} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white">
                Save
              </button>
            </div>
            {status[f.key] && <p className="mt-1 text-xs text-slate-500">{status[f.key]}</p>}
          </div>
        ))}
      </div>

      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-bold">Telegram webhook</h2>
        <p className="mt-1 text-xs text-slate-500">
          Register this backend's public URL with Telegram so the bot forwards messages to it.
        </p>
        <WebhookButton />
      </div>
    </div>
  );
}

function WebhookButton() {
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const run = async () => {
    setMsg('working…');
    try {
      const res = await adminApi.setupTelegramWebhook(url);
      setMsg(res.ok ? `OK — webhook: ${res.webhookUrl}` : res.description || 'failed');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'failed');
    }
  };
  return (
    <div className="mt-2 flex gap-2">
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://your-backend-domain/api"
        className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      <button onClick={run} className="rounded-lg bg-slate-700 px-3 py-2 text-sm font-semibold text-white">Register</button>
      {msg && <span className="self-center text-xs text-slate-500">{msg}</span>}
    </div>
  );
}

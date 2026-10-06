import { useCallback, useEffect, useState } from 'react';
import { adminApi, BotInfo } from '../adminApi';

/** Operator-owned Telegram bot + Mini App connection (each operator runs its own — see architecture doc D2). */
export function OperatorBot() {
  const [info, setInfo] = useState<BotInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [botToken, setBotToken] = useState('');
  const [publicApiUrl, setPublicApiUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi.getMyBot().then(setInfo).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    setErr(null);
    setResult(null);
    setBusy(true);
    try {
      const r = await adminApi.configureMyBot({ botToken: botToken.trim(), publicApiUrl: publicApiUrl.trim() || undefined });
      setResult(r.webhook.ok ? `Connected @${r.botUsername}. Webhook registered.` : `Connected @${r.botUsername}, but webhook registration failed: ${r.webhook.description ?? 'unknown error'}`);
      setBotToken('');
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">Telegram Bot</h1>
      <p className="mb-4 text-sm text-slate-500">Connect your own @BotFather bot. Players reach your bingo room through this bot and its Mini App — it is yours to manage.</p>

      {err && <p className="mb-3 text-sm text-red-500">{err}</p>}
      {result && <p className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{result}</p>}

      {info && (
        <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
          <p><span className="text-slate-500">Status:</span> {info.configured ? <span className="font-semibold text-emerald-600">Connected {info.botUsername ? `(@${info.botUsername})` : ''}</span> : <span className="font-semibold text-amber-600">Not connected</span>}</p>
          <p className="mt-1"><span className="text-slate-500">Mini App URL:</span> <code className="text-xs">{info.miniAppUrl}</code></p>
        </div>
      )}

      <div className="max-w-md space-y-3 rounded-xl border border-slate-200 bg-white p-4">
        <div>
          <label className="block text-sm font-medium text-slate-700">Bot token (from @BotFather)</label>
          <input
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            placeholder="123456789:AAAA...-your-bot-token"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700">Public API URL (optional)</label>
          <input
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            placeholder="https://yourdomain.com/api"
            value={publicApiUrl}
            onChange={(e) => setPublicApiUrl(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-400">Leave blank to use the platform's default app URL.</p>
        </div>
        <button onClick={submit} disabled={busy || !botToken.trim()} className="w-full rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? 'Connecting…' : info?.configured ? 'Reconnect bot' : 'Connect bot'}
        </button>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { adminApi, AdminMe } from '../adminApi';

/** Self-service two-factor auth enrollment/disable, and Telegram push-alert opt-in, for the signed-in admin's own account. */
export function AdminSecurity({ me, onChanged }: { me: AdminMe; onChanged: () => void }) {
  const [enrolling, setEnrolling] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [chatId, setChatId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [regenPassword, setRegenPassword] = useState('');

  const saveChatId = async () => {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      await adminApi.setTelegramAlertChat(chatId.trim() || null);
      setChatId('');
      setMessage(chatId.trim() ? 'Telegram alerts enabled.' : 'Telegram alerts turned off.');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const startEnroll = async () => {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const r = await adminApi.setupTwoFactor();
      setSecret(r.secret);
      setOtpauthUrl(r.otpauthUrl);
      setEnrolling(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const confirmEnroll = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await adminApi.confirmTwoFactor(code);
      setEnrolling(false);
      setSecret(null);
      setOtpauthUrl(null);
      setCode('');
      setRecoveryCodes(r.recoveryCodes);
      setMessage('Two-factor authentication is now enabled.');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!window.confirm('Turn off two-factor authentication for your account? Your recovery codes will also be cleared.')) return;
    setError(null);
    setBusy(true);
    try {
      await adminApi.disableTwoFactor(password);
      setPassword('');
      setRecoveryCodes(null);
      setMessage('Two-factor authentication is now off.');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const regenerateRecoveryCodes = async () => {
    if (!window.confirm('Generate new recovery codes? Any codes you saved before this will stop working.')) return;
    setError(null);
    setBusy(true);
    try {
      const r = await adminApi.regenerateRecoveryCodes(regenPassword);
      setRegenPassword('');
      setRecoveryCodes(r.recoveryCodes);
      setMessage('New recovery codes generated — save them now, they won’t be shown again.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-lg">
      <h1 className="mb-1 text-xl font-bold">Account Security</h1>
      <p className="mb-4 text-sm text-slate-500">Signed in as <span className="font-medium">{me.username}</span>.</p>

      {error && <p className="mb-3 text-sm text-red-500">{error}</p>}
      {message && <p className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{message}</p>}

      {recoveryCodes && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p className="font-bold text-amber-900">Save your recovery codes now</p>
          <p className="mb-3 text-sm text-amber-800">
            Each code works once, if you ever lose access to your authenticator app. This is the only time they're shown — store them somewhere safe (a password manager, not a screenshot on the same device as your authenticator).
          </p>
          <div className="mb-3 grid grid-cols-2 gap-2 rounded-lg bg-white p-3 font-mono text-sm">
            {recoveryCodes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => navigator.clipboard?.writeText(recoveryCodes.join('\n'))}
              className="rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800"
            >
              Copy all
            </button>
            <button onClick={() => setRecoveryCodes(null)} className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white">
              I've saved these
            </button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="font-bold">Two-factor authentication</p>
            <p className="text-sm text-slate-500">
              {me.totpEnabled ? 'Enabled — a 6-digit code from your authenticator app is required at every sign-in.' : 'Not enabled. Add an authenticator app (Google Authenticator, Authy, 1Password, ...) for a second sign-in factor.'}
            </p>
          </div>
        </div>

        {!me.totpEnabled && !enrolling && (
          <button onClick={startEnroll} disabled={busy} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {busy ? 'Starting…' : 'Enable two-factor authentication'}
          </button>
        )}

        {enrolling && secret && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">Scan this into your authenticator app, or enter the secret manually, then confirm with the 6-digit code it shows.</p>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Secret (manual entry)</p>
              <p className="break-all font-mono text-sm">{secret}</p>
            </div>
            {otpauthUrl && <p className="break-all text-xs text-slate-400">{otpauthUrl}</p>}
            <div className="flex gap-2">
              <input
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                placeholder="6-digit code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
              <button onClick={confirmEnroll} disabled={busy || code.length !== 6} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {busy ? 'Confirming…' : 'Confirm'}
              </button>
            </div>
            <button onClick={() => { setEnrolling(false); setSecret(null); setOtpauthUrl(null); setCode(''); }} className="text-xs text-slate-400">
              Cancel
            </button>
          </div>
        )}

        {me.totpEnabled && (
          <div className="space-y-4">
            <div className="space-y-2 border-t border-slate-100 pt-3">
              <p className="text-sm text-slate-600">Lost your recovery codes, or used most of them? Generate a new set — the old ones stop working immediately.</p>
              <label className="block text-sm font-medium text-slate-700">Confirm your password to regenerate</label>
              <div className="flex gap-2">
                <input
                  type="password"
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  value={regenPassword}
                  onChange={(e) => setRegenPassword(e.target.value)}
                />
                <button onClick={regenerateRecoveryCodes} disabled={busy || !regenPassword} className="rounded-lg bg-slate-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
                  {busy ? '…' : 'Regenerate codes'}
                </button>
              </div>
            </div>

            <div className="space-y-2 border-t border-slate-100 pt-3">
              <label className="block text-sm font-medium text-slate-700">Confirm your password to turn it off</label>
              <input type="password" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={password} onChange={(e) => setPassword(e.target.value)} />
              <button onClick={disable} disabled={busy || !password} className="rounded-lg bg-red-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {busy ? 'Disabling…' : 'Disable two-factor authentication'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <p className="font-bold">Telegram push alerts</p>
        <p className="mb-3 text-sm text-slate-500">
          {me.telegramAlertChatId
            ? 'Enabled — warning and critical notifications (lockouts, suspicious activity, impersonation, ...) are pushed here too, on top of the in-app feed.'
            : 'Off — you only see notifications in the in-app feed. Message a chat-id bot (e.g. @userinfobot) to get your numeric chat id, then paste it below.'}
        </p>
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            placeholder={me.telegramAlertChatId ? `Current: ${me.telegramAlertChatId}` : 'Your Telegram chat id'}
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
          />
          <button onClick={saveChatId} disabled={busy} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {busy ? '…' : 'Save'}
          </button>
        </div>
        {me.telegramAlertChatId && (
          <button
            onClick={() => { setChatId(''); adminApi.setTelegramAlertChat(null).then(() => { setMessage('Telegram alerts turned off.'); onChanged(); }); }}
            className="mt-2 text-xs text-slate-400"
          >
            Turn off
          </button>
        )}
      </div>
    </div>
  );
}

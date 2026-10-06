/*
  Telegram Mini App initData verification + short-lived player tokens.

  Telegram signs `initData` with a key derived from the bot token. We verify that
  HMAC server-side (the frontend must never be trusted for identity), then issue
  an `eds` player token (HMAC of user id + expiry, keyed by the service role key)
  that the financial player endpoints check on every call.
*/

const enc = new TextEncoder();

async function hmacSha256(keyData: ArrayBuffer | Uint8Array, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyData as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return new Uint8Array(sig);
}

function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export interface TgUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

/** Returns the verified user, or null if the signature / freshness check fails. */
export async function verifyInitData(initData: string, botToken: string, maxAgeSec = 86400): Promise<TgUser | null> {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secret = await hmacSha256(enc.encode('WebAppData'), botToken);
  const expected = toHex(await hmacSha256(secret, dataCheckString));
  if (expected !== hash) return null;

  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;

  try {
    const user = JSON.parse(params.get('user') ?? 'null');
    if (!user?.id) return null;
    return user as TgUser;
  } catch {
    return null;
  }
}

const TOKEN_TTL_SEC = 60 * 60 * 12;

export async function makePlayerToken(userId: number): Promise<string> {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
  const payload = `${userId}.${exp}`;
  const sig = toHex(await hmacSha256(enc.encode(key), payload)).slice(0, 32);
  return `${payload}.${sig}`;
}

export async function verifyPlayerToken(token: string | null): Promise<number | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  if (Number(exp) < Date.now() / 1000) return null;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const expected = toHex(await hmacSha256(enc.encode(key), `${uid}.${exp}`)).slice(0, 32);
  if (expected !== sig) return null;
  return Number(uid);
}

/**
 * Resolve the player id for a request. Prefers a verified `X-Player-Token`.
 * Falls back to the raw `telegramUserId` in the body ONLY when
 * ALLOW_UNVERIFIED_TELEGRAM=true (local/dev).
 */
export async function resolvePlayer(req: Request, body: Record<string, unknown>): Promise<number | null> {
  const token = req.headers.get('X-Player-Token') ?? (typeof body.playerToken === 'string' ? body.playerToken : null);
  const verified = await verifyPlayerToken(token);
  if (verified) return verified;
  if (Deno.env.get('ALLOW_UNVERIFIED_TELEGRAM') === 'true') {
    const raw = Number(body.telegramUserId);
    return raw > 0 ? raw : null;
  }
  return null;
}

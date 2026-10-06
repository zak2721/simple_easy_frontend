import * as crypto from 'crypto';

/**
 * TOTP (RFC 6238) over HOTP (RFC 4226), implemented directly against Node's
 * built-in `crypto` rather than adding a dependency — the same approach this
 * codebase already takes for password hashing and secret encryption.
 * SHA-1/30s-step/6-digit is the universal default every authenticator app
 * (Google Authenticator, Authy, 1Password, ...) assumes when no other
 * algorithm is specified in the otpauth:// URI.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
/** How many 30s steps of clock drift either side to still accept — ±1 = a 90s acceptance window. */
const WINDOW_STEPS = 1;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 160-bit secret — the size every TOTP guide recommends for SHA-1. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBase32: string, counter: number): string {
  const key = base32Decode(secretBase32);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  const code = binary % 10 ** DIGITS;
  return code.toString().padStart(DIGITS, '0');
}

function counterFor(atMs: number): number {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

export function totp(secretBase32: string, atMs: number = Date.now()): string {
  return hotp(secretBase32, counterFor(atMs));
}

function timingSafeCodeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Checks a code against a small window of steps either side of now (clock
 * drift tolerance), returning the counter that matched so the caller can
 * reject that same counter again (replay protection — a code observed once,
 * e.g. by someone shoulder-surfing, cannot be reused for the rest of its
 * 30s validity window). `sinceCounter` rejects any match at or before it.
 */
export function verifyTotp(secretBase32: string, code: string, atMs: number = Date.now(), sinceCounter?: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const center = counterFor(atMs);
  for (let delta = -WINDOW_STEPS; delta <= WINDOW_STEPS; delta++) {
    const counter = center + delta;
    if (sinceCounter != null && counter <= sinceCounter) continue;
    if (timingSafeCodeEquals(hotp(secretBase32, counter), code)) return counter;
  }
  return null;
}

export function totpAuthUrl(secretBase32: string, accountLabel: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

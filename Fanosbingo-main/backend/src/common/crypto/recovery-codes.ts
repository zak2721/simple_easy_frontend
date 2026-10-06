import * as crypto from 'crypto';

const RECOVERY_CODE_COUNT = 10;
// Excludes visually ambiguous characters (0/O, 1/I) — these are read off a
// screen and typed by hand during an account-recovery moment, when mistakes
// are most costly.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(): string {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
    if (i === 3) out += '-';
  }
  return out; // e.g. "7F3K-9QXZ"
}

/** A fresh batch of high-entropy, one-time 2FA recovery codes (plaintext — caller displays them once, then only ever stores the hash). */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(randomCode());
  return [...codes];
}

/**
 * Case/whitespace-insensitive, and dash-insensitive: codes are generated and
 * displayed as "XXXX-XXXX", but the dash is a display aid, not part of the
 * value being hashed — a user who types the code without it (or a client
 * that strips it) must still match. Both generation (issueRecoveryCodes) and
 * login (completeAdminRecoveryLogin) normalize through this same function,
 * so the stored hash and the lookup hash are always computed the same way.
 */
export function normalizeRecoveryCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

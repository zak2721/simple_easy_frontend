import * as crypto from 'crypto';

/** Crockford-style alphabet — excludes 0/O/1/I to avoid visual ambiguity when a code is read aloud or typed. */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;

/** A short shareable referral code, e.g. "7XPQR9". Not guaranteed globally unique on its own — see generateUniqueCode. */
export function generateReferralCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return code;
}

/** Matches the shape a generated code has — used to distinguish a short code from the legacy numeric-telegramUserId scheme. */
export const REFERRAL_CODE_PATTERN = /^[A-Z2-9]{6}$/i;

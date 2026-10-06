import { describe, it, expect } from 'vitest';
import { base32Encode, base32Decode, totp, verifyTotp, generateTotpSecret, totpAuthUrl } from './totp';

// RFC 6238 Appendix B official test vectors use the raw ASCII key
// "12345678901234567890" with SHA-1 and 8-digit codes. This implementation
// produces 6-digit codes, which are mathematically the last 6 digits of the
// 8-digit value (x mod 10^6 == (x mod 10^8) mod 10^6), so the vectors are
// reused here truncated to 6 digits — proof against the spec, not just
// self-consistency.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('totp (RFC 6238 official test vectors, SHA-1)', () => {
  const cases: [number, string][] = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];

  it.each(cases)('T=%i -> %s', (seconds, expected) => {
    expect(totp(RFC_SECRET, seconds * 1000)).toBe(expected);
  });
});

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (const len of [1, 5, 10, 16, 20, 32]) {
      const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) % 256));
      expect(base32Decode(base32Encode(buf))).toEqual(buf);
    }
  });

  it('ignores separators and is case-insensitive on decode', () => {
    const buf = Buffer.from('hello world');
    const encoded = base32Encode(buf);
    const messy = encoded.toLowerCase().match(/.{1,4}/g)!.join('-');
    expect(base32Decode(messy)).toEqual(buf);
  });
});

describe('generateTotpSecret', () => {
  it('produces a usable, decodable 160-bit secret each time', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).not.toBe(b);
    expect(base32Decode(a)).toHaveLength(20);
  });
});

describe('verifyTotp', () => {
  const secret = generateTotpSecret();
  const now = Date.now();

  it('accepts the current code', () => {
    const code = totp(secret, now);
    expect(verifyTotp(secret, code, now)).not.toBeNull();
  });

  it('accepts a code from one step of clock drift either side', () => {
    const codeAhead = totp(secret, now + 30_000);
    expect(verifyTotp(secret, codeAhead, now)).not.toBeNull();
    const codeBehind = totp(secret, now - 30_000);
    expect(verifyTotp(secret, codeBehind, now)).not.toBeNull();
  });

  it('rejects a code more than one step of drift away', () => {
    const codeFarAhead = totp(secret, now + 90_000);
    expect(verifyTotp(secret, codeFarAhead, now)).toBeNull();
  });

  it('rejects garbage input without throwing', () => {
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
    expect(verifyTotp(secret, '12345', now)).toBeNull();
    expect(verifyTotp(secret, '', now)).toBeNull();
  });

  it('rejects a counter at or before sinceCounter (replay protection)', () => {
    const code = totp(secret, now);
    const matchedCounter = verifyTotp(secret, code, now)!;
    expect(verifyTotp(secret, code, now, matchedCounter)).toBeNull();
    expect(verifyTotp(secret, code, now, matchedCounter - 1)).not.toBeNull();
  });
});

describe('totpAuthUrl', () => {
  it('embeds the secret, issuer and account label for authenticator apps', () => {
    const url = totpAuthUrl('JBSWY3DPEHPK3PXP', 'alice', 'YENA Bingo');
    expect(url).toMatch(/^otpauth:\/\/totp\//);
    expect(url).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(url).toContain('issuer=YENA');
    expect(decodeURIComponent(url)).toContain('YENA Bingo:alice');
  });
});

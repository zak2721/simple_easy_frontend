import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import * as bcrypt from 'bcryptjs';

/** OWASP Password Storage Cheat Sheet baseline for argon2id. */
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/**
 * Admin password hashing. New hashes are argon2id. Hashes created before the
 * switch are bcrypt ($2a$/$2b$/$2y$): they still verify, and AuthService
 * upgrades each one to argon2id on that admin's next successful login
 * (needsRehash), so no forced password reset is needed.
 */
@Injectable()
export class PasswordService {
  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      if (storedHash.startsWith('$argon2')) return await argon2.verify(storedHash, password);
      if (/^\$2[aby]\$/.test(storedHash)) return await bcrypt.compare(password, storedHash);
      return false;
    } catch {
      return false; // malformed hash never authenticates
    }
  }

  needsRehash(storedHash: string): boolean {
    return !storedHash.startsWith('$argon2') || argon2.needsRehash(storedHash, ARGON2_OPTIONS);
  }
}

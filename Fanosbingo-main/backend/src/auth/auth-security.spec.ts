import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { AuthService, lockUntilFor } from './auth.service';
import { PasswordService } from './password.service';
import { JwtAdminStrategy, hashToken } from './strategies/jwt-admin.strategy';
import { OPERATOR_PERMISSIONS } from '../common/rbac.constants';
import { generateTotpSecret, totp } from '../common/crypto/totp';
import { encryptSecret } from '../common/crypto/secret-box';
import { normalizeRecoveryCode } from '../common/crypto/recovery-codes';

const TEST_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64'); // valid shape only, not a real secret

describe('PasswordService', () => {
  const passwords = new PasswordService();

  it('hashes with argon2id and verifies', async () => {
    const hash = await passwords.hash('correct horse battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await passwords.verify(hash, 'correct horse battery')).toBe(true);
    expect(await passwords.verify(hash, 'wrong')).toBe(false);
    expect(passwords.needsRehash(hash)).toBe(false);
  });

  it('still verifies a legacy bcrypt hash, and flags it for upgrade', async () => {
    const legacy = await bcrypt.hash('old-password-123', 4);
    expect(await passwords.verify(legacy, 'old-password-123')).toBe(true);
    expect(await passwords.verify(legacy, 'nope')).toBe(false);
    expect(passwords.needsRehash(legacy)).toBe(true);
  });

  it('never authenticates against a malformed hash', async () => {
    expect(await passwords.verify('not-a-hash', 'anything')).toBe(false);
    expect(await passwords.verify('', '')).toBe(false);
  });
});

describe('lockout ladder', () => {
  const now = 1_000_000;
  it('no lock below 5 failures', () => expect(lockUntilFor(4, now)).toBeNull());
  it('15 minutes at 5', () => expect(lockUntilFor(5, now)!.getTime()).toBe(now + 15 * 60_000));
  it('1 hour at 10', () => expect(lockUntilFor(10, now)!.getTime()).toBe(now + 60 * 60_000));
  it('until an administrator unlocks it at 20', () => expect(lockUntilFor(20, now)!.getUTCFullYear()).toBe(9999));
});

describe('AuthService admin security', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let passwords: { hash: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn>; needsRehash: ReturnType<typeof vi.fn> };
  let history: { record: ReturnType<typeof vi.fn> };
  let audit: { log: ReturnType<typeof vi.fn> };
  let notifications: { notifyPlatform: ReturnType<typeof vi.fn>; notifyOperator: ReturnType<typeof vi.fn> };
  let jwt: { sign: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> };
  let service: AuthService;
  const baseAdmin = {
    id: 'a1',
    username: 'boss',
    fullName: 'Boss',
    role: 'OPERATOR_OWNER',
    status: 'active',
    operatorId: 'op-1',
    passwordHash: '$argon2id$stored',
    failedLoginCount: 0,
    lockedUntil: null as Date | null,
    operator: { status: 'active' },
  };

  beforeEach(() => {
    prisma = {
      adminUser: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
      adminSession: { create: vi.fn().mockResolvedValue({ id: 's1', expiresAt: new Date(Date.now() + 3_600_000) }), update: vi.fn(), updateMany: vi.fn() },
      adminRefreshToken: { create: vi.fn().mockResolvedValue({ id: 'rt-new' }), findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
      adminRecoveryCode: { createMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
      playerRefreshToken: { findFirst: vi.fn(), updateMany: vi.fn() },
    };
    passwords = { hash: vi.fn().mockResolvedValue('$argon2id$new'), verify: vi.fn(), needsRehash: vi.fn().mockReturnValue(false) };
    history = { record: vi.fn() };
    audit = { log: vi.fn() };
    notifications = { notifyPlatform: vi.fn(), notifyOperator: vi.fn() };
    jwt = { sign: vi.fn().mockReturnValue('access.jwt'), verify: vi.fn() };
    const none = {};
    service = new AuthService(
      prisma, none as never, none as never, none as never, jwt as never, { get: (key: string) => (key === 'PLATFORM_ENCRYPTION_KEY' ? TEST_ENCRYPTION_KEY : '') } as never,
      audit as never, none as never, none as never, none as never, none as never, passwords as never, history as never,
      notifications as never,
    );
  });

  it('unknown username still runs a password verification (no timing oracle) and fails generically', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(null);
    passwords.verify.mockResolvedValue(false);
    await expect(service.adminLogin({ username: 'ghost', password: 'x' }, {})).rejects.toThrow(UnauthorizedException);
    expect(passwords.hash).toHaveBeenCalledTimes(1); // the dummy hash
    expect(passwords.verify).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(expect.objectContaining({ success: false, failureReason: 'unknown_username' }));
  });

  it('a locked account is refused before the password is even checked', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ ...baseAdmin, lockedUntil: new Date(Date.now() + 60_000) });
    await expect(service.adminLogin({ username: 'boss', password: 'right' }, {})).rejects.toThrow(ForbiddenException);
    expect(passwords.verify).not.toHaveBeenCalled();
    expect(history.record).toHaveBeenCalledWith(expect.objectContaining({ failureReason: 'locked' }));
  });

  it('the 5th consecutive wrong password locks the account for 15 minutes and audits it', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ ...baseAdmin, failedLoginCount: 4 });
    passwords.verify.mockResolvedValue(false);
    await expect(service.adminLogin({ username: 'boss', password: 'wrong' }, {})).rejects.toThrow(UnauthorizedException);
    const update = prisma.adminUser.update.mock.calls[0][0];
    expect(update.data.failedLoginCount).toBe(5);
    expect(update.data.lockedUntil.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ADMIN_ACCOUNT_LOCKED' }));
    // Both the Super Admin and the operator's own admins are told.
    expect(notifications.notifyPlatform).toHaveBeenCalledWith(expect.objectContaining({ type: 'ADMIN_ACCOUNT_LOCKED', operatorId: 'op-1' }));
    expect(notifications.notifyOperator).toHaveBeenCalledWith('op-1', expect.objectContaining({ type: 'ADMIN_ACCOUNT_LOCKED' }));
  });

  it('refuses login for an admin of a suspended operator, even with the right password', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ ...baseAdmin, operator: { status: 'suspended' } });
    passwords.verify.mockResolvedValue(true);
    await expect(service.adminLogin({ username: 'boss', password: 'right' }, {})).rejects.toThrow(ForbiddenException);
    expect(prisma.adminSession.create).not.toHaveBeenCalled();
  });

  it('success clears the failure streak, upgrades a legacy hash, and issues access + refresh tokens', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ ...baseAdmin, failedLoginCount: 3, passwordHash: '$2b$10$legacy' });
    passwords.verify.mockResolvedValue(true);
    passwords.needsRehash.mockReturnValue(true);

    const result = await service.adminLogin({ username: 'boss', password: 'right' }, { ip: '1.2.3.4' });
    if (result.status !== 'ok') throw new Error('expected a completed login, not a 2FA challenge');

    const update = prisma.adminUser.update.mock.calls[0][0];
    expect(update.data).toMatchObject({ failedLoginCount: 0, lockedUntil: null, passwordHash: '$argon2id$new' });
    expect(result.token).toBe('access.jwt');
    expect(result.accessTokenExpiresIn).toBe(900);
    expect(result.refreshToken).toMatch(/^[0-9a-f]{96}$/);
    expect(result.admin.operatorId).toBe('op-1');
    expect(history.record).toHaveBeenCalledWith(expect.objectContaining({ success: true, operatorId: 'op-1' }));
  });

  describe('setTelegramAlertChat', () => {
    it('trims and stores a chat id, and audits the enable', async () => {
      await service.setTelegramAlertChat('a1', '  12345  ');
      expect(prisma.adminUser.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { telegramAlertChatId: '12345' } });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ADMIN_TELEGRAM_ALERTS_ENABLED', adminId: 'a1' }));
    });

    it('an empty/whitespace-only value clears it and audits the disable', async () => {
      await service.setTelegramAlertChat('a1', '   ');
      expect(prisma.adminUser.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { telegramAlertChatId: null } });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ADMIN_TELEGRAM_ALERTS_DISABLED', adminId: 'a1' }));
    });

    it('undefined/null also clears it', async () => {
      await service.setTelegramAlertChat('a1', null);
      expect(prisma.adminUser.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { telegramAlertChatId: null } });
    });
  });

  describe('impersonation', () => {
    const target = { id: 't1', username: 'op_owner', fullName: 'Op Owner', role: 'OPERATOR_OWNER', status: 'active', operatorId: 'op-1' };

    it('starts a session for the target, tagged with the real actor, and audits + notifies', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(target);
      const result = await service.startImpersonation('super1', 't1', 'debugging a payout', {});

      expect(result.status).toBe('ok');
      expect(result.impersonating).toBe(true);
      expect(result.token).toBe('access.jwt');
      expect(result.admin.operatorId).toBe('op-1');
      const created = prisma.adminSession.create.mock.calls[0][0].data;
      expect(created.adminId).toBe('t1');
      expect(created.impersonatedByAdminId).toBe('super1');
      expect(created.impersonationReason).toBe('debugging a payout');
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'IMPERSONATION_STARTED', adminId: 'super1', entityId: 't1' }));
      expect(notifications.notifyPlatform).toHaveBeenCalledWith(expect.objectContaining({ type: 'IMPERSONATION_STARTED' }));
      expect(notifications.notifyOperator).toHaveBeenCalledWith('op-1', expect.objectContaining({ type: 'IMPERSONATION_STARTED' }));
    });

    it('refuses to impersonate yourself', async () => {
      await expect(service.startImpersonation('super1', 'super1', undefined, {})).rejects.toThrow(ForbiddenException);
      expect(prisma.adminSession.create).not.toHaveBeenCalled();
    });

    it('refuses to impersonate the Super Admin', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ ...target, role: 'SUPER_ADMIN' });
      await expect(service.startImpersonation('super1', 't1', undefined, {})).rejects.toThrow(ForbiddenException);
      expect(prisma.adminSession.create).not.toHaveBeenCalled();
    });

    it('refuses to impersonate an inactive account', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ ...target, status: 'suspended' });
      await expect(service.startImpersonation('super1', 't1', undefined, {})).rejects.toThrow(ForbiddenException);
    });

    it('404s (as a BadRequest) for a nonexistent target', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(null);
      await expect(service.startImpersonation('super1', 'ghost', undefined, {})).rejects.toThrow();
      expect(prisma.adminSession.create).not.toHaveBeenCalled();
    });

    it('ending an impersonation revokes the session and audits the REAL actor, not the impersonated account', async () => {
      const impersonatedAdmin = {
        adminId: 't1', sessionId: 's1', username: 'op_owner', fullName: 'Op Owner',
        permissions: [], roles: ['OPERATOR_OWNER'], operatorId: 'op-1', totpEnabled: false,
        impersonatedByAdminId: 'super1', telegramAlertChatId: null,
      };
      const result = await service.endImpersonation(impersonatedAdmin, {});
      expect(result.success).toBe(true);
      expect(prisma.adminSession.updateMany).toHaveBeenCalledWith({ where: { id: 's1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'IMPERSONATION_ENDED', adminId: 'super1', entityId: 't1' }));
      expect(notifications.notifyOperator).toHaveBeenCalledWith('op-1', expect.objectContaining({ type: 'IMPERSONATION_ENDED' }));
    });

    it('refuses to "end" a session that was never an impersonation', async () => {
      const normalAdmin = {
        adminId: 'a1', sessionId: 's1', username: 'boss', fullName: 'Boss',
        permissions: [], roles: ['OPERATOR_OWNER'], operatorId: 'op-1', totpEnabled: false,
        impersonatedByAdminId: null, telegramAlertChatId: null,
      };
      await expect(service.endImpersonation(normalAdmin, {})).rejects.toThrow();
      expect(prisma.adminSession.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('refreshAdminSession', () => {
    const live = () => ({
      id: 'rt-1',
      adminId: 'a1',
      sessionId: 's1',
      revokedAt: null as Date | null,
      expiresAt: new Date(Date.now() + 60_000),
      session: { id: 's1', revokedAt: null, expiresAt: new Date(Date.now() + 3_600_000) },
      admin: { ...baseAdmin },
    });

    it('rotates: claims the old token, issues a new one in the same session, links them', async () => {
      prisma.adminRefreshToken.findFirst.mockResolvedValue(live());
      prisma.adminRefreshToken.updateMany.mockResolvedValue({ count: 1 });
      const result = await service.refreshAdminSession('raw', {});
      expect(prisma.adminRefreshToken.updateMany).toHaveBeenCalledWith({ where: { id: 'rt-1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
      expect(prisma.adminRefreshToken.update).toHaveBeenCalledWith({ where: { id: 'rt-1' }, data: { replacedById: 'rt-new' } });
      expect(result.token).toBe('access.jwt');
    });

    it('reuse of an already-rotated token revokes the whole session and is audited', async () => {
      prisma.adminRefreshToken.findFirst.mockResolvedValue({ ...live(), revokedAt: new Date() });
      await expect(service.refreshAdminSession('raw', {})).rejects.toThrow(UnauthorizedException);
      expect(prisma.adminSession.updateMany).toHaveBeenCalledWith({ where: { id: 's1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
      expect(prisma.adminRefreshToken.updateMany).toHaveBeenCalledWith({ where: { sessionId: 's1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ADMIN_REFRESH_TOKEN_REUSE' }));
      expect(notifications.notifyPlatform).toHaveBeenCalledWith(expect.objectContaining({ type: 'SUSPICIOUS_ACTIVITY', severity: 'critical' }));
    });

    it('of two concurrent refreshes with the same token, the loser gets 401 and no new token', async () => {
      prisma.adminRefreshToken.findFirst.mockResolvedValue(live());
      prisma.adminRefreshToken.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.refreshAdminSession('raw', {})).rejects.toThrow(UnauthorizedException);
      expect(prisma.adminRefreshToken.create).not.toHaveBeenCalled();
    });

    it('a revoked session (e.g. admin suspended) cannot be refreshed', async () => {
      prisma.adminRefreshToken.findFirst.mockResolvedValue({ ...live(), session: { id: 's1', revokedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) } });
      await expect(service.refreshAdminSession('raw', {})).rejects.toThrow(UnauthorizedException);
      expect(prisma.adminRefreshToken.create).not.toHaveBeenCalled();
    });

    it('missing cookie -> 401', async () => {
      await expect(service.refreshAdminSession(undefined, {})).rejects.toThrow(UnauthorizedException);
    });
  });

  it('player refresh-token reuse revokes the whole token family', async () => {
    prisma.playerRefreshToken.findFirst.mockResolvedValue({ id: 't2', familyId: 'fam-1', telegramUserId: 'u1', revokedAt: new Date(), expiresAt: new Date(Date.now() + 1e6) });
    await expect(service.refreshPlayerToken('raw')).rejects.toThrow(UnauthorizedException);
    expect(prisma.playerRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { OR: [{ familyId: 'fam-1' }, { id: 'fam-1' }], revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(history.record).toHaveBeenCalledWith(expect.objectContaining({ principalType: 'player', failureReason: 'refresh_token_reuse' }));
  });

  /**
   * Production readiness audit (Critical finding): the admin_recovery_codes
   * table and Prisma model existed with zero application code using them —
   * no generation, no consumption, no regeneration. These tests cover the
   * full lifecycle now that it's implemented.
   */
  describe('2FA recovery codes', () => {
    describe('confirmTotp', () => {
      it('enables 2FA and issues 10 unique one-time recovery codes, storing only their hash', async () => {
        const secret = generateTotpSecret();
        prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'a1', totpSecretEncrypted: encryptSecret(secret, TEST_ENCRYPTION_KEY), totpLastUsedCounter: null });

        const result = await service.confirmTotp('a1', totp(secret));

        expect(result.success).toBe(true);
        expect(result.recoveryCodes).toHaveLength(10);
        expect(new Set(result.recoveryCodes).size).toBe(10);
        expect(prisma.adminRecoveryCode.deleteMany).toHaveBeenCalledWith({ where: { adminId: 'a1' } });
        const createData = prisma.adminRecoveryCode.createMany.mock.calls[0][0].data as Array<{ adminId: string; codeHash: string }>;
        expect(createData).toHaveLength(10);
        // Every stored row is the HASH of one issued code, and the plaintext code itself never appears in what's stored.
        expect(createData.every((row, i) => row.adminId === 'a1' && row.codeHash === hashToken(normalizeRecoveryCode(result.recoveryCodes[i])))).toBe(true);
        expect(createData.some((row) => result.recoveryCodes.includes(row.codeHash))).toBe(false);
        expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ADMIN_2FA_ENABLED' }));
      });
    });

    describe('disableTotp', () => {
      it('clears every recovery code along with disabling 2FA, so a stale batch can never outlive its enrollment', async () => {
        prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'a1', passwordHash: '$argon2id$stored' });
        passwords.verify.mockResolvedValue(true);

        await service.disableTotp('a1', 'correct-password');

        expect(prisma.adminUser.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: expect.objectContaining({ totpEnabled: false }) });
        expect(prisma.adminRecoveryCode.deleteMany).toHaveBeenCalledWith({ where: { adminId: 'a1' } });
      });
    });

    describe('regenerateRecoveryCodes', () => {
      it('refuses when 2FA is not enabled on the account', async () => {
        prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'a1', totpEnabled: false });
        await expect(service.regenerateRecoveryCodes('a1', 'pw')).rejects.toThrow('2FA is not enabled');
        expect(prisma.adminRecoveryCode.createMany).not.toHaveBeenCalled();
      });

      it('refuses an incorrect password without touching any existing codes', async () => {
        prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'a1', totpEnabled: true, passwordHash: '$argon2id$stored' });
        passwords.verify.mockResolvedValue(false);
        await expect(service.regenerateRecoveryCodes('a1', 'wrong')).rejects.toThrow(UnauthorizedException);
        expect(prisma.adminRecoveryCode.deleteMany).not.toHaveBeenCalled();
      });

      it('issues a fresh batch of 10 codes, replacing the old one, and audits it', async () => {
        prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'a1', totpEnabled: true, passwordHash: '$argon2id$stored' });
        passwords.verify.mockResolvedValue(true);

        const result = await service.regenerateRecoveryCodes('a1', 'correct-password');

        expect(result.recoveryCodes).toHaveLength(10);
        expect(prisma.adminRecoveryCode.deleteMany).toHaveBeenCalledWith({ where: { adminId: 'a1' } });
        expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ADMIN_RECOVERY_CODES_REGENERATED', newState: { count: 10 } }));
      });
    });

    describe('completeAdminRecoveryLogin', () => {
      const challengePayload = { sub: 'a1', type: 'admin_2fa_challenge' };

      it('rejects an expired/invalid challenge token', async () => {
        jwt.verify.mockImplementation(() => {
          throw new Error('expired');
        });
        await expect(service.completeAdminRecoveryLogin('bad-token', 'AAAA-BBBB', {})).rejects.toThrow(UnauthorizedException);
      });

      it('rejects a challenge token issued for a different purpose', async () => {
        jwt.verify.mockReturnValue({ sub: 'a1', type: 'admin_access' });
        await expect(service.completeAdminRecoveryLogin('t', 'AAAA-BBBB', {})).rejects.toThrow('Invalid challenge');
      });

      it('rejects when the account does not actually have 2FA enabled', async () => {
        jwt.verify.mockReturnValue(challengePayload);
        prisma.adminUser.findUnique.mockResolvedValue({ ...baseAdmin, totpEnabled: false });
        await expect(service.completeAdminRecoveryLogin('t', 'AAAA-BBBB', {})).rejects.toThrow('Invalid challenge');
      });

      it('a locked account is refused before the recovery code is even checked', async () => {
        jwt.verify.mockReturnValue(challengePayload);
        prisma.adminUser.findUnique.mockResolvedValue({ ...baseAdmin, totpEnabled: true, lockedUntil: new Date(Date.now() + 60_000) });
        await expect(service.completeAdminRecoveryLogin('t', 'AAAA-BBBB', {})).rejects.toThrow(ForbiddenException);
        expect(prisma.adminRecoveryCode.updateMany).not.toHaveBeenCalled();
      });

      it('an unknown or already-used code is refused and counts toward the same lockout ladder as a bad password', async () => {
        jwt.verify.mockReturnValue(challengePayload);
        prisma.adminUser.findUnique.mockResolvedValue({ ...baseAdmin, totpEnabled: true });
        prisma.adminRecoveryCode.updateMany.mockResolvedValue({ count: 0 });

        await expect(service.completeAdminRecoveryLogin('t', 'AAAA-BBBB', {})).rejects.toThrow(UnauthorizedException);

        expect(prisma.adminUser.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ failedLoginCount: 1 }) }));
        expect(history.record).toHaveBeenCalledWith(expect.objectContaining({ failureReason: 'bad_recovery_code' }));
        expect(prisma.adminSession.create).not.toHaveBeenCalled();
      });

      it('a valid, unused code (case/whitespace/dash-insensitive) is consumed exactly once and completes the login', async () => {
        jwt.verify.mockReturnValue(challengePayload);
        prisma.adminUser.findUnique.mockResolvedValue({ ...baseAdmin, totpEnabled: true });
        prisma.adminRecoveryCode.updateMany.mockResolvedValue({ count: 1 });
        prisma.adminRecoveryCode.count.mockResolvedValue(7);

        // Submitted with different casing/spacing and NO dash — must still match
        // a code that was generated and stored in "XXXX-XXXX" form.
        const result = await service.completeAdminRecoveryLogin('t', ' aaaabbbb ', {});

        expect(prisma.adminRecoveryCode.updateMany).toHaveBeenCalledWith({
          where: { adminId: 'a1', codeHash: hashToken('AAAABBBB'), usedAt: null },
          data: { usedAt: expect.any(Date) },
        });
        expect(result.token).toBe('access.jwt');
        expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ADMIN_RECOVERY_CODE_USED', newState: { remaining: 7 } }));
      });

      it('matches a stored code regardless of whether the submitted value includes the display dash', async () => {
        jwt.verify.mockReturnValue(challengePayload);
        prisma.adminUser.findUnique.mockResolvedValue({ ...baseAdmin, totpEnabled: true });
        prisma.adminRecoveryCode.updateMany.mockResolvedValue({ count: 1 });
        prisma.adminRecoveryCode.count.mockResolvedValue(9);

        await service.completeAdminRecoveryLogin('t', 'AAAA-BBBB', {});

        expect(prisma.adminRecoveryCode.updateMany).toHaveBeenCalledWith({
          where: { adminId: 'a1', codeHash: hashToken('AAAABBBB'), usedAt: null },
          data: { usedAt: expect.any(Date) },
        });
      });

      it('warns the operator and platform once only a couple of recovery codes remain', async () => {
        jwt.verify.mockReturnValue(challengePayload);
        prisma.adminUser.findUnique.mockResolvedValue({ ...baseAdmin, totpEnabled: true });
        prisma.adminRecoveryCode.updateMany.mockResolvedValue({ count: 1 });
        prisma.adminRecoveryCode.count.mockResolvedValue(1);

        await service.completeAdminRecoveryLogin('t', 'AAAA-BBBB', {});

        expect(notifications.notifyPlatform).toHaveBeenCalledWith(expect.objectContaining({ type: 'RECOVERY_CODES_LOW', operatorId: 'op-1' }));
        expect(notifications.notifyOperator).toHaveBeenCalledWith('op-1', expect.objectContaining({ type: 'RECOVERY_CODES_LOW' }));
      });

      it('does not warn while several recovery codes still remain', async () => {
        jwt.verify.mockReturnValue(challengePayload);
        prisma.adminUser.findUnique.mockResolvedValue({ ...baseAdmin, totpEnabled: true });
        prisma.adminRecoveryCode.updateMany.mockResolvedValue({ count: 1 });
        prisma.adminRecoveryCode.count.mockResolvedValue(5);

        await service.completeAdminRecoveryLogin('t', 'AAAA-BBBB', {});

        expect(notifications.notifyPlatform).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'RECOVERY_CODES_LOW' }));
      });
    });
  });
});

describe('JwtAdminStrategy permission computation', () => {
  const session = (admin: Record<string, unknown>, grants: string[]) => ({
    id: 's1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    admin: {
      id: 'a1',
      username: 'u',
      fullName: 'U',
      status: 'active',
      lockedUntil: null,
      operatorId: 'op-1',
      operator: { status: 'active' },
      permissions: grants.map((key) => ({ permission: { key } })),
      ...admin,
    },
  });
  const strategy = (s: unknown) =>
    new JwtAdminStrategy({ get: () => 'secret' } as never, { adminSession: { findUnique: vi.fn().mockResolvedValue(s) } } as never);

  it('owner holds every operator-scoped permission and none of the platform ones', async () => {
    const r = await strategy(session({ role: 'OPERATOR_OWNER' }, [])).validate({ sub: 'a1', sid: 's1', type: 'admin_access' });
    expect(r.permissions.sort()).toEqual([...OPERATOR_PERMISSIONS].sort());
    expect(r.permissions).not.toContain('ADJUST_WALLET');
    expect(r.operatorId).toBe('op-1');
  });

  it('staff: a platform permission stored against the account is filtered out', async () => {
    const r = await strategy(session({ role: 'OPERATOR_STAFF' }, ['VIEW_DEPOSITS', 'ADJUST_WALLET', 'MANAGE_OPERATORS'])).validate({ sub: 'a1', sid: 's1', type: 'admin_access' });
    expect(r.permissions).toEqual(['VIEW_DEPOSITS']);
  });

  it('a locked admin is rejected on every request, not just at next login', async () => {
    await expect(
      strategy(session({ role: 'OPERATOR_STAFF', lockedUntil: new Date(Date.now() + 60_000) }, [])).validate({ sub: 'a1', sid: 's1', type: 'admin_access' }),
    ).rejects.toThrow(UnauthorizedException);
  });
});

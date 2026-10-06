import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BonusService } from './bonus.service';

/**
 * Audit finding BONUS-1 (Medium): expireStaleBonuses is the fix for bonuses
 * that sat `active` forever with unmet wagering. Its correctness hinges on
 * two properties that are easy to get wrong: (1) never forfeit more than the
 * user's current pooled bonus_balance (a debit past zero would corrupt the
 * ledger), and (2) one bad grant in a batch must never stop the rest from
 * being processed. Both are covered explicitly below.
 */
describe('BonusService', () => {
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    bonusGrant: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
    telegramUser: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  };
  let wallet: { writeEntry: ReturnType<typeof vi.fn>; lockUserForUpdate: ReturnType<typeof vi.fn> };
  let audit: { log: ReturnType<typeof vi.fn> };
  let settings: { get: ReturnType<typeof vi.fn> };
  let metrics: { bonusGrantsTotal: { inc: ReturnType<typeof vi.fn> } };
  let notifications: { notifyPlatform: ReturnType<typeof vi.fn>; notifyOperator: ReturnType<typeof vi.fn> };
  let service: BonusService;
  let tx: {
    bonusGrant: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    telegramUser: { update: ReturnType<typeof vi.fn> };
    $executeRaw: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    tx = {
      bonusGrant: { create: vi.fn(), update: vi.fn() },
      telegramUser: { update: vi.fn() },
      $executeRaw: vi.fn(),
    };
    prisma = {
      $transaction: vi.fn(async (cb) => cb(tx)),
      bonusGrant: { findMany: vi.fn(), count: vi.fn() },
      telegramUser: { findUnique: vi.fn(), findMany: vi.fn() },
    };
    wallet = { writeEntry: vi.fn(), lockUserForUpdate: vi.fn() };
    audit = { log: vi.fn() };
    // Key-aware: BONUS_EXPIRY_DAYS defaults to '0' (no expiry) and the
    // fingerprint cap defaults to '0' (disabled) unless a test overrides one
    // specifically — keeps the two settings from bleeding into each other.
    settings = { get: vi.fn(async () => '0') };
    metrics = { bonusGrantsTotal: { inc: vi.fn() } };
    notifications = { notifyPlatform: vi.fn(), notifyOperator: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new BonusService(prisma as any, wallet as any, audit as any, settings as any, metrics as any, notifications as any);
  });

  describe('grant', () => {
    it('is a no-op for a zero amount and touches no database', async () => {
      const result = await service.grant({
        telegramUserId: 'u1',
        operatorId: 'op-1',
        reason: 'SIGNUP',
        amount: 0,
        actorType: 'system',
        auditAction: 'SIGNUP_BONUS_GRANTED',
      });
      expect(result).toEqual({ granted: false });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('is a no-op for a negative amount', async () => {
      const result = await service.grant({
        telegramUserId: 'u1',
        operatorId: 'op-1',
        reason: 'SIGNUP',
        amount: -10,
        actorType: 'system',
        auditAction: 'SIGNUP_BONUS_GRANTED',
      });
      expect(result).toEqual({ granted: false });
    });

    it('grants with no expiry when BONUS_EXPIRY_DAYS is 0', async () => {
      settings.get.mockResolvedValue('0');
      tx.bonusGrant.create.mockResolvedValue({ id: 'grant-1' });
      const result = await service.grant({
        telegramUserId: 'u1',
        operatorId: 'op-1',
        reason: 'SIGNUP',
        amount: 30,
        actorType: 'system',
        auditAction: 'SIGNUP_BONUS_GRANTED',
      });
      expect(result).toEqual({ granted: true, bonusGrantId: 'grant-1' });
      expect(tx.bonusGrant.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ expiresAt: null }) }),
      );
    });

    it('computes expiresAt in the future when BONUS_EXPIRY_DAYS is set', async () => {
      settings.get.mockImplementation(async (key: string) => (key === 'BONUS_EXPIRY_DAYS' ? '7' : '0'));
      tx.bonusGrant.create.mockResolvedValue({ id: 'grant-1' });
      const before = Date.now();
      await service.grant({
        telegramUserId: 'u1',
        operatorId: 'op-1',
        reason: 'SIGNUP',
        amount: 30,
        actorType: 'system',
        auditAction: 'SIGNUP_BONUS_GRANTED',
      });
      const call = tx.bonusGrant.create.mock.calls[0][0];
      const expiresAt: Date = call.data.expiresAt;
      const days = (expiresAt.getTime() - before) / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThan(6.99);
      expect(days).toBeLessThan(7.01);
    });

    it('applies the wagering multiplier to compute wageringRequired', async () => {
      tx.bonusGrant.create.mockResolvedValue({ id: 'grant-1' });
      await service.grant({
        telegramUserId: 'u1',
        operatorId: 'op-1',
        reason: 'REFERRAL_INVITEE',
        amount: 50,
        wageringMultiplier: 2,
        actorType: 'system',
        auditAction: 'REFERRAL_BONUS_GRANTED',
      });
      expect(tx.bonusGrant.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ wageringRequired: 100 }) }),
      );
    });

    it('treats a duplicate-grant (P2002) race as a safe no-op, not an error', async () => {
      prisma.$transaction.mockRejectedValue({ code: 'P2002' });
      const result = await service.grant({
        telegramUserId: 'u1',
        operatorId: 'op-1',
        reason: 'SIGNUP',
        amount: 30,
        actorType: 'system',
        auditAction: 'SIGNUP_BONUS_GRANTED',
      });
      expect(result).toEqual({ granted: false });
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('rethrows non-constraint errors instead of swallowing them', async () => {
      prisma.$transaction.mockRejectedValue(new Error('connection lost'));
      await expect(
        service.grant({ telegramUserId: 'u1', operatorId: 'op-1', reason: 'SIGNUP', amount: 30, actorType: 'system', auditAction: 'X' }),
      ).rejects.toThrow('connection lost');
    });

    it('strips the per-referral suffix off the metrics label to keep cardinality bounded', async () => {
      tx.bonusGrant.create.mockResolvedValue({ id: 'grant-1' });
      await service.grant({
        telegramUserId: 'u1',
        operatorId: 'op-1',
        reason: 'REFERRAL_REFERRER:some-referral-id',
        amount: 20,
        actorType: 'system',
        auditAction: 'REFERRAL_REWARD_GRANTED',
      });
      expect(metrics.bonusGrantsTotal.inc).toHaveBeenCalledWith({ reason: 'REFERRAL_REFERRER' });
    });

    /**
     * Sybil/bonus-farming defense (product decision — Production Readiness
     * Audit "Sybil/multi-account defense"): a lightweight heuristic, not
     * identity verification — every scenario below confirms it fails open
     * rather than ever blocking a legitimate grant it can't evaluate.
     */
    describe('Sybil/bonus-farming fingerprint cap', () => {
      const capSettings = (max: string) => settings.get.mockImplementation(async (key: string) => (key === 'MAX_BONUS_GRANTS_PER_FINGERPRINT_PER_DAY' ? max : '0'));

      it('refuses a SIGNUP grant once the cap is already met by accounts sharing the signup IP/device', async () => {
        capSettings('3');
        prisma.telegramUser.findUnique.mockResolvedValue({ signupIp: '1.2.3.4', signupDeviceId: null });
        prisma.telegramUser.findMany.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }]);
        prisma.bonusGrant.count.mockResolvedValue(3);

        const result = await service.grant({ telegramUserId: 'u1', operatorId: 'op-1', reason: 'SIGNUP', amount: 30, actorType: 'system', auditAction: 'SIGNUP_BONUS_GRANTED' });

        expect(result).toEqual({ granted: false });
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(notifications.notifyPlatform).toHaveBeenCalledWith(expect.objectContaining({ type: 'BONUS_FINGERPRINT_CAP_HIT', operatorId: 'op-1' }));
        expect(notifications.notifyOperator).toHaveBeenCalledWith('op-1', expect.objectContaining({ type: 'BONUS_FINGERPRINT_CAP_HIT' }));
      });

      it('allows the grant while still under the cap', async () => {
        capSettings('3');
        prisma.telegramUser.findUnique.mockResolvedValue({ signupIp: '1.2.3.4', signupDeviceId: null });
        prisma.telegramUser.findMany.mockResolvedValue([{ id: 'u1' }]);
        prisma.bonusGrant.count.mockResolvedValue(2);
        tx.bonusGrant.create.mockResolvedValue({ id: 'grant-1' });

        const result = await service.grant({ telegramUserId: 'u1', operatorId: 'op-1', reason: 'SIGNUP', amount: 30, actorType: 'system', auditAction: 'SIGNUP_BONUS_GRANTED' });

        expect(result).toEqual({ granted: true, bonusGrantId: 'grant-1' });
        expect(notifications.notifyPlatform).not.toHaveBeenCalled();
      });

      it('is disabled (fails open) when the setting is 0', async () => {
        capSettings('0');
        tx.bonusGrant.create.mockResolvedValue({ id: 'grant-1' });

        const result = await service.grant({ telegramUserId: 'u1', operatorId: 'op-1', reason: 'SIGNUP', amount: 30, actorType: 'system', auditAction: 'SIGNUP_BONUS_GRANTED' });

        expect(result).toEqual({ granted: true, bonusGrantId: 'grant-1' });
        expect(prisma.telegramUser.findUnique).not.toHaveBeenCalled(); // short-circuits before even checking the fingerprint
      });

      it('fails open for an account with no captured fingerprint (pre-existing account, or no device id sent)', async () => {
        capSettings('1');
        prisma.telegramUser.findUnique.mockResolvedValue({ signupIp: null, signupDeviceId: null });
        tx.bonusGrant.create.mockResolvedValue({ id: 'grant-1' });

        const result = await service.grant({ telegramUserId: 'u1', operatorId: 'op-1', reason: 'SIGNUP', amount: 30, actorType: 'system', auditAction: 'SIGNUP_BONUS_GRANTED' });

        expect(result).toEqual({ granted: true, bonusGrantId: 'grant-1' });
        expect(prisma.telegramUser.findMany).not.toHaveBeenCalled();
      });

      it('never applies to an admin-granted bonus, even at an already-exceeded fingerprint', async () => {
        capSettings('1');
        tx.bonusGrant.create.mockResolvedValue({ id: 'grant-1' });

        const result = await service.grant({ telegramUserId: 'u1', operatorId: 'op-1', reason: 'SIGNUP', amount: 30, actorType: 'admin', adminId: 'a1', auditAction: 'MANUAL_BONUS_GRANTED' });

        expect(result).toEqual({ granted: true, bonusGrantId: 'grant-1' });
        expect(prisma.telegramUser.findUnique).not.toHaveBeenCalled();
      });

      it('applies to a REFERRAL_* grant the same way as SIGNUP', async () => {
        capSettings('2');
        prisma.telegramUser.findUnique.mockResolvedValue({ signupIp: null, signupDeviceId: 'device-abc' });
        prisma.telegramUser.findMany.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
        prisma.bonusGrant.count.mockResolvedValue(2);

        const result = await service.grant({ telegramUserId: 'u1', operatorId: 'op-1', reason: 'REFERRAL_REFERRER:r1', amount: 10, actorType: 'system', auditAction: 'REFERRAL_REWARD_GRANTED' });

        expect(result).toEqual({ granted: false });
        expect(prisma.bonusGrant.count).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ telegramUserId: { in: ['u1', 'u2'] } }) }),
        );
      });
    });
  });

  describe('expireStaleBonuses', () => {
    it('forfeits the lesser of the grant amount and the current pooled bonus balance', async () => {
      prisma.bonusGrant.findMany.mockResolvedValue([{ id: 'g1', telegramUserId: 'u1', amount: 100, reason: 'SIGNUP' }]);
      wallet.lockUserForUpdate.mockResolvedValue({ bonus_balance: 40 });

      await service.expireStaleBonuses();

      expect(tx.bonusGrant.update).toHaveBeenCalledWith({ where: { id: 'g1' }, data: { status: 'expired' } });
      expect(tx.telegramUser.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { bonusBalance: { decrement: 40 } },
      });
      expect(wallet.writeEntry).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ entryType: 'BONUS_EXPIRED', direction: 'debit', amount: 40 }),
      );
    });

    it('never forfeits more than the grant amount, even if the pooled balance is larger', async () => {
      prisma.bonusGrant.findMany.mockResolvedValue([{ id: 'g1', telegramUserId: 'u1', amount: 15, reason: 'SIGNUP' }]);
      wallet.lockUserForUpdate.mockResolvedValue({ bonus_balance: 500 });

      await service.expireStaleBonuses();

      expect(tx.telegramUser.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { bonusBalance: { decrement: 15 } },
      });
    });

    it('skips the debit and ledger write entirely when the pooled balance is already zero', async () => {
      prisma.bonusGrant.findMany.mockResolvedValue([{ id: 'g1', telegramUserId: 'u1', amount: 30, reason: 'SIGNUP' }]);
      wallet.lockUserForUpdate.mockResolvedValue({ bonus_balance: 0 });

      await service.expireStaleBonuses();

      expect(tx.bonusGrant.update).toHaveBeenCalledWith({ where: { id: 'g1' }, data: { status: 'expired' } });
      expect(tx.telegramUser.update).not.toHaveBeenCalled();
      expect(wallet.writeEntry).not.toHaveBeenCalled();
    });

    it('continues processing remaining grants after one fails mid-batch', async () => {
      prisma.bonusGrant.findMany.mockResolvedValue([
        { id: 'bad', telegramUserId: 'u1', amount: 10, reason: 'SIGNUP' },
        { id: 'good', telegramUserId: 'u2', amount: 20, reason: 'SIGNUP' },
      ]);
      // First transaction call (for 'bad') throws; second (for 'good') succeeds.
      prisma.$transaction
        .mockImplementationOnce(async () => {
          throw new Error('db hiccup');
        })
        .mockImplementationOnce(async (cb) => cb(tx));
      wallet.lockUserForUpdate.mockResolvedValue({ bonus_balance: 20 });

      await service.expireStaleBonuses();

      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(tx.bonusGrant.update).toHaveBeenCalledWith({ where: { id: 'good' }, data: { status: 'expired' } });
      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'good' }));
    });

    it('does nothing when no grants are past expiry', async () => {
      prisma.bonusGrant.findMany.mockResolvedValue([]);
      await service.expireStaleBonuses();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });
  });
});

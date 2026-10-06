import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReferralsService } from './referrals.service';

/**
 * recordReferral's hard contract is "MUST NEVER throw out to the caller" —
 * it runs inline in new-user registration, so any uncaught error here would
 * take down signup itself. Every test that forces a failure path asserts the
 * call still resolves (not rejects).
 */
describe('ReferralsService', () => {
  let prisma: {
    telegramUser: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
    referral: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  };
  let settings: { get: ReturnType<typeof vi.fn> };
  let bonus: { grant: ReturnType<typeof vi.fn> };
  let service: ReferralsService;

  function settingsMap(overrides: Record<string, string> = {}) {
    const defaults: Record<string, string> = {
      REFERRAL_ENABLED: 'true',
      REFERRAL_BONUS_REFERRER_ETB: '20',
      REFERRAL_BONUS_NEW_USER_ETB: '10',
      REFERRAL_MAX_PER_USER: '0',
      ...overrides,
    };
    settings.get.mockImplementation(async (key: string) => defaults[key]);
  }

  beforeEach(() => {
    prisma = {
      // Short codes resolve via findFirst (scoped by operator), legacy numeric ids via findUnique — one shared mock covers both.
      telegramUser: (() => { const lookup = vi.fn(); return { findUnique: lookup, findFirst: lookup }; })(),
      referral: { create: vi.fn(), update: vi.fn().mockResolvedValue({}), count: vi.fn().mockResolvedValue(0) },
    };
    settings = { get: vi.fn() };
    bonus = { grant: vi.fn().mockResolvedValue({ granted: true, bonusGrantId: 'bg1' }) };
    settingsMap();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new ReferralsService(prisma as any, settings as any, bonus as any);
  });

  it('is a no-op when no referral code was supplied', async () => {
    await service.recordReferral('invitee1', 'op-1', undefined);
    expect(prisma.telegramUser.findUnique).not.toHaveBeenCalled();
  });

  it('silently ignores a malformed legacy numeric code instead of throwing', async () => {
    await expect(service.recordReferral('invitee1', 'op-1', 'not-a-number-or-code!')).resolves.toBeUndefined();
    expect(prisma.referral.create).not.toHaveBeenCalled();
  });

  it('silently ignores a code that matches no inviter', async () => {
    prisma.telegramUser.findUnique.mockResolvedValue(null);
    await service.recordReferral('invitee1', 'op-1', '7XPQR9');
    expect(prisma.referral.create).not.toHaveBeenCalled();
  });

  it('blocks a structurally-impossible self-referral', async () => {
    prisma.telegramUser.findUnique.mockResolvedValue({ id: 'invitee1' });
    await service.recordReferral('invitee1', 'op-1', '7XPQR9');
    expect(prisma.referral.create).not.toHaveBeenCalled();
  });

  it('resolves a short code case-insensitively via the referralCode column', async () => {
    prisma.telegramUser.findUnique.mockResolvedValue({ id: 'inviter1' });
    prisma.referral.create.mockResolvedValue({ id: 'ref1' });
    await service.recordReferral('invitee1', 'op-1', '7xpqr9');
    expect(prisma.telegramUser.findUnique).toHaveBeenCalledWith({ where: { referralCode: '7XPQR9', operatorId: 'op-1' }, select: { id: true } });
  });

  it('falls back to the legacy numeric-telegramUserId scheme for old links', async () => {
    prisma.telegramUser.findUnique.mockResolvedValue({ id: 'inviter1' });
    prisma.referral.create.mockResolvedValue({ id: 'ref1' });
    await service.recordReferral('invitee1', 'op-1', '123456789');
    expect(prisma.telegramUser.findUnique).toHaveBeenCalledWith({ where: { operatorId_telegramUserId: { operatorId: 'op-1', telegramUserId: 123456789n } }, select: { id: true } });
  });

  it('treats a duplicate-invitee race (P2002) as a safe no-op, not an error', async () => {
    prisma.telegramUser.findUnique.mockResolvedValue({ id: 'inviter1' });
    prisma.referral.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.recordReferral('invitee1', 'op-1', '7XPQR9')).resolves.toBeUndefined();
    expect(bonus.grant).not.toHaveBeenCalled();
  });

  it('never throws even when an unexpected error occurs deep in the flow', async () => {
    prisma.telegramUser.findUnique.mockRejectedValue(new Error('db exploded'));
    await expect(service.recordReferral('invitee1', 'op-1', '7XPQR9')).resolves.toBeUndefined();
  });

  it('grants the invitee bonus and marks invitedRewarded on a valid new referral', async () => {
    prisma.telegramUser.findUnique.mockResolvedValue({ id: 'inviter1' });
    prisma.referral.create.mockResolvedValue({ id: 'ref1' });

    await service.recordReferral('invitee1', 'op-1', '7XPQR9');

    expect(bonus.grant).toHaveBeenCalledWith(
      expect.objectContaining({ telegramUserId: 'invitee1', reason: 'REFERRAL_INVITEE', amount: 10 }),
    );
    expect(prisma.referral.update).toHaveBeenCalledWith({ where: { id: 'ref1' }, data: { invitedRewarded: true } });
  });

  it('also grants the inviter bonus and marks inviterRewarded when under the cap', async () => {
    prisma.telegramUser.findUnique.mockResolvedValue({ id: 'inviter1' });
    prisma.referral.create.mockResolvedValue({ id: 'ref1' });

    await service.recordReferral('invitee1', 'op-1', '7XPQR9');

    expect(bonus.grant).toHaveBeenCalledWith(
      expect.objectContaining({ telegramUserId: 'inviter1', reason: 'REFERRAL_REFERRER:ref1', amount: 20 }),
    );
    expect(prisma.referral.update).toHaveBeenCalledWith({ where: { id: 'ref1' }, data: { inviterRewarded: true } });
  });

  it('skips both grants entirely when REFERRAL_ENABLED is false, but still records the link', async () => {
    settingsMap({ REFERRAL_ENABLED: 'false' });
    prisma.telegramUser.findUnique.mockResolvedValue({ id: 'inviter1' });
    prisma.referral.create.mockResolvedValue({ id: 'ref1' });

    await service.recordReferral('invitee1', 'op-1', '7XPQR9');

    expect(prisma.referral.create).toHaveBeenCalled();
    expect(bonus.grant).not.toHaveBeenCalled();
  });

  it('stops rewarding the inviter once REFERRAL_MAX_PER_USER is reached, but still rewards the invitee', async () => {
    settingsMap({ REFERRAL_MAX_PER_USER: '5' });
    prisma.telegramUser.findUnique.mockResolvedValue({ id: 'inviter1' });
    prisma.referral.create.mockResolvedValue({ id: 'ref1' });
    prisma.referral.count.mockResolvedValue(5); // already at the cap

    await service.recordReferral('invitee1', 'op-1', '7XPQR9');

    expect(bonus.grant).toHaveBeenCalledWith(expect.objectContaining({ telegramUserId: 'invitee1' }));
    expect(bonus.grant).not.toHaveBeenCalledWith(expect.objectContaining({ telegramUserId: 'inviter1' }));
  });

  it('does not mark inviterRewarded if the underlying grant reports granted: false', async () => {
    prisma.telegramUser.findUnique.mockResolvedValue({ id: 'inviter1' });
    prisma.referral.create.mockResolvedValue({ id: 'ref1' });
    bonus.grant.mockImplementation(async (params: { telegramUserId: string }) =>
      params.telegramUserId === 'inviter1' ? { granted: false } : { granted: true, bonusGrantId: 'bg1' },
    );

    await service.recordReferral('invitee1', 'op-1', '7XPQR9');

    expect(prisma.referral.update).not.toHaveBeenCalledWith({ where: { id: 'ref1' }, data: { inviterRewarded: true } });
  });

  it("records the referral and both grants under the invitee's operator only", async () => {
    prisma.telegramUser.findUnique.mockResolvedValue({ id: 'inviter1' });
    prisma.referral.create.mockResolvedValue({ id: 'ref1' });

    await service.recordReferral('invitee1', 'op-1', '7XPQR9');

    expect(prisma.referral.create).toHaveBeenCalledWith({ data: { inviterUserId: 'inviter1', invitedUserId: 'invitee1', operatorId: 'op-1' } });
    expect(settings.get).toHaveBeenCalledWith('REFERRAL_ENABLED', 'op-1');
    for (const [params] of bonus.grant.mock.calls) expect(params.operatorId).toBe('op-1');
  });

  describe('myStats', () => {
    it('returns zeroed stats shaped correctly for a fresh user', async () => {
      prisma.telegramUser.findUnique.mockResolvedValue({ referralCode: 'ABC234' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prisma.telegramUser as any).findUniqueOrThrow = vi.fn().mockResolvedValue({ referralCode: 'ABC234' });
      prisma.referral.count.mockResolvedValue(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prisma as any).bonusGrant = { aggregate: vi.fn().mockResolvedValue({ _sum: { amount: null } }) };

      const stats = await service.myStats('u1');
      expect(stats).toEqual({ referralCode: 'ABC234', totalReferred: 0, successfulReferred: 0, earnedEtb: 0 });
    });
  });
});

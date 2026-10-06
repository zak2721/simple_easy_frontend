import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { BonusService } from '../bonus/bonus.service';
import { REFERRAL_CODE_PATTERN } from './referral-code.util';

function isUniqueConstraintError(e: unknown): boolean {
  return e instanceof Object && 'code' in e && (e as { code: string }).code === 'P2002';
}

/** Privacy: an inviter sees who joined via their link, never their full identity. */
function maskName(firstName: string | null, username: string | null): string {
  const base = firstName || 'Player';
  return username ? `${base} ${username[0].toUpperCase()}***` : base;
}

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly bonus: BonusService,
  ) {}

  /**
   * Records the referral link (if any) and grants rewards. Called once, right
   * after a brand-new player's row is created. MUST NEVER throw out to the
   * caller — a bad/missing/self referral code degrades silently to "no
   * referral," registration always proceeds.
   */
  async recordReferral(invitedUserId: string, operatorId: string, referralCodeRaw: string | undefined): Promise<void> {
    if (!referralCodeRaw) return;

    try {
      // Inviter must belong to the same operator: a code from another
      // operator's player silently degrades to "no referral", so one operator
      // never pays a referral bonus for another operator's signup.
      let inviter: { id: string } | null;
      if (REFERRAL_CODE_PATTERN.test(referralCodeRaw)) {
        // New short-code scheme.
        inviter = await this.prisma.telegramUser.findFirst({
          where: { referralCode: referralCodeRaw.toUpperCase(), operatorId },
          select: { id: true },
        });
      } else {
        // Legacy scheme: the raw numeric telegramUserId doubles as the code —
        // kept forever so links already shared before short codes existed
        // keep working.
        let inviterTelegramId: bigint;
        try {
          inviterTelegramId = BigInt(referralCodeRaw);
        } catch {
          return; // malformed code — silently ignore
        }
        inviter = await this.prisma.telegramUser.findUnique({
          where: { operatorId_telegramUserId: { operatorId, telegramUserId: inviterTelegramId } },
          select: { id: true },
        });
      }

      if (!inviter || inviter.id === invitedUserId) return; // not found, or a (structurally impossible) self-referral

      let referral;
      try {
        referral = await this.prisma.referral.create({
          data: { inviterUserId: inviter.id, invitedUserId, operatorId },
        });
      } catch (e) {
        if (isUniqueConstraintError(e)) return; // already has an inviter (race) — safe no-op
        throw e;
      }

      const enabled = (await this.settings.get('REFERRAL_ENABLED', operatorId)) !== 'false';
      if (!enabled) return;

      const [referrerAmountSetting, newUserAmountSetting, maxSetting] = await Promise.all([
        this.settings.get('REFERRAL_BONUS_REFERRER_ETB', operatorId),
        this.settings.get('REFERRAL_BONUS_NEW_USER_ETB', operatorId),
        this.settings.get('REFERRAL_MAX_PER_USER', operatorId),
      ]);

      await this.grantIfPositive(invitedUserId, operatorId, Number(newUserAmountSetting ?? 0), 'REFERRAL_INVITEE', referral.id, 'invitee');
      await this.prisma.referral.update({ where: { id: referral.id }, data: { invitedRewarded: true } }).catch(() => {});

      const maxPerUser = Number(maxSetting ?? 0);
      if (maxPerUser > 0) {
        const rewardedCount = await this.prisma.referral.count({ where: { inviterUserId: inviter.id, inviterRewarded: true } });
        if (rewardedCount >= maxPerUser) return; // cap reached — link recorded, no more inviter rewards
      }

      const granted = await this.grantIfPositive(inviter.id, operatorId, Number(referrerAmountSetting ?? 0), `REFERRAL_REFERRER:${referral.id}`, referral.id, 'inviter');
      if (granted) {
        await this.prisma.referral.update({ where: { id: referral.id }, data: { inviterRewarded: true } }).catch(() => {});
      }
    } catch (e) {
      // Referral processing must never block registration.
      this.logger.error(`recordReferral failed for invitedUserId=${invitedUserId}`, e instanceof Error ? e.stack : String(e));
    }
  }

  /** Grants a BonusGrant + ledger credit for `reason` if amount > 0. Returns true if granted (false if skipped/duplicate). */
  private async grantIfPositive(
    telegramUserId: string,
    operatorId: string,
    amount: number,
    reason: string,
    referralId: string,
    role: 'inviter' | 'invitee',
  ): Promise<boolean> {
    if (!amount || amount <= 0) return false;

    const result = await this.bonus.grant({
      telegramUserId,
      operatorId,
      reason,
      amount,
      wageringMultiplier: 1,
      campaignId: referralId,
      relatedEntityType: 'referral',
      relatedEntityId: referralId,
      note: role === 'inviter' ? 'Referral reward (inviter)' : 'Referral reward (new user)',
      actorType: 'system',
      auditAction: 'REFERRAL_REWARD_GRANTED',
      auditState: { referralId, role, amount },
    });
    return result.granted;
  }

  /** The player's own referral stats — powers the "Invite friends" card. */
  async myStats(userId: string) {
    const [user, totalReferred, earned] = await Promise.all([
      this.prisma.telegramUser.findUniqueOrThrow({ where: { id: userId }, select: { referralCode: true } }),
      this.prisma.referral.count({ where: { inviterUserId: userId } }),
      this.prisma.bonusGrant.aggregate({
        where: { telegramUserId: userId, reason: { startsWith: 'REFERRAL_REFERRER:' } },
        _sum: { amount: true },
      }),
    ]);
    const successfulReferred = await this.prisma.referral.count({ where: { inviterUserId: userId, inviterRewarded: true } });

    return {
      referralCode: user.referralCode,
      totalReferred,
      successfulReferred,
      earnedEtb: Number(earned._sum.amount ?? 0),
    };
  }

  /** The player's own referral history — who they invited, and what each earned them. Names are masked for privacy. */
  async myHistory(userId: string) {
    const rows = await this.prisma.referral.findMany({
      where: { inviterUserId: userId },
      orderBy: { createdAt: 'desc' },
      include: { invited: { select: { firstName: true, username: true } } },
    });

    return Promise.all(
      rows.map(async (r) => {
        let rewardAmount = 0;
        if (r.inviterRewarded) {
          const grant = await this.prisma.bonusGrant.findUnique({
            where: { uniq_user_bonus_reason: { telegramUserId: userId, reason: `REFERRAL_REFERRER:${r.id}` } },
          });
          rewardAmount = Number(grant?.amount ?? 0);
        }
        return {
          id: r.id,
          invited_name: maskName(r.invited.firstName, r.invited.username),
          joined_date: r.createdAt,
          rewarded: r.inviterRewarded,
          reward_amount: rewardAmount,
        };
      }),
    );
  }

  /** Admin aggregate report — total referrals/rewards + top referrers, over an optional date range. */
  async reportSummary(params: { from?: Date; to?: Date; operatorId: string | null }) {
    const op = params.operatorId ? { operatorId: params.operatorId } : {};
    const range = { ...op, ...(params.from || params.to ? { createdAt: { gte: params.from, lte: params.to } } : {}) };

    const [totalReferrals, rewardsAgg, topReferrersRaw] = await Promise.all([
      this.prisma.referral.count({ where: range }),
      this.prisma.bonusGrant.aggregate({
        where: { ...op, reason: { startsWith: 'REFERRAL_' }, ...(params.from || params.to ? { createdAt: { gte: params.from, lte: params.to } } : {}) },
        _sum: { amount: true },
      }),
      this.prisma.referral.groupBy({
        by: ['inviterUserId'],
        where: { inviterRewarded: true, ...range },
        _count: { _all: true },
        orderBy: { _count: { inviterUserId: 'desc' } },
        take: 20,
      }),
    ]);

    const inviterIds = topReferrersRaw.map((r) => r.inviterUserId);
    const inviters = await this.prisma.telegramUser.findMany({
      where: { id: { in: inviterIds } },
      select: { id: true, telegramUserId: true, username: true, firstName: true },
    });
    const inviterById = new Map(inviters.map((i) => [i.id, i]));

    return {
      total_referrals: totalReferrals,
      total_rewards_paid_etb: Number(rewardsAgg._sum.amount ?? 0),
      top_referrers: topReferrersRaw.map((r) => {
        const inviter = inviterById.get(r.inviterUserId);
        return {
          telegram_user_id: inviter ? Number(inviter.telegramUserId) : null,
          name: inviter ? (inviter.username ?? inviter.firstName ?? '') : '',
          successful_referrals: r._count._all,
        };
      }),
    };
  }

  /** Flat rows for the admin CSV export — same filter shape as reportSummary/listForAdmin, no pagination. */
  async exportRows(params: { from?: Date; to?: Date; operatorId: string | null }) {
    const range = {
      ...(params.operatorId ? { operatorId: params.operatorId } : {}),
      ...(params.from || params.to ? { createdAt: { gte: params.from, lte: params.to } } : {}),
    };
    const rows = await this.prisma.referral.findMany({
      where: range,
      orderBy: { createdAt: 'desc' },
      include: {
        inviter: { select: { telegramUserId: true, username: true, firstName: true } },
        invited: { select: { telegramUserId: true, username: true, firstName: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      inviter_telegram_user_id: Number(r.inviter.telegramUserId),
      inviter_name: r.inviter.username ?? r.inviter.firstName ?? '',
      invited_telegram_user_id: Number(r.invited.telegramUserId),
      invited_name: r.invited.username ?? r.invited.firstName ?? '',
      inviter_rewarded: r.inviterRewarded,
      invited_rewarded: r.invitedRewarded,
      created_at: r.createdAt,
    }));
  }

  /** Paginated admin report. */
  async listForAdmin(take: number, skip: number, operatorId: string | null) {
    const where = operatorId ? { operatorId } : {};
    const [rows, total] = await Promise.all([
      this.prisma.referral.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: {
          inviter: { select: { telegramUserId: true, username: true, firstName: true } },
          invited: { select: { telegramUserId: true, username: true, firstName: true } },
        },
      }),
      this.prisma.referral.count({ where }),
    ]);

    return {
      total,
      referrals: rows.map((r) => ({
        id: r.id,
        inviter_telegram_user_id: Number(r.inviter.telegramUserId),
        inviter_name: r.inviter.username ?? r.inviter.firstName ?? '',
        invited_telegram_user_id: Number(r.invited.telegramUserId),
        invited_name: r.invited.username ?? r.invited.firstName ?? '',
        inviter_rewarded: r.inviterRewarded,
        invited_rewarded: r.invitedRewarded,
        created_at: r.createdAt,
      })),
    };
  }
}

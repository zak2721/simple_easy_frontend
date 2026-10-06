import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { MetricsService } from '../metrics/metrics.service';
import { NotificationsService } from '../notifications/notifications.service';
import { setTenantOnTx } from '../common/tenant/rls';

function isUniqueConstraintError(e: unknown): boolean {
  return e instanceof Object && 'code' in e && (e as { code: string }).code === 'P2002';
}

export interface GrantBonusParams {
  telegramUserId: string;
  /** The player's own operator: bonus rules, the grant row and its ledger entry all belong to it. */
  operatorId: string;
  /** Unique-per-(user,reason) idempotency key — e.g. "SIGNUP", "REFERRAL_INVITEE", `REFERRAL_REFERRER:${referralId}`. */
  reason: string;
  amount: number;
  /** Multiplies `amount` to get `wageringRequired`. Defaults to 1x, matching every caller's behavior before this was extracted. */
  wageringMultiplier?: number;
  campaignId?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  note?: string;
  actorType: 'system' | 'admin';
  adminId?: string;
  /** Exact string written as AuditLog.action — callers control this so existing action names stay byte-identical. */
  auditAction: string;
  /** Exact shape written as AuditLog.newState — defaults to {reason, amount, telegramUserId} if omitted. */
  auditState?: Record<string, unknown>;
}

/**
 * Shared bonus-granting engine — extracted from what used to be copy-pasted
 * logic in AuthService.grantSignupBonus and ReferralsService.grantIfPositive.
 * Behavior is unchanged from those two original implementations: a
 * self-contained transaction (create BonusGrant -> increment bonusBalance ->
 * write a ledger entry), then an audit log after commit, with a P2002 on the
 * BonusGrant's (telegramUserId, reason) unique constraint treated as a safe
 * "already granted" no-op rather than an error.
 */
@Injectable()
export class BonusService {
  private readonly logger = new Logger(BonusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly metrics: MetricsService,
    private readonly notifications: NotificationsService,
  ) {}

  async grant(params: GrantBonusParams): Promise<{ granted: boolean; bonusGrantId?: string }> {
    const {
      telegramUserId,
      operatorId,
      reason,
      amount,
      wageringMultiplier = 1,
      campaignId,
      relatedEntityType,
      relatedEntityId,
      note,
      actorType,
      adminId,
      auditAction,
      auditState,
    } = params;

    if (!amount || amount <= 0) return { granted: false };

    // Sybil/bonus-farming defense (product decision — Production Readiness
    // Audit "Sybil/multi-account defense"): only the two bonus TYPES that are
    // actually farmable by creating many accounts (a fresh signup, or a
    // referral loop) are capped — never an admin's own discretionary grant.
    const isFarmable = actorType === 'system' && (reason === 'SIGNUP' || reason.startsWith('REFERRAL_'));
    if (isFarmable && (await this.exceedsFingerprintCap(telegramUserId, operatorId))) {
      return { granted: false };
    }

    // Audit finding BONUS-1 (Medium): BonusStatus.expired existed in the
    // schema but nothing ever set it — a bonus with unmet wagering sat
    // `active` forever. BONUS_EXPIRY_DAYS (0/unset = never expires, for
    // backward compatibility with any pre-existing grant) is read at grant
    // time so a later settings change doesn't retroactively alter an
    // already-issued grant's expiry.
    const expiryDaysRaw = await this.settings.get('BONUS_EXPIRY_DAYS', operatorId);
    const expiryDays = Number(expiryDaysRaw ?? 0);
    const expiresAt = expiryDays > 0 ? new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000) : null;

    try {
      const grant = await this.prisma.$transaction(async (tx) => {
        await setTenantOnTx(tx, operatorId);
        const created = await tx.bonusGrant.create({
          data: {
            telegramUserId,
            operatorId,
            reason,
            campaignId,
            amount,
            wageringRequired: Math.round(amount * wageringMultiplier),
            expiresAt,
          },
        });
        await tx.telegramUser.update({
          where: { id: telegramUserId },
          data: { bonusBalance: { increment: amount } },
        });
        await this.wallet.writeEntry(tx, {
          telegramUserId,
          operatorId,
          entryType: 'BONUS_GRANT',
          direction: 'credit',
          amount,
          relatedEntityType,
          relatedEntityId,
          note,
        });
        return created;
      });

      await this.audit.log({
        actorType,
        adminId,
        operatorId,
        action: auditAction,
        entityType: 'bonus_grant',
        entityId: grant.id,
        newState: auditState ?? { reason, amount, telegramUserId },
      });

      this.metrics.bonusGrantsTotal.inc({ reason: reason.split(':')[0] }); // strip the per-referral suffix off REFERRAL_REFERRER:<id> so the label cardinality stays bounded
      return { granted: true, bonusGrantId: grant.id };
    } catch (e: unknown) {
      if (isUniqueConstraintError(e)) return { granted: false };
      throw e;
    }
  }

  /**
   * Lightweight Sybil/bonus-farming guardrail: refuses one more SIGNUP or
   * REFERRAL_* grant once too many have already paid out today across every
   * account sharing this one's signup IP or device id. Fails open by design
   * at every step (no fingerprint captured, or the setting is 0/disabled ->
   * never blocks) — this is a heuristic tripwire for casual/scripted abuse,
   * not identity verification, and a false positive here only costs one
   * bonus grant, never blocks registration, gameplay, or a withdrawal.
   */
  private async exceedsFingerprintCap(telegramUserId: string, operatorId: string): Promise<boolean> {
    const max = Number((await this.settings.get('MAX_BONUS_GRANTS_PER_FINGERPRINT_PER_DAY', operatorId)) ?? 0);
    if (!max || max <= 0) return false;

    const user = await this.prisma.telegramUser.findUnique({ where: { id: telegramUserId }, select: { signupIp: true, signupDeviceId: true } });
    if (!user || (!user.signupIp && !user.signupDeviceId)) return false;

    const sharing = await this.prisma.telegramUser.findMany({
      where: {
        operatorId,
        OR: [...(user.signupIp ? [{ signupIp: user.signupIp }] : []), ...(user.signupDeviceId ? [{ signupDeviceId: user.signupDeviceId }] : [])],
      },
      select: { id: true },
    });
    const sharedIds = sharing.map((u) => u.id);

    const since = new Date();
    since.setHours(0, 0, 0, 0);

    const countToday = await this.prisma.bonusGrant.count({
      where: {
        telegramUserId: { in: sharedIds },
        createdAt: { gte: since },
        OR: [{ reason: 'SIGNUP' }, { reason: { startsWith: 'REFERRAL_' } }],
      },
    });

    if (countToday < max) return false;

    this.logger.warn(`Bonus fingerprint cap hit: ${sharedIds.length} account(s) sharing signup_ip/signup_device_id, ${countToday} grant(s) today (cap ${max})`);
    const alert = {
      type: 'BONUS_FINGERPRINT_CAP_HIT',
      severity: 'warning' as const,
      title: 'Possible bonus farming detected',
      body: `${sharedIds.length} account(s) sharing a signup IP/device reached ${countToday} signup/referral bonus grant(s) today (cap: ${max}). Latest attempt was refused.`,
      relatedEntityType: 'telegram_user',
      relatedEntityId: telegramUserId,
    };
    await this.notifications.notifyPlatform({ ...alert, operatorId });
    await this.notifications.notifyOperator(operatorId, alert);
    return true;
  }

  /**
   * Audit finding BONUS-1 (Medium): forfeits the un-wagered portion of any
   * `active` grant past its `expiresAt`. `bonusBalance` is a single pooled
   * total across every grant a user has (not tracked per-grant) — this is a
   * pre-existing simplification in this codebase, not something introduced
   * here. Forfeiting the LESSER of (a) this grant's original amount and (b)
   * the user's current pooled bonusBalance is therefore a deliberately
   * conservative approximation: it can never take more than the user
   * actually has, and never double-forfeits across multiple expiring grants
   * in the same tick because each iteration re-reads the live balance inside
   * its own transaction. A precise per-grant sub-ledger would require a
   * larger schema change (splitting bonusBalance into per-grant rows) — worth
   * revisiting if the business needs exact per-grant accounting, flagged
   * here rather than silently assumed.
   */
  @Cron('0 * * * *') // hourly — expiry is a coarse, low-frequency event, no need for the game cron's 4s cadence
  async expireStaleBonuses(): Promise<void> {
    const stale = await this.prisma.bonusGrant.findMany({
      where: { status: 'active', expiresAt: { lt: new Date() } },
    });

    for (const grant of stale) {
      try {
        await this.prisma.$transaction(async (tx) => {
          await setTenantOnTx(tx, grant.operatorId);
          const locked = await this.wallet.lockUserForUpdate(tx, grant.telegramUserId);
          const forfeit = Math.min(Number(grant.amount), Number(locked.bonus_balance));

          await tx.bonusGrant.update({ where: { id: grant.id }, data: { status: 'expired' } });

          if (forfeit > 0) {
            await tx.telegramUser.update({ where: { id: grant.telegramUserId }, data: { bonusBalance: { decrement: forfeit } } });
            await this.wallet.writeEntry(tx, {
              telegramUserId: grant.telegramUserId,
              operatorId: grant.operatorId,
              entryType: 'BONUS_EXPIRED',
              direction: 'debit',
              amount: forfeit,
              relatedEntityType: 'bonus_grant',
              relatedEntityId: grant.id,
              note: `Bonus expired unwagered (reason: ${grant.reason})`,
            });
          }
        });

        await this.audit.log({
          actorType: 'system',
          operatorId: grant.operatorId,
          action: 'BONUS_EXPIRED',
          entityType: 'bonus_grant',
          entityId: grant.id,
          previousState: { status: 'active' },
          newState: { status: 'expired' },
        });
      } catch {
        // One bad grant must never block the rest of the batch — it'll be
        // retried on the next hourly tick since it's still `active`+past-due.
      }
    }
  }
}

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

const OLD_WITHDRAWAL_HOURS = 24;
const LARGE_WITHDRAWAL_THRESHOLD_ETB = 5000;

/**
 * Financial alerts, persisted (spec §16: "Do not rely only on browser
 * notifications... Store alerts in the database so they remain auditable").
 * Detection runs on the same cron infrastructure as the number-caller
 * (GamesService) — a fixed interval, not a request-triggered check, so
 * alerts fire even if no admin is looking at the dashboard.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('0 * * * * *') // once a minute — alerts are advisory, not latency-critical
  async detect(): Promise<void> {
    try {
      await this.detectOldUnpaidWithdrawals();
      await this.detectLargeWithdrawals();
    } catch (e) {
      this.logger.error('Alert detection failed', e instanceof Error ? e.stack : String(e));
    }
  }

  private async raise(
    type: 'OLD_UNPAID_WITHDRAWAL' | 'LARGE_WITHDRAWAL' | 'LEDGER_WALLET_MISMATCH',
    message: string,
    severity: 'info' | 'warning' | 'critical',
    entityType: string,
    entityId: string,
    operatorId: string,
  ): Promise<boolean> {
    try {
      await this.prisma.financialAlert.create({
        data: { type, message, severity, relatedEntityType: entityType, relatedEntityId: entityId, operatorId },
      });
      return true;
    } catch (e: unknown) {
      // Unique constraint = already raised for this exact entity — expected, not an error.
      if (!(e instanceof Object && 'code' in e && (e as { code: string }).code === 'P2002')) throw e;
      return false;
    }
  }

  private async detectOldUnpaidWithdrawals() {
    const cutoff = new Date(Date.now() - OLD_WITHDRAWAL_HOURS * 60 * 60 * 1000);
    const overdue = await this.prisma.withdrawalRequest.findMany({
      where: { status: 'approved', requestedAt: { lt: cutoff } },
      include: { user: { select: { telegramUserId: true } } },
    });
    for (const w of overdue) {
      await this.raise(
        'OLD_UNPAID_WITHDRAWAL',
        `Withdrawal of ${w.amount} ETB for player ${w.user.telegramUserId} has been approved but unpaid for over ${OLD_WITHDRAWAL_HOURS}h`,
        'warning',
        'withdrawal_request',
        w.id,
        w.operatorId,
      );
    }
  }

  private async detectLargeWithdrawals() {
    const large = await this.prisma.withdrawalRequest.findMany({
      where: { status: 'pending', amount: { gte: LARGE_WITHDRAWAL_THRESHOLD_ETB } },
      include: { user: { select: { telegramUserId: true } } },
    });
    for (const w of large) {
      const isNew = await this.raise(
        'LARGE_WITHDRAWAL',
        `Large withdrawal request: ${w.amount} ETB by player ${w.user.telegramUserId}`,
        'warning',
        'withdrawal_request',
        w.id,
        w.operatorId,
      );
      if (isNew) {
        const n = {
          type: 'LARGE_WITHDRAWAL',
          severity: 'warning' as const,
          title: `Large withdrawal request: ${w.amount} ETB`,
          body: `Player ${w.user.telegramUserId}`,
          relatedEntityType: 'withdrawal_request',
          relatedEntityId: w.id,
        };
        await this.notifications.notifyPlatform({ ...n, operatorId: w.operatorId });
        await this.notifications.notifyOperator(w.operatorId, n);
      }
    }
  }

  /** `scope` = the admin's operator filter; null = every operator (platform admin). */
  async list(includeAcknowledged: boolean, scope: string | null) {
    return this.prisma.financialAlert.findMany({
      where: { ...(includeAcknowledged ? {} : { acknowledgedAt: null }), ...(scope ? { operatorId: scope } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { operator: { select: { slug: true } } },
    });
  }

  async acknowledge(alertId: string, adminId: string, scope: string | null) {
    // Scope in the WHERE clause: an operator-bound admin can't acknowledge another operator's alert.
    const result = await this.prisma.financialAlert.updateMany({
      where: { id: alertId, ...(scope ? { operatorId: scope } : {}) },
      data: { acknowledgedAt: new Date(), acknowledgedByAdminId: adminId },
    });
    if (result.count === 0) throw new NotFoundException('Alert not found');
    const alert = await this.prisma.financialAlert.findUniqueOrThrow({ where: { id: alertId } });
    await this.audit.log({
      actorType: 'admin',
      adminId,
      operatorId: alert.operatorId,
      action: 'FINANCIAL_ALERT_ACKNOWLEDGED',
      entityType: 'financial_alert',
      entityId: alertId,
    });
    return alert;
  }
}

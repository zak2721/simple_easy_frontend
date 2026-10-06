import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService, escapeTelegramHtml } from '../telegram/telegram.service';
import { DEFAULT_OPERATOR_ID } from '../common/operator.constants';
import type { RequestAdmin } from '../common/decorators/current-user.decorator';

export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface NotificationInput {
  type: string;
  title: string;
  body?: string;
  severity?: NotificationSeverity;
  /** The operator the event concerns (shown to the Super Admin as context). */
  operatorId?: string | null;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

/**
 * In-app notifications, stored (not just pushed) so they stay reviewable.
 * "platform" notifications go to the Super Admin / platform admins;
 * "operator" notifications go to that operator's own admins.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
  ) {}

  /** Never throws: a failed notification must not undo or block the action that triggered it. */
  async notifyPlatform(input: NotificationInput): Promise<void> {
    await this.write('platform', input);
  }

  async notifyOperator(operatorId: string, input: Omit<NotificationInput, 'operatorId'>): Promise<void> {
    await this.write('operator', { ...input, operatorId });
  }

  private async write(audience: 'platform' | 'operator', input: NotificationInput) {
    try {
      await this.prisma.notification.create({
        data: {
          audience,
          operatorId: input.operatorId ?? null,
          type: input.type,
          severity: input.severity ?? 'info',
          title: input.title.slice(0, 200),
          body: input.body?.slice(0, 2000),
          relatedEntityType: input.relatedEntityType,
          relatedEntityId: input.relatedEntityId,
        },
      });
    } catch (e) {
      this.logger.error(`Could not store ${audience} notification ${input.type}`, e instanceof Error ? e.message : String(e));
    }

    // Push warning/critical events to any admin who opted in — on top of, never instead of, the in-app row above.
    if ((input.severity ?? 'info') !== 'info') {
      await this.pushTelegram(audience, input).catch((e) => this.logger.error(`Telegram push failed for ${input.type}`, e instanceof Error ? e.message : String(e)));
    }
  }

  private async pushTelegram(audience: 'platform' | 'operator', input: NotificationInput): Promise<void> {
    const recipients = await this.prisma.adminUser.findMany({
      where:
        audience === 'platform'
          ? { role: { in: ['SUPER_ADMIN', 'ADMIN'] }, status: 'active', telegramAlertChatId: { not: null } }
          : { operatorId: input.operatorId, status: 'active', telegramAlertChatId: { not: null } },
      select: { telegramAlertChatId: true },
    });
    if (recipients.length === 0) return;

    const badge = input.severity === 'critical' ? '\u{1F534} CRITICAL' : '\u{1F7E0} Warning';
    const text = `<b>${badge}: ${escapeTelegramHtml(input.title)}</b>${input.body ? `\n${escapeTelegramHtml(input.body)}` : ''}`;
    // Operator alerts go out through that operator's own bot; platform alerts have no single operator, so they use the platform's default bot.
    const botOperatorId = audience === 'operator' ? input.operatorId! : DEFAULT_OPERATOR_ID;
    await Promise.all(recipients.map((r) => this.telegram.sendMessage(botOperatorId, r.telegramAlertChatId!, text)));
  }

  /** What this admin may see: platform admins get the platform feed (optionally one operator); operator admins get their operator's feed. */
  private feedWhere(admin: RequestAdmin, operatorFilter?: string) {
    if (admin.operatorId) return { audience: 'operator', operatorId: admin.operatorId };
    return { audience: 'platform', ...(operatorFilter ? { operatorId: operatorFilter } : {}) };
  }

  async list(admin: RequestAdmin, params: { unreadOnly?: boolean; operatorId?: string; limit?: number }) {
    const where = { ...this.feedWhere(admin, params.operatorId), ...(params.unreadOnly ? { readAt: null } : {}) };
    const [items, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(params.limit ?? 100, 500),
        include: { operator: { select: { slug: true } } },
      }),
      this.prisma.notification.count({ where: { ...this.feedWhere(admin, params.operatorId), readAt: null } }),
    ]);
    return { unread, items };
  }

  async markRead(admin: RequestAdmin, id: string) {
    const result = await this.prisma.notification.updateMany({
      where: { id, ...this.feedWhere(admin), readAt: null },
      data: { readAt: new Date(), readByAdminId: admin.adminId },
    });
    if (result.count === 0) {
      const exists = await this.prisma.notification.count({ where: { id, ...this.feedWhere(admin) } });
      if (!exists) throw new NotFoundException('Notification not found');
    }
    return { success: true };
  }

  async markAllRead(admin: RequestAdmin) {
    const result = await this.prisma.notification.updateMany({
      where: { ...this.feedWhere(admin), readAt: null },
      data: { readAt: new Date(), readByAdminId: admin.adminId },
    });
    return { marked: result.count };
  }
}

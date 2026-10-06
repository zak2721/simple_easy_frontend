import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationsService } from './notifications.service';
import { DEFAULT_OPERATOR_ID } from '../common/operator.constants';

describe('NotificationsService Telegram push', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let telegram: { sendMessage: ReturnType<typeof vi.fn> };
  let service: NotificationsService;

  beforeEach(() => {
    prisma = {
      notification: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
      adminUser: { findMany: vi.fn().mockResolvedValue([]) },
    };
    telegram = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    service = new NotificationsService(prisma, telegram as never);
  });

  it('an info-severity notification never triggers a Telegram lookup', async () => {
    await service.notifyPlatform({ type: 'X', title: 'hello' });
    expect(prisma.adminUser.findMany).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('a warning pushes to every opted-in platform admin, via the default operator bot', async () => {
    prisma.adminUser.findMany.mockResolvedValue([{ telegramAlertChatId: '111' }, { telegramAlertChatId: '222' }]);
    await service.notifyPlatform({ type: 'ADMIN_ACCOUNT_LOCKED', title: 'boss locked', severity: 'warning' });

    expect(prisma.adminUser.findMany).toHaveBeenCalledWith({
      where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] }, status: 'active', telegramAlertChatId: { not: null } },
      select: { telegramAlertChatId: true },
    });
    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
    expect(telegram.sendMessage).toHaveBeenCalledWith(DEFAULT_OPERATOR_ID, '111', expect.stringContaining('Warning'));
    expect(telegram.sendMessage).toHaveBeenCalledWith(DEFAULT_OPERATOR_ID, '222', expect.stringContaining('boss locked'));
  });

  it('a critical operator alert pushes through that operator\'s own bot, to that operator\'s opted-in admins only', async () => {
    prisma.adminUser.findMany.mockResolvedValue([{ telegramAlertChatId: '333' }]);
    await service.notifyOperator('op-1', { type: 'SUSPICIOUS_ACTIVITY', title: 'reuse detected', severity: 'critical' });

    expect(prisma.adminUser.findMany).toHaveBeenCalledWith({
      where: { operatorId: 'op-1', status: 'active', telegramAlertChatId: { not: null } },
      select: { telegramAlertChatId: true },
    });
    expect(telegram.sendMessage).toHaveBeenCalledWith('op-1', '333', expect.stringContaining('CRITICAL'));
  });

  it('HTML-escapes the title and body before sending', async () => {
    prisma.adminUser.findMany.mockResolvedValue([{ telegramAlertChatId: '111' }]);
    await service.notifyPlatform({ type: 'X', title: '<b>hi</b>', body: 'a & b', severity: 'warning' });
    const text = telegram.sendMessage.mock.calls[0][2];
    expect(text).not.toContain('<b>hi</b>');
    expect(text).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(text).toContain('a &amp; b');
  });

  it('no opted-in admins means no Telegram call at all, and no error', async () => {
    prisma.adminUser.findMany.mockResolvedValue([]);
    await expect(service.notifyPlatform({ type: 'X', title: 'hi', severity: 'critical' })).resolves.toBeUndefined();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('a Telegram failure never throws out of notifyPlatform/notifyOperator (best-effort)', async () => {
    prisma.adminUser.findMany.mockResolvedValue([{ telegramAlertChatId: '111' }]);
    telegram.sendMessage.mockRejectedValue(new Error('network down'));
    await expect(service.notifyPlatform({ type: 'X', title: 'hi', severity: 'critical' })).resolves.toBeUndefined();
  });
});

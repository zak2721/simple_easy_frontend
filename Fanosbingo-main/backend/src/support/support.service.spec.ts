import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SupportService } from './support.service';

describe('SupportService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let notifications: { notifyOperator: ReturnType<typeof vi.fn> };
  let service: SupportService;

  beforeEach(() => {
    prisma = {
      $transaction: vi.fn(async (arg) => (Array.isArray(arg) ? Promise.all(arg) : arg(prisma))),
      supportTicket: {
        create: vi.fn().mockResolvedValue({ id: 't1', operatorId: 'op-1', telegramUserId: 'u1', status: 'open' }),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
      },
      supportTicketMessage: { create: vi.fn().mockResolvedValue({ id: 'm1' }) },
      adminUser: { findFirst: vi.fn() },
      $executeRaw: vi.fn(),
    };
    notifications = { notifyOperator: vi.fn() };
    service = new SupportService(prisma, { log: vi.fn() } as never, notifications as never);
  });

  it('creating a ticket writes the ticket and its first message under the same operator, and notifies that operator', async () => {
    prisma.supportTicket.findFirst.mockResolvedValue({ id: 't1', telegramUserId: 'u1', messages: [] });
    await service.create('u1', 'op-1', 'Deposit not credited', 'I paid but no balance');
    expect(prisma.supportTicket.create).toHaveBeenCalledWith({ data: { operatorId: 'op-1', telegramUserId: 'u1', subject: 'Deposit not credited' } });
    expect(prisma.supportTicketMessage.create).toHaveBeenCalledWith({ data: { ticketId: 't1', authorType: 'player', authorId: 'u1', body: 'I paid but no balance' } });
    expect(notifications.notifyOperator).toHaveBeenCalledWith('op-1', expect.objectContaining({ type: 'SUPPORT_TICKET_OPENED' }));
  });

  it("a player cannot reply on someone else's ticket (lookup is pinned to the caller)", async () => {
    prisma.supportTicket.findFirst.mockResolvedValue(null);
    await expect(service.replyAsPlayer('u2', 't1', 'hello')).rejects.toThrow(NotFoundException);
    expect(prisma.supportTicket.findFirst).toHaveBeenCalledWith({ where: { id: 't1', telegramUserId: 'u2' } });
  });

  it('a player cannot reply on a resolved or closed ticket', async () => {
    prisma.supportTicket.findFirst.mockResolvedValue({ id: 't1', status: 'resolved' });
    await expect(service.replyAsPlayer('u1', 't1', 'still broken')).rejects.toThrow(ForbiddenException);
    prisma.supportTicket.findFirst.mockResolvedValue({ id: 't1', status: 'closed' });
    await expect(service.replyAsPlayer('u1', 't1', 'still broken')).rejects.toThrow(ForbiddenException);
  });

  it('a player reply on a pending ticket moves it back to open', async () => {
    prisma.supportTicket.findFirst.mockResolvedValue({ id: 't1', status: 'pending' });
    await service.replyAsPlayer('u1', 't1', 'more info');
    expect(prisma.supportTicket.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { lastMessageAt: expect.any(Date), status: 'open' } });
  });

  it('an admin reply on an open ticket moves it to pending (awaiting the player)', async () => {
    prisma.supportTicket.findFirst.mockResolvedValue({ id: 't1', operatorId: 'op-1', status: 'open' });
    await service.replyAsAdmin('admin1', 'op-1', 't1', 'we are checking');
    expect(prisma.supportTicket.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { lastMessageAt: expect.any(Date), status: 'pending' } });
  });

  it("an operator's admin cannot reach another operator's ticket", async () => {
    prisma.supportTicket.findFirst.mockResolvedValue(null);
    await expect(service.replyAsAdmin('admin1', 'op-2', 't1', 'x')).rejects.toThrow(NotFoundException);
    expect(prisma.supportTicket.findFirst).toHaveBeenCalledWith({ where: { id: 't1', operatorId: 'op-2' } });
  });

  it('assigning to an admin of a different operator is refused', async () => {
    prisma.supportTicket.findFirst.mockResolvedValue({ id: 't1', operatorId: 'op-1', status: 'open' });
    prisma.adminUser.findFirst.mockResolvedValue(null); // no match for (id, operatorId)
    await expect(service.assign('owner1', 'op-1', 't1', 'admin-of-op-2')).rejects.toThrow('does not belong to this operator');
  });

  it('rejects an empty or oversized message', async () => {
    prisma.supportTicket.findFirst.mockResolvedValue({ id: 't1', status: 'open' });
    await expect(service.replyAsPlayer('u1', 't1', '   ')).rejects.toThrow();
    await expect(service.replyAsPlayer('u1', 't1', 'x'.repeat(4001))).rejects.toThrow();
  });
});

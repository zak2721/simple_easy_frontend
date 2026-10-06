import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';

describe('ApprovalsService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let settings: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
  let branding: { snapshot: ReturnType<typeof vi.fn>; applyName: ReturnType<typeof vi.fn> };
  let rooms: { getRoom: ReturnType<typeof vi.fn>; setCapacity: ReturnType<typeof vi.fn>; createRoom: ReturnType<typeof vi.fn> };
  let notifications: { notifyPlatform: ReturnType<typeof vi.fn>; notifyOperator: ReturnType<typeof vi.fn> };
  let audit: { log: ReturnType<typeof vi.fn> };
  let service: ApprovalsService;

  const pending = (over: Record<string, unknown> = {}) => ({
    id: 'req-1',
    operatorId: 'op-1',
    type: 'SETTING_CHANGE',
    targetKey: 'SIGNUP_BONUS_ETB',
    currentValue: { value: '30' },
    proposedValue: { key: 'SIGNUP_BONUS_ETB', value: '50' },
    status: 'pending',
    reviewedByAdminId: null,
    ...over,
  });

  beforeEach(() => {
    const tx = {
      approvalRequest: { updateMany: vi.fn(), create: vi.fn(async ({ data }) => ({ id: 'req-new', status: 'pending', ...data })) },
      $executeRaw: vi.fn(),
    };
    prisma = {
      $transaction: vi.fn(async (cb) => cb(tx)),
      _tx: tx,
      approvalRequest: { findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn(), findMany: vi.fn() },
      operator: { findUnique: vi.fn().mockResolvedValue({ slug: 'abebe' }) },
      theme: { findUnique: vi.fn() },
      operatorRoom: { findUnique: vi.fn() },
    };
    settings = { get: vi.fn().mockResolvedValue('30'), set: vi.fn() };
    branding = { snapshot: vi.fn().mockResolvedValue({ displayName: 'Abebe', logoUrl: null, themeId: null }), applyName: vi.fn() };
    rooms = { getRoom: vi.fn().mockResolvedValue({ id: 'room-1', capacity: 100 }), setCapacity: vi.fn(), createRoom: vi.fn() };
    notifications = { notifyPlatform: vi.fn(), notifyOperator: vi.fn() };
    audit = { log: vi.fn() };
    service = new ApprovalsService(prisma, audit as never, settings as never, notifications as never, branding as never, rooms as never);
  });

  describe('submit', () => {
    it('stores a pending request with the live value snapshot, supersedes older pending ones, and notifies the Super Admin', async () => {
      const r = await service.submit('staff-1', 'op-1', 'SETTING_CHANGE', 'SIGNUP_BONUS_ETB', { value: '50' });
      expect(prisma._tx.approvalRequest.updateMany).toHaveBeenCalledWith({
        where: { operatorId: 'op-1', type: 'SETTING_CHANGE', targetKey: 'SIGNUP_BONUS_ETB', status: 'pending' },
        data: { status: 'superseded', reviewNote: 'Replaced by a newer request' },
      });
      expect(prisma._tx.approvalRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ currentValue: { value: '30' }, proposedValue: { key: 'SIGNUP_BONUS_ETB', value: '50' } }),
      });
      expect(r.pendingApproval).toBe(true);
      expect(notifications.notifyPlatform).toHaveBeenCalledWith(expect.objectContaining({ type: 'APPROVAL_PENDING', operatorId: 'op-1' }));
      expect(settings.set).not.toHaveBeenCalled(); // nothing applied yet
    });

    it('refuses a "change" to the value already in force', async () => {
      await expect(service.submit('s', 'op-1', 'SETTING_CHANGE', 'SIGNUP_BONUS_ETB', { value: '30' })).rejects.toThrow('already the current value');
    });

    it('validates the proposal (non-numeric bonus amount, unknown key)', async () => {
      await expect(service.submit('s', 'op-1', 'SETTING_CHANGE', 'SIGNUP_BONUS_ETB', { value: 'lots' })).rejects.toThrow(BadRequestException);
      await expect(service.submit('s', 'op-1', 'SETTING_CHANGE', 'TELEBIRR_ACCOUNT_NUMBER', { value: '1' })).rejects.toThrow(BadRequestException);
    });

    it('a capacity "increase" must actually increase', async () => {
      await expect(service.submit('s', 'op-1', 'ROOM_CAPACITY_INCREASE', 'room-1', { capacity: 80 })).rejects.toThrow(BadRequestException);
    });
  });

  describe('approve', () => {
    it('applies through the same service method a direct change uses, then records the decision and tells the operator', async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue(pending());
      await service.approve('super', 'req-1');
      expect(settings.set).toHaveBeenCalledWith('SIGNUP_BONUS_ETB', '50', 'super', 'op-1');
      expect(prisma.approvalRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: expect.objectContaining({ status: 'approved', reviewedByAdminId: 'super', appliedAt: expect.any(Date) }),
      });
      expect(notifications.notifyOperator).toHaveBeenCalledWith('op-1', expect.objectContaining({ type: 'APPROVAL_APPROVED' }));
    });

    it('refuses to apply a stale request (live value changed since submission) and rejects it', async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue(pending());
      settings.get.mockResolvedValue('40'); // someone changed it in the meantime
      await expect(service.approve('super', 'req-1')).rejects.toThrow(ConflictException);
      expect(settings.set).not.toHaveBeenCalled();
      expect(prisma.approvalRequest.update).toHaveBeenCalledWith({ where: { id: 'req-1' }, data: expect.objectContaining({ status: 'rejected' }) });
    });

    it('two reviewers cannot both apply it: the loser of the claim gets a conflict and applies nothing', async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue(pending());
      prisma.approvalRequest.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.approve('super-2', 'req-1')).rejects.toThrow('Another reviewer');
      expect(settings.set).not.toHaveBeenCalled();
    });

    it('if applying fails (e.g. a limit), the claim is released and the request stays pending', async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue(
        pending({ type: 'ROOM_CAPACITY_INCREASE', targetKey: 'room-1', currentValue: { capacity: 100 }, proposedValue: { capacity: 5000 } }),
      );
      rooms.setCapacity.mockRejectedValue(new BadRequestException('over the limit'));
      await expect(service.approve('super', 'req-1')).rejects.toThrow('over the limit');
      expect(prisma.approvalRequest.updateMany).toHaveBeenLastCalledWith({ where: { id: 'req-1', status: 'pending' }, data: { reviewedByAdminId: null } });
      expect(prisma.approvalRequest.update).not.toHaveBeenCalled();
    });

    it('an already-decided request cannot be approved', async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue(pending({ status: 'rejected' }));
      await expect(service.approve('super', 'req-1')).rejects.toThrow('already rejected');
    });
  });

  it('reject requires a reason and tells the operator', async () => {
    prisma.approvalRequest.findUnique.mockResolvedValue(pending());
    await expect(service.reject('super', 'req-1', '')).rejects.toThrow('reason is required');
    await service.reject('super', 'req-1', 'Too generous');
    expect(notifications.notifyOperator).toHaveBeenCalledWith('op-1', expect.objectContaining({ type: 'APPROVAL_REJECTED', body: 'Reason: Too generous' }));
  });

  it("an operator can only cancel its own pending request", async () => {
    prisma.approvalRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.cancel('owner-b', 'op-2', 'req-1')).rejects.toThrow('No pending request');
    expect(prisma.approvalRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'req-1', operatorId: 'op-2', status: 'pending' },
      data: expect.objectContaining({ status: 'cancelled' }),
    });
  });
});

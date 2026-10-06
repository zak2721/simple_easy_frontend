import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { StaffService } from './staff.service';
import type { RequestAdmin } from '../common/decorators/current-user.decorator';
import { OPERATOR_PERMISSIONS } from '../common/rbac.constants';

const owner: RequestAdmin = { adminId: 'owner1', sessionId: 's', username: 'o', fullName: 'O', roles: ['OPERATOR_OWNER'], permissions: [...OPERATOR_PERMISSIONS], operatorId: 'op-1', totpEnabled: false, impersonatedByAdminId: null, telegramAlertChatId: null };
const depositManager: RequestAdmin = { ...owner, adminId: 'dm1', roles: ['OPERATOR_STAFF'], permissions: ['MANAGE_STAFF', 'VIEW_DEPOSITS', 'APPROVE_DEPOSITS'] };

describe('StaffService delegation rules', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let service: StaffService;
  let notifications: { notifyPlatform: ReturnType<typeof vi.fn> };
  let limits: { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    const tx = {
      adminUser: { create: vi.fn(async ({ data }) => ({ id: 'new-staff', ...data })) },
      permission: { findMany: vi.fn(async ({ where }) => where.key.in.map((key: string) => ({ id: `p-${key}`, key }))) },
      adminPermission: { createMany: vi.fn() },
      $executeRaw: vi.fn(),
    };
    prisma = {
      $transaction: vi.fn(async (arg) => (typeof arg === 'function' ? arg(tx) : Promise.all(arg))),
      adminUser: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn().mockResolvedValue(0) },
      adminPermission: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn(), createMany: vi.fn() },
      permission: { findMany: vi.fn().mockResolvedValue([]) },
      adminSession: { updateMany: vi.fn() },
      adminRefreshToken: { updateMany: vi.fn() },
      $executeRaw: vi.fn(),
      _tx: tx,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    notifications = { notifyPlatform: vi.fn() };
    limits = { get: vi.fn().mockResolvedValue({ MAX_STAFF: 20 }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new StaffService(prisma, { log: vi.fn() } as any, { hash: vi.fn().mockResolvedValue('$argon2id$h') } as any, limits as any, notifications as any);
  });

  const newStaff = (permissions: string[]) => ({ username: 'agent1', password: 'long-enough-pw', fullName: 'Agent', permissions });

  it('owner can create staff with operator permissions; the account is OPERATOR_STAFF in the owner\'s operator', async () => {
    const r = await service.create(owner, 'op-1', newStaff(['VIEW_DEPOSITS', 'APPROVE_DEPOSITS']));
    expect(prisma._tx.adminUser.create).toHaveBeenCalledWith({ data: expect.objectContaining({ role: 'OPERATOR_STAFF', operatorId: 'op-1' }) });
    expect(r.permissions).toEqual(['VIEW_DEPOSITS', 'APPROVE_DEPOSITS']);
    expect(notifications.notifyPlatform).toHaveBeenCalledWith(expect.objectContaining({ type: 'STAFF_CREATED', operatorId: 'op-1' }));
  });

  it('refuses a new staff account once the operator reaches its MAX_STAFF limit', async () => {
    limits.get.mockResolvedValue({ MAX_STAFF: 2 });
    prisma.adminUser.count.mockResolvedValue(2);
    await expect(service.create(owner, 'op-1', newStaff(['VIEW_DEPOSITS']))).rejects.toThrow('at most 2 staff');
    expect(prisma._tx.adminUser.create).not.toHaveBeenCalled();
  });

  it('refuses platform-only permissions for staff, even from the owner', async () => {
    await expect(service.create(owner, 'op-1', newStaff(['ADJUST_WALLET']))).rejects.toThrow(ForbiddenException);
    await expect(service.create(owner, 'op-1', newStaff(['MANAGE_OPERATORS']))).rejects.toThrow(ForbiddenException);
    expect(prisma._tx.adminUser.create).not.toHaveBeenCalled();
  });

  it('a staff manager can only grant permissions it holds itself', async () => {
    await expect(service.create(depositManager, 'op-1', newStaff(['APPROVE_WITHDRAWALS']))).rejects.toThrow('only grant permissions you hold');
    await expect(service.create(depositManager, 'op-1', newStaff(['VIEW_DEPOSITS']))).resolves.toBeDefined();
  });

  it('the owner account cannot be managed through the staff routes', async () => {
    prisma.adminUser.findFirst.mockResolvedValue({ id: 'owner2', role: 'OPERATOR_OWNER', operatorId: 'op-1' });
    await expect(service.setStatus(depositManager, 'op-1', 'owner2', 'suspended')).rejects.toThrow(ForbiddenException);
    expect(prisma.adminUser.update).not.toHaveBeenCalled();
  });

  it('nobody can act on their own account here', async () => {
    await expect(service.setStatus(owner, 'op-1', 'owner1', 'disabled')).rejects.toThrow('your own account');
  });

  it("a staff id from another operator is not found (lookup is pinned to the caller's operator)", async () => {
    prisma.adminUser.findFirst.mockResolvedValue(null);
    await expect(service.resetPassword(owner, 'op-1', 'staff-of-op-2', 'new-password-123')).rejects.toThrow(NotFoundException);
    expect(prisma.adminUser.findFirst).toHaveBeenCalledWith({ where: { id: 'staff-of-op-2', operatorId: 'op-1' } });
  });

  it('suspending staff revokes their sessions and refresh tokens immediately', async () => {
    prisma.adminUser.findFirst.mockResolvedValue({ id: 'st1', role: 'OPERATOR_STAFF', operatorId: 'op-1', status: 'active' });
    await service.setStatus(owner, 'op-1', 'st1', 'suspended');
    expect(prisma.adminSession.updateMany).toHaveBeenCalledWith({ where: { adminId: 'st1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(prisma.adminRefreshToken.updateMany).toHaveBeenCalledWith({ where: { adminId: 'st1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
  });
});

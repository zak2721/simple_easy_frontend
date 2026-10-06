import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditService } from './audit.service';
import { runWithTenant } from '../common/tenant/tenant-context';

/**
 * Production Readiness Audit (Medium): an audit row's adminId is the
 * IMPERSONATED target for every ordinary action during a Super Admin
 * "viewing as" session — the real actor was only ever recorded on the
 * IMPERSONATION_STARTED/ENDED rows themselves. These tests cover the fix:
 * log() now stamps the real actor onto every row, sourced from
 * AsyncLocalStorage (set once per request by TenantContextInterceptor) so
 * none of its ~100 call sites needed to change.
 */
describe('AuditService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let service: AuditService;

  beforeEach(() => {
    prisma = {
      adminUser: { findUnique: vi.fn().mockResolvedValue({ username: 'target-admin' }), findMany: vi.fn() },
      auditLog: { create: vi.fn(), findMany: vi.fn() },
    };
    service = new AuditService(prisma);
  });

  describe('log', () => {
    it('stamps impersonatedByAdminId from the ambient request context when not passed explicitly', async () => {
      await runWithTenant('op-1', 'super-admin-1', async () => {
        await service.log({ actorType: 'admin', adminId: 'target-admin-id', action: 'DEPOSIT_APPROVED', entityType: 'deposit', entityId: 'd1' });
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ adminId: 'target-admin-id', impersonatedByAdminId: 'super-admin-1' }) }),
      );
    });

    it('leaves impersonatedByAdminId null outside any impersonation context', async () => {
      await service.log({ actorType: 'admin', adminId: 'admin-1', action: 'DEPOSIT_APPROVED', entityType: 'deposit', entityId: 'd1' });

      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ impersonatedByAdminId: null }) }));
    });

    it('an explicit impersonatedByAdminId (including null) overrides the ambient context', async () => {
      await runWithTenant('op-1', 'super-admin-1', async () => {
        await service.log({ actorType: 'admin', adminId: 'super-admin-1', action: 'IMPERSONATION_STARTED', entityType: 'admin_user', entityId: 'target-admin-id', impersonatedByAdminId: null });
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ impersonatedByAdminId: null }) }));
    });
  });

  describe('list', () => {
    it('resolves impersonatedByUsername for rows with an impersonator, in one batched lookup, and leaves it null otherwise', async () => {
      prisma.auditLog.findMany.mockResolvedValue([
        { id: '1', adminId: 'a1', impersonatedByAdminId: 'super-1', operator: null },
        { id: '2', adminId: 'a2', impersonatedByAdminId: 'super-1', operator: null },
        { id: '3', adminId: 'a3', impersonatedByAdminId: null, operator: null },
      ]);
      prisma.adminUser.findMany.mockResolvedValue([{ id: 'super-1', username: 'boss' }]);

      const rows = await service.list();

      expect(prisma.adminUser.findMany).toHaveBeenCalledTimes(1); // batched, not once per row
      expect(rows[0].impersonatedByUsername).toBe('boss');
      expect(rows[1].impersonatedByUsername).toBe('boss');
      expect(rows[2].impersonatedByUsername).toBeNull();
    });

    it('skips the lookup entirely when no row was impersonated', async () => {
      prisma.auditLog.findMany.mockResolvedValue([{ id: '1', adminId: 'a1', impersonatedByAdminId: null, operator: null }]);

      const rows = await service.list();

      expect(prisma.adminUser.findMany).not.toHaveBeenCalled();
      expect(rows[0].impersonatedByUsername).toBeNull();
    });
  });
});

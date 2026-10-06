import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from '../auth/password.service';
import { isOperatorPermission, type PermissionKey } from '../common/rbac.constants';
import { setTenantOnTx, tenantSetConfigOp } from '../common/tenant/rls';

/**
 * Admin CRUD + direct per-admin permission grants. Every mutating method
 * takes `actingAdminId` so self-protection rules can be enforced here, not
 * just documented:
 *   - an admin can never act on themselves through this service
 *     (no self-suspend, no self-delete, no self-permission-edit)
 *   - the Super Admin account can never be suspended, disabled, or deleted —
 *     there is exactly one, ever (enforced at creation in AuthService —
 *     bootstrap is the only path to SUPER_ADMIN, and only runs once), so
 *     "protect the last one" simplifies to "protect the only one".
 * Every method here is reached only via SuperAdminGuard-protected routes —
 * regular ADMIN accounts cannot call any of this regardless of what
 * permissions they hold, matching the spec's explicit "Admins cannot create
 * other admins / assign permissions / modify their own permissions".
 */
@Injectable()
export class AdminManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
  ) {}

  async list() {
    const admins = await this.prisma.adminUser.findMany({
      include: { permissions: { include: { permission: true } }, operator: { select: { slug: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return admins.map((a) => ({
      id: a.id,
      username: a.username,
      fullName: a.fullName,
      role: a.role,
      status: a.status,
      operatorId: a.operatorId,
      operatorSlug: a.operator?.slug ?? null,
      lockedUntil: a.lockedUntil,
      failedLoginCount: a.failedLoginCount,
      totpEnabled: a.totpEnabled,
      permissions: a.permissions.filter((p) => p.enabled).map((p) => p.permission.key),
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      lastLoginAt: a.lastLoginAt,
    }));
  }

  async get(adminId: string) {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      include: { permissions: { include: { permission: true } } },
    });
    if (!admin) throw new BadRequestException('Admin not found');
    return {
      id: admin.id,
      username: admin.username,
      fullName: admin.fullName,
      role: admin.role,
      status: admin.status,
      totpEnabled: admin.totpEnabled,
      permissions: admin.permissions.map((p) => ({ key: p.permission.key, enabled: p.enabled })),
      createdAt: admin.createdAt,
      lastLoginAt: admin.lastLoginAt,
    };
  }

  /**
   * Creates a new platform ADMIN (never SUPER_ADMIN — bootstrap-only and
   * unique). Operator owners are created with their operator
   * (OperatorManagementService); operator staff by their owner.
   */
  async create(actingAdminId: string, params: { username: string; password: string; fullName: string; permissions: PermissionKey[] }) {
    const passwordHash = await this.passwords.hash(params.password);

    const admin = await this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx, null);
      const created = await tx.adminUser.create({
        data: {
          username: params.username,
          passwordHash,
          passwordChangedAt: new Date(),
          fullName: params.fullName,
          role: 'ADMIN',
          createdByAdminId: actingAdminId,
        },
      });

      if (params.permissions.length > 0) {
        const perms = await tx.permission.findMany({ where: { key: { in: params.permissions } } });
        await tx.adminPermission.createMany({
          data: perms.map((p) => ({ adminId: created.id, permissionId: p.id, grantedByAdminId: actingAdminId })),
        });
      }

      return created;
    });

    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      action: 'ADMIN_CREATED',
      entityType: 'admin',
      entityId: admin.id,
      newState: { username: admin.username, fullName: admin.fullName, permissions: params.permissions },
    });

    return { id: admin.id, username: admin.username, fullName: admin.fullName, role: admin.role };
  }

  async update(actingAdminId: string, targetAdminId: string, params: { fullName: string }) {
    this.assertNotSelf(actingAdminId, targetAdminId, 'edit their own account here');
    const before = await this.getOrThrowAdmin(targetAdminId);
    this.assertNotSuperAdmin(before, 'edited');

    const updated = await this.prisma.adminUser.update({ where: { id: targetAdminId }, data: { fullName: params.fullName } });

    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      action: 'ADMIN_UPDATED',
      entityType: 'admin',
      entityId: targetAdminId,
      previousState: { fullName: before.fullName },
      newState: { fullName: params.fullName },
    });

    return { id: updated.id, username: updated.username, fullName: updated.fullName, role: updated.role, status: updated.status };
  }

  async setStatus(actingAdminId: string, targetAdminId: string, status: 'active' | 'suspended' | 'disabled') {
    this.assertNotSelf(actingAdminId, targetAdminId, 'change their own status');
    const before = await this.getOrThrowAdmin(targetAdminId);
    this.assertNotSuperAdmin(before, 'suspended, disabled, or re-enabled by anyone');

    const updated = await this.prisma.adminUser.update({ where: { id: targetAdminId }, data: { status } });

    // Revoke all active sessions immediately on suspend/disable — rejected
    // immediately, not at next token expiry.
    if (status !== 'active') {
      await this.prisma.adminSession.updateMany({ where: { adminId: targetAdminId, revokedAt: null }, data: { revokedAt: new Date() } });
    }

    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      action: status === 'active' ? 'ADMIN_ENABLED' : status === 'suspended' ? 'ADMIN_SUSPENDED' : 'ADMIN_DISABLED',
      entityType: 'admin',
      entityId: targetAdminId,
      previousState: { status: before.status },
      newState: { status },
    });

    return { id: updated.id, username: updated.username, fullName: updated.fullName, role: updated.role, status: updated.status };
  }

  /** Hard delete — spec explicitly lists "Delete Admin" as an action, distinct from disable. */
  async delete(actingAdminId: string, targetAdminId: string) {
    this.assertNotSelf(actingAdminId, targetAdminId, 'delete their own account');
    const target = await this.getOrThrowAdmin(targetAdminId);
    this.assertNotSuperAdmin(target, 'deleted');
    if (target.role === 'OPERATOR_OWNER') {
      throw new ForbiddenException('An operator owner cannot be deleted — transfer ownership first, or disable the account');
    }

    await this.prisma.adminUser.delete({ where: { id: targetAdminId } });

    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      action: 'ADMIN_DELETED',
      entityType: 'admin',
      entityId: targetAdminId,
      previousState: { username: target.username, fullName: target.fullName },
    });

    return { success: true };
  }

  async resetPassword(actingAdminId: string, targetAdminId: string, newPassword: string) {
    const target = await this.getOrThrowAdmin(targetAdminId);
    this.assertNotSuperAdmin(target, 'have their password reset by another account');

    const passwordHash = await this.passwords.hash(newPassword);
    // A reset also clears any lockout: the account holder gets a working credential.
    await this.prisma.adminUser.update({
      where: { id: targetAdminId },
      data: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    });

    // Force re-login everywhere — a reset password shouldn't leave old sessions valid.
    await this.prisma.adminSession.updateMany({ where: { adminId: targetAdminId, revokedAt: null }, data: { revokedAt: new Date() } });

    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      action: 'ADMIN_PASSWORD_RESET',
      entityType: 'admin',
      entityId: targetAdminId,
      operatorId: target.operatorId,
    });

    return { success: true };
  }

  /** Clears a login lockout (including the permanent one after 20 failures) without changing the password. */
  async unlock(actingAdminId: string, targetAdminId: string) {
    const target = await this.getOrThrowAdmin(targetAdminId);
    await this.prisma.adminUser.update({ where: { id: targetAdminId }, data: { failedLoginCount: 0, lockedUntil: null } });
    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId: target.operatorId,
      action: 'ADMIN_UNLOCKED',
      entityType: 'admin',
      entityId: targetAdminId,
      previousState: { failedLoginCount: target.failedLoginCount, lockedUntil: target.lockedUntil },
    });
    return { success: true };
  }

  /**
   * Recovery path for an admin who lost their authenticator (lost phone,
   * reinstalled the app, ...) and can no longer complete their own 2FA step.
   * Unlike the self-service disable, this needs no password — it's a Super
   * Admin acting on someone else's account, so it's audited accordingly.
   */
  async disableTotpFor(actingAdminId: string, targetAdminId: string) {
    const target = await this.getOrThrowAdmin(targetAdminId);
    await this.prisma.adminUser.update({
      where: { id: targetAdminId },
      data: { totpEnabled: false, totpSecretEncrypted: null, totpVerifiedAt: null, totpLastUsedCounter: null },
    });
    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId: target.operatorId,
      action: 'ADMIN_2FA_FORCE_DISABLED',
      entityType: 'admin',
      entityId: targetAdminId,
    });
    return { success: true };
  }

  /** Replaces an admin's full permission set (spec: "assign one/multiple, remove permissions"). */
  async setPermissions(actingAdminId: string, targetAdminId: string, permissionKeys: PermissionKey[]) {
    this.assertNotSelf(actingAdminId, targetAdminId, 'modify their own permissions');
    const target = await this.getOrThrowAdmin(targetAdminId);
    this.assertNotSuperAdmin(target, 'assigned permissions — the Super Admin is unrestricted by definition');
    this.assertGrantable(target, permissionKeys);

    const before = await this.prisma.adminPermission.findMany({ where: { adminId: targetAdminId }, include: { permission: true } });
    const perms = await this.prisma.permission.findMany({ where: { key: { in: permissionKeys } } });

    await this.prisma.$transaction([
      tenantSetConfigOp(this.prisma, null),
      this.prisma.adminPermission.deleteMany({ where: { adminId: targetAdminId } }),
      this.prisma.adminPermission.createMany({
        data: perms.map((p) => ({ adminId: targetAdminId, permissionId: p.id, grantedByAdminId: actingAdminId })),
      }),
    ]);

    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      action: 'ADMIN_PERMISSIONS_UPDATED',
      entityType: 'admin',
      entityId: targetAdminId,
      previousState: { permissions: before.map((b) => b.permission.key) },
      newState: { permissions: permissionKeys },
    });

    return { permissions: permissionKeys };
  }

  /** Enables/disables a single permission without touching the rest — spec: "Temporarily disable permissions". */
  async togglePermission(actingAdminId: string, targetAdminId: string, permissionKey: PermissionKey, enabled: boolean) {
    this.assertNotSelf(actingAdminId, targetAdminId, 'modify their own permissions');
    const target = await this.getOrThrowAdmin(targetAdminId);
    this.assertNotSuperAdmin(target, 'assigned permissions');
    if (enabled) this.assertGrantable(target, [permissionKey]);

    const permission = await this.prisma.permission.findUnique({ where: { key: permissionKey } });
    if (!permission) throw new BadRequestException(`Unknown permission: ${permissionKey}`);

    await this.prisma.adminPermission.upsert({
      where: { adminId_permissionId: { adminId: targetAdminId, permissionId: permission.id } },
      create: { adminId: targetAdminId, permissionId: permission.id, enabled, grantedByAdminId: actingAdminId },
      update: { enabled },
    });

    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      action: enabled ? 'ADMIN_PERMISSION_ENABLED' : 'ADMIN_PERMISSION_DISABLED',
      entityType: 'admin',
      entityId: targetAdminId,
      newState: { permission: permissionKey, enabled },
    });

    return { permission: permissionKey, enabled };
  }

  async listSessions(adminId: string) {
    return this.prisma.adminSession.findMany({ where: { adminId }, orderBy: { createdAt: 'desc' } });
  }

  async listAllActiveSessions() {
    return this.prisma.adminSession.findMany({
      where: { revokedAt: null, expiresAt: { gt: new Date() } },
      include: { admin: { select: { id: true, username: true, fullName: true, role: true, operatorId: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async revokeSession(actingAdminId: string, sessionId: string) {
    const session = await this.prisma.adminSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    await this.audit.log({ actorType: 'admin', adminId: actingAdminId, action: 'ADMIN_SESSION_REVOKED', entityType: 'admin_session', entityId: sessionId });
    return session;
  }

  async permissionCatalog() {
    return this.prisma.permission.findMany({ orderBy: { key: 'asc' } });
  }

  /** "Check and control all activity of the admin in detail" — per-admin audit trail. */
  async adminActivity(adminId: string, limit = 200) {
    return this.audit.list({ limit, adminId });
  }

  private async getOrThrowAdmin(adminId: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new BadRequestException('Admin not found');
    return admin;
  }

  private assertNotSelf(actingAdminId: string, targetAdminId: string, action: string) {
    if (actingAdminId === targetAdminId) {
      throw new ForbiddenException(`Admins cannot ${action}`);
    }
  }

  /** Owners hold every operator permission implicitly; staff may only hold operator-scoped ones. */
  private assertGrantable(target: { role: string }, keys: string[]) {
    if (target.role === 'OPERATOR_OWNER') {
      throw new ForbiddenException('An operator owner holds every operator permission automatically — nothing to assign');
    }
    if (target.role === 'OPERATOR_STAFF') {
      const platformOnly = keys.filter((k) => !isOperatorPermission(k));
      if (platformOnly.length) throw new ForbiddenException(`Platform-only permission(s) cannot be granted to operator staff: ${platformOnly.join(', ')}`);
    }
  }

  private assertNotSuperAdmin(admin: { role: string }, action: string) {
    if (admin.role === 'SUPER_ADMIN') {
      throw new ForbiddenException(`The Super Admin account cannot be ${action} — it is the platform's highest authority and cannot be overridden`);
    }
  }
}

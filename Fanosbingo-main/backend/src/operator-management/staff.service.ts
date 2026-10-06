import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(12)).map((b) => chars[b % chars.length]).join('');
}
import { AuditService } from '../audit/audit.service';
import { PasswordService } from '../auth/password.service';
import { isOperatorPermission } from '../common/rbac.constants';
import { NotificationsService } from '../notifications/notifications.service';
import { LimitsService } from './limits.service';
import type { RequestAdmin } from '../common/decorators/current-user.decorator';
import { setTenantOnTx, tenantSetConfigOp } from '../common/tenant/rls';

/**
 * Operator staff accounts (Deposit Manager, Support Agent, ...). Managed by
 * the operator's owner, by staff holding MANAGE_STAFF, or by a platform
 * admin acting for the operator. Delegation rule: an actor can only grant
 * operator-scoped permissions it holds itself. Staff can never touch the
 * owner, and nobody can act on their own account here.
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly limits: LimitsService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(operatorId: string) {
    const rows = await this.prisma.adminUser.findMany({
      where: { operatorId },
      include: { permissions: { where: { enabled: true }, include: { permission: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((a) => ({
      id: a.id,
      username: a.username,
      fullName: a.fullName,
      role: a.role,
      status: a.status,
      permissions: a.role === 'OPERATOR_OWNER' ? ['*operator'] : a.permissions.map((p) => p.permission.key),
      lockedUntil: a.lockedUntil,
      lastLoginAt: a.lastLoginAt,
      createdAt: a.createdAt,
    }));
  }

  /** Validates a permission set against the operator scope and the actor's own permissions. */
  private assertGrantable(actor: RequestAdmin, keys: string[]) {
    const unknownOrPlatform = keys.filter((k) => !isOperatorPermission(k));
    if (unknownOrPlatform.length) {
      throw new ForbiddenException(`Not grantable to operator staff: ${unknownOrPlatform.join(', ')}`);
    }
    if (!actor.permissions.includes('*')) {
      const notHeld = keys.filter((k) => !actor.permissions.includes(k));
      if (notHeld.length) throw new ForbiddenException(`You can only grant permissions you hold yourself: ${notHeld.join(', ')}`);
    }
  }

  private async getStaff(actor: RequestAdmin, operatorId: string, staffId: string) {
    if (staffId === actor.adminId) throw new ForbiddenException('You cannot change your own account here');
    const target = await this.prisma.adminUser.findFirst({ where: { id: staffId, operatorId } });
    if (!target) throw new NotFoundException('Staff account not found');
    if (target.role !== 'OPERATOR_STAFF') throw new ForbiddenException('Only staff accounts can be managed here — the owner is managed by the platform');
    return target;
  }

  async create(actor: RequestAdmin, operatorId: string, dto: { username: string; password?: string; fullName: string; permissions: string[] }) {
    const keys = [...new Set(dto.permissions)];
    this.assertGrantable(actor, keys);
    const [{ MAX_STAFF }, existing] = await Promise.all([
      this.limits.get(operatorId),
      this.prisma.adminUser.count({ where: { operatorId, role: 'OPERATOR_STAFF', status: { not: 'disabled' } } }),
    ]);
    if (existing >= MAX_STAFF) throw new ForbiddenException(`This operator can have at most ${MAX_STAFF} staff accounts`);
    const rawPassword = dto.password ?? generateTempPassword();
    const isTemp = !dto.password;
    const passwordHash = await this.passwords.hash(rawPassword);

    let staff;
    try {
      staff = await this.prisma.$transaction(async (tx) => {
        await setTenantOnTx(tx, operatorId);
        const created = await tx.adminUser.create({
          data: {
            username: dto.username,
            passwordHash,
            passwordChangedAt: new Date(),
            fullName: dto.fullName,
            role: 'OPERATOR_STAFF',
            operatorId,
            createdByAdminId: actor.adminId,
          },
        });
        const perms = await tx.permission.findMany({ where: { key: { in: keys } } });
        if (perms.length) {
          await tx.adminPermission.createMany({
            data: perms.map((p) => ({ adminId: created.id, permissionId: p.id, grantedByAdminId: actor.adminId })),
          });
        }
        return created;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('That username is already taken');
      throw e;
    }

    await this.audit.log({
      actorType: 'admin',
      adminId: actor.adminId,
      operatorId,
      action: 'STAFF_CREATED',
      entityType: 'admin',
      entityId: staff.id,
      newState: { username: staff.username, fullName: staff.fullName, permissions: keys },
    });
    await this.notifications.notifyPlatform({
      type: 'STAFF_CREATED',
      title: `New staff account: ${staff.username}`,
      body: `Permissions: ${keys.join(', ') || 'none'}`,
      operatorId,
      relatedEntityType: 'admin',
      relatedEntityId: staff.id,
    });
    return { id: staff.id, username: staff.username, fullName: staff.fullName, role: staff.role, permissions: keys, ...(isTemp ? { temporaryPassword: rawPassword } : {}) };
  }

  async setPermissions(actor: RequestAdmin, operatorId: string, staffId: string, permissions: string[]) {
    const target = await this.getStaff(actor, operatorId, staffId);
    const keys = [...new Set(permissions)];
    this.assertGrantable(actor, keys);
    const before = await this.prisma.adminPermission.findMany({ where: { adminId: target.id }, include: { permission: true } });
    const perms = await this.prisma.permission.findMany({ where: { key: { in: keys } } });
    await this.prisma.$transaction([
      tenantSetConfigOp(this.prisma, operatorId),
      this.prisma.adminPermission.deleteMany({ where: { adminId: target.id } }),
      this.prisma.adminPermission.createMany({
        data: perms.map((p) => ({ adminId: target.id, permissionId: p.id, grantedByAdminId: actor.adminId })),
      }),
    ]);
    await this.audit.log({
      actorType: 'admin',
      adminId: actor.adminId,
      operatorId,
      action: 'STAFF_PERMISSIONS_UPDATED',
      entityType: 'admin',
      entityId: target.id,
      previousState: { permissions: before.map((b) => b.permission.key) },
      newState: { permissions: keys },
    });
    return { id: target.id, permissions: keys };
  }

  async setStatus(actor: RequestAdmin, operatorId: string, staffId: string, status: 'active' | 'suspended' | 'disabled') {
    const target = await this.getStaff(actor, operatorId, staffId);
    const now = new Date();
    await this.prisma.$transaction([
      tenantSetConfigOp(this.prisma, operatorId),
      this.prisma.adminUser.update({ where: { id: target.id }, data: { status } }),
      ...(status !== 'active'
        ? [
            this.prisma.adminSession.updateMany({ where: { adminId: target.id, revokedAt: null }, data: { revokedAt: now } }),
            this.prisma.adminRefreshToken.updateMany({ where: { adminId: target.id, revokedAt: null }, data: { revokedAt: now } }),
          ]
        : []),
    ]);
    await this.audit.log({
      actorType: 'admin',
      adminId: actor.adminId,
      operatorId,
      action: status === 'active' ? 'STAFF_ENABLED' : status === 'suspended' ? 'STAFF_SUSPENDED' : 'STAFF_DISABLED',
      entityType: 'admin',
      entityId: target.id,
      previousState: { status: target.status },
      newState: { status },
    });
    return { id: target.id, status };
  }

  async resetPassword(actor: RequestAdmin, operatorId: string, staffId: string, newPassword: string) {
    const target = await this.getStaff(actor, operatorId, staffId);
    const passwordHash = await this.passwords.hash(newPassword);
    const now = new Date();
    await this.prisma.$transaction([
      tenantSetConfigOp(this.prisma, operatorId),
      this.prisma.adminUser.update({ where: { id: target.id }, data: { passwordHash, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null } }),
      this.prisma.adminSession.updateMany({ where: { adminId: target.id, revokedAt: null }, data: { revokedAt: now } }),
      this.prisma.adminRefreshToken.updateMany({ where: { adminId: target.id, revokedAt: null }, data: { revokedAt: now } }),
    ]);
    await this.audit.log({ actorType: 'admin', adminId: actor.adminId, operatorId, action: 'STAFF_PASSWORD_RESET', entityType: 'admin', entityId: target.id });
    return { success: true };
  }

  async remove(actor: RequestAdmin, operatorId: string, staffId: string) {
    const target = await this.getStaff(actor, operatorId, staffId);
    if (target.lastLoginAt) {
      // Keep accounts that have ever acted: their username is referenced by audit history. Disable instead.
      throw new BadRequestException('This account has signed in before — disable it instead of deleting it, so its history stays attributable');
    }
    await this.prisma.adminUser.delete({ where: { id: target.id } });
    await this.audit.log({
      actorType: 'admin',
      adminId: actor.adminId,
      operatorId,
      action: 'STAFF_DELETED',
      entityType: 'admin',
      entityId: target.id,
      previousState: { username: target.username },
    });
    return { success: true };
  }
}

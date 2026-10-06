import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getImpersonatedByAdminId } from '../common/tenant/tenant-context';

export interface AuditEntry {
  actorType: 'admin' | 'system';
  adminId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  previousState?: unknown;
  newState?: unknown;
  reason?: string | null;
  ipAddress?: string | null;
  /** Operator the action concerns; omit/null for platform-level actions (admin login, operator management). */
  operatorId?: string | null;
  /**
   * The real actor, when this action happened during a Super Admin "viewing
   * as" session — `adminId` above is the impersonated target, not the actor,
   * for every ordinary action (see RequestAdmin.impersonatedByAdminId).
   * Almost never needs to be passed explicitly: log() defaults it from the
   * current request's AsyncLocalStorage context (set by
   * TenantContextInterceptor on every request), so none of this method's
   * ~100 call sites had to be touched to get this for free. The one
   * exception is IMPERSONATION_STARTED/ENDED themselves, which pass it
   * explicitly since the AsyncLocalStorage value at that exact moment can be
   * ambiguous relative to which session is "current."
   */
  impersonatedByAdminId?: string | null;
  /** Role of the acting admin at the time of the action (e.g. SUPER_ADMIN, ADMIN, OPERATOR_OWNER). */
  actorRole?: string | null;
  /** Correlation id from the HTTP request, for tracing across log sinks. */
  requestId?: string | null;
}

/**
 * Append-only audit trail — every admin action is recorded here (spec:
 * "Every admin action must be recorded"). No update/delete method exists on
 * this service; rows are also protected at the DB level (see migration
 * 20260919032018_ledger_immutability, which also covers audit_logs).
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry): Promise<void> {
    const username = entry.adminId
      ? (await this.prisma.adminUser.findUnique({ where: { id: entry.adminId }, select: { username: true } }))?.username
      : null;

    await this.prisma.auditLog.create({
      data: {
        actorType: entry.actorType,
        adminId: entry.adminId ?? null,
        username: username ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        previousState: entry.previousState === undefined ? undefined : (entry.previousState as object),
        newState: entry.newState === undefined ? undefined : (entry.newState as object),
        reason: entry.reason ?? null,
        ipAddress: entry.ipAddress ?? null,
        operatorId: entry.operatorId ?? null,
        impersonatedByAdminId: entry.impersonatedByAdminId !== undefined ? entry.impersonatedByAdminId : getImpersonatedByAdminId(),
        actorRole: entry.actorRole ?? null,
        requestId: entry.requestId ?? null,
      },
    });
  }

  /**
   * Full log, optionally narrowed to one admin ("check and control all
   * activity of the admin in detail") and/or one operator. `operatorId` null
   * = every operator plus platform-level rows (platform admins only).
   */
  async list(params: { limit?: number; adminId?: string; operatorId?: string | null } = {}) {
    const entries = await this.prisma.auditLog.findMany({
      where: {
        ...(params.adminId ? { adminId: params.adminId } : {}),
        ...(params.operatorId ? { operatorId: params.operatorId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: params.limit ?? 200,
      include: { operator: { select: { slug: true } } },
    });

    // impersonatedByAdminId has no Prisma relation (deliberately — an audit
    // row must stay readable even if that admin account is later deleted, so
    // it's a plain id, not a foreign key). Resolved here, at read time, as a
    // one-shot lookup rather than N+1 queries per row.
    const impersonatorIds = [...new Set(entries.map((e) => e.impersonatedByAdminId).filter((id): id is string => id != null))];
    const impersonators = impersonatorIds.length
      ? await this.prisma.adminUser.findMany({ where: { id: { in: impersonatorIds } }, select: { id: true, username: true } })
      : [];
    const usernameById = new Map(impersonators.map((a) => [a.id, a.username]));

    return entries.map((e) => ({
      ...e,
      impersonatedByUsername: e.impersonatedByAdminId ? (usernameById.get(e.impersonatedByAdminId) ?? null) : null,
    }));
  }
}

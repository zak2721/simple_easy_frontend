import { ForbiddenException } from '@nestjs/common';
import type { RequestAdmin } from '../decorators/current-user.decorator';
import { DEFAULT_OPERATOR_ID } from '../operator.constants';

function assertMayAccess(admin: RequestAdmin, requested: string | undefined): void {
  if (admin.operatorId && requested && requested !== admin.operatorId) {
    throw new ForbiddenException('You can only access your own operator');
  }
}

/**
 * Operator filter for admin READS. An operator-bound admin is always pinned
 * to their own operator; a platform admin may narrow to one operator with
 * `?operatorId=`, or pass nothing to see every operator (returns null).
 */
export function readScope(admin: RequestAdmin, requested?: string): string | null {
  assertMayAccess(admin, requested);
  return admin.operatorId ?? requested ?? null;
}

/**
 * The single operator an admin WRITE applies to (settings, contact info,
 * bonus rules). Operator-bound admins: their own operator. Platform admins:
 * `?operatorId=`, defaulting to the default operator so the existing admin
 * panel keeps editing the same settings it always has.
 */
export function writeTarget(admin: RequestAdmin, requested?: string): string {
  assertMayAccess(admin, requested);
  return admin.operatorId ?? requested ?? DEFAULT_OPERATOR_ID;
}

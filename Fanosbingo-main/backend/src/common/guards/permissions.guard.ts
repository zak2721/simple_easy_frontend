import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import type { PermissionKey } from '../rbac.constants';
import type { RequestAdmin } from '../decorators/current-user.decorator';

/**
 * Enforces @Permissions(...) on admin routes. Must run AFTER JwtAdminGuard
 * (which populates req.admin). SUPER_ADMIN holds '*' and passes every check —
 * see JwtAdminStrategy for where that's computed.
 *
 * This is the backend-authoritative enforcement spec §32 requires
 * ("Frontend visibility is NOT security") — every admin-management and
 * financial route is checked here, never trusted from the client.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionKey[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const admin: RequestAdmin = context.switchToHttp().getRequest().admin;
    if (!admin) throw new ForbiddenException('No admin context');

    if (admin.permissions.includes('*')) return true;

    const missing = required.filter((p) => !admin.permissions.includes(p));
    if (missing.length > 0) {
      throw new ForbiddenException(`Missing permission(s): ${missing.join(', ')}`);
    }
    return true;
  }
}

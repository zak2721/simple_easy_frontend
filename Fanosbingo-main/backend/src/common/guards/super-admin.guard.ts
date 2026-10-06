import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { RequestAdmin } from '../decorators/current-user.decorator';

/**
 * Admin management (creating/deleting admins, assigning permissions) is
 * Super-Admin-exclusive per spec — NOT permission-gated, since permissions
 * themselves are only ever assigned by the Super Admin ("Admins cannot
 * create other admins. Admins cannot assign permissions. Admins cannot
 * modify their own permissions."). Must run AFTER JwtAdminGuard.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const admin: RequestAdmin = context.switchToHttp().getRequest().admin;
    if (!admin || !admin.roles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('Only the Super Admin can perform this action');
    }
    return true;
  }
}

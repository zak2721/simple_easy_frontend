import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { RequestAdmin } from '../decorators/current-user.decorator';

/**
 * Allows only platform-level admins (SUPER_ADMIN / platform ADMIN, operatorId
 * null). For routes whose data is shared by every operator — an
 * operator-bound admin editing it would change other operators' players'
 * experience. Must run after JwtAdminGuard.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const admin: RequestAdmin | undefined = context.switchToHttp().getRequest().admin;
    if (!admin) throw new ForbiddenException('No admin context');
    if (admin.operatorId) throw new ForbiddenException('Only platform administrators can manage this');
    return true;
  }
}

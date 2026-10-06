import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAdminGuard extends AuthGuard('jwt-admin') {
  handleRequest<TUser = unknown>(err: unknown, user: TUser, info: unknown, context: ExecutionContext): TUser {
    if (err || !user) {
      const message = err instanceof Error ? err.message : 'Unauthorized';
      throw new UnauthorizedException(message);
    }
    const req = context.switchToHttp().getRequest();
    req.admin = user;
    return user;
  }
}

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import type { RequestAdmin } from '../../common/decorators/current-user.decorator';
import { OPERATOR_PERMISSIONS, isOperatorPermission } from '../../common/rbac.constants';

export interface AdminJwtPayload {
  sub: string; // AdminUser.id
  sid: string; // AdminSession.id — lets us check revocation per request
  type: 'admin_access';
}

/**
 * Unlike the player strategy, admin tokens are checked against the
 * AdminSession table on every request (spec §39: revoke sessions; §38:
 * suspended/disabled admins must be rejected immediately, not just at their
 * next token expiry). This is a deliberate DB round-trip per admin request —
 * correctness over raw throughput for the side of the app that moves money.
 */
@Injectable()
export class JwtAdminStrategy extends PassportStrategy(Strategy, 'jwt-admin') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const secret = config.get<string>('JWT_ACCESS_SECRET');
    if (!secret) throw new Error('JWT_ACCESS_SECRET is not configured');
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
      passReqToCallback: false,
    });
  }

  async validate(payload: AdminJwtPayload): Promise<RequestAdmin> {
    if (payload.type !== 'admin_access') throw new UnauthorizedException('Wrong token type');

    const session = await this.prisma.adminSession.findUnique({
      where: { id: payload.sid },
      include: {
        admin: {
          include: {
            permissions: { where: { enabled: true }, include: { permission: true } },
            operator: { select: { status: true } },
          },
        },
      },
    });

    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Session expired or revoked');
    }
    if (session.admin.status !== 'active') {
      throw new UnauthorizedException('Admin account is not active');
    }
    if (session.admin.operator && session.admin.operator.status !== 'active') {
      throw new UnauthorizedException('This operator is suspended');
    }

    if (session.admin.lockedUntil && session.admin.lockedUntil > new Date()) {
      throw new UnauthorizedException('Admin account is locked');
    }

    // Phase 8b: temporary-password guard. A generated password forces the owner
    // to set their own before doing anything else. This flag is cleared by
    // POST /auth/admin/change-password (AuthService.changeAdminPassword).
    if ((session.admin as any).mustChangePassword) {
      throw new UnauthorizedException('MUST_CHANGE_PASSWORD');
    }

    const granted = session.admin.permissions.map((p) => p.permission.key);
    const permissions =
      session.admin.role === 'SUPER_ADMIN'
        ? ['*'] // unrestricted, see PermissionsGuard
        : session.admin.role === 'OPERATOR_OWNER'
          ? [...OPERATOR_PERMISSIONS] // every operator-scoped permission, within its own operator (operatorId pins the scope)
          : session.admin.role === 'OPERATOR_STAFF'
            ? granted.filter(isOperatorPermission) // a platform permission can never reach an operator account, whatever is stored
            : granted;

    return {
      adminId: session.admin.id,
      sessionId: session.id,
      username: session.admin.username,
      fullName: session.admin.fullName,
      permissions,
      roles: [session.admin.role],
      operatorId: session.admin.operatorId,
      totpEnabled: session.admin.totpEnabled,
      impersonatedByAdminId: session.impersonatedByAdminId,
      telegramAlertChatId: session.admin.telegramAlertChatId,
    };
  }
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

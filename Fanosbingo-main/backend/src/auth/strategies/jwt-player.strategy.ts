import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';

export interface PlayerJwtPayload {
  sub: string; // TelegramUser.id (uuid)
  tgid: string; // telegramUserId as string (BigInt-safe)
  type: 'player_access';
}

@Injectable()
export class JwtPlayerStrategy extends PassportStrategy(Strategy, 'jwt-player') {
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
    });
  }

  /**
   * Audit finding ADMIN-1 (Critical): a suspended/banned player's existing
   * access token used to stay valid until it naturally expired (up to 15
   * minutes) — a fraudulent player caught mid-session could keep depositing/
   * withdrawing/playing during that window. This now re-checks status on
   * EVERY request (one extra indexed lookup by primary key — cheap), the
   * same trade-off AdminSession revocation already makes for admin tokens.
   */
  async validate(payload: PlayerJwtPayload) {
    if (payload.type !== 'player_access') throw new UnauthorizedException('Wrong token type');

    const user = await this.prisma.telegramUser.findUnique({
      where: { id: payload.sub },
      select: { status: true, operatorId: true, operator: { select: { status: true } } },
    });
    if (!user) throw new UnauthorizedException('Account not found');
    if (user.status !== 'active') {
      throw new UnauthorizedException(user.status === 'banned' ? 'Account banned' : 'Account suspended');
    }
    // Suspending an operator locks its players out immediately, same as a player suspension.
    if (user.operator.status !== 'active') throw new UnauthorizedException('This bingo is currently unavailable');

    return { userId: payload.sub, telegramUserId: BigInt(payload.tgid), operatorId: user.operatorId };
  }
}

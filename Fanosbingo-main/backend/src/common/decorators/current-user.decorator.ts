import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface RequestPlayer {
  telegramUserId: bigint;
  userId: string;
  /** From the player's own account row on every request — never from client input. */
  operatorId: string;
}

export interface RequestAdmin {
  adminId: string;
  sessionId: string;
  username: string;
  fullName: string;
  permissions: string[];
  roles: string[];
  /** Null = platform-level admin (sees every operator). Set = bound to this operator only. Use common/tenant/operator-scope.ts. */
  operatorId: string | null;
  totpEnabled: boolean;
  /** Set only when this session is a Super Admin "viewing as" this account — the real actor behind it. */
  impersonatedByAdminId: string | null;
  telegramAlertChatId: string | null;
}

/** The authenticated player, attached by JwtAuthGuard/JwtStrategy. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestPlayer => {
  const req = ctx.switchToHttp().getRequest();
  return req.player;
});

/** The authenticated admin, attached by AdminJwtAuthGuard/AdminJwtStrategy. */
export const CurrentAdmin = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestAdmin => {
  const req = ctx.switchToHttp().getRequest();
  return req.admin;
});

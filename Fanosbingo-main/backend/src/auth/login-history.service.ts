import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface LoginAttempt {
  principalType: 'admin' | 'player';
  principalId?: string | null;
  operatorId?: string | null;
  attemptedUsername?: string | null;
  success: boolean;
  failureReason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  deviceId?: string | null;
}

/** Append-only login trail (login_history is protected by prevent_ledger_mutation). */
@Injectable()
export class LoginHistoryService {
  private readonly logger = new Logger(LoginHistoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Never throws: a failure to record history must not block or change the outcome of a login. */
  async record(attempt: LoginAttempt): Promise<void> {
    try {
      await this.prisma.loginHistory.create({
        data: {
          principalType: attempt.principalType,
          principalId: attempt.principalId ?? null,
          operatorId: attempt.operatorId ?? null,
          attemptedUsername: attempt.attemptedUsername?.slice(0, 100) ?? null,
          success: attempt.success,
          failureReason: attempt.failureReason ?? null,
          ipAddress: attempt.ipAddress ?? null,
          userAgent: attempt.userAgent?.slice(0, 300) ?? null,
          deviceId: attempt.deviceId?.slice(0, 100) ?? null,
        },
      });
    } catch (e) {
      this.logger.error('Could not record login history', e instanceof Error ? e.message : String(e));
    }
  }

  /** `scope` null = every operator + platform logins (platform admins only). */
  async list(params: { scope: string | null; principalId?: string; limit?: number }) {
    return this.prisma.loginHistory.findMany({
      where: {
        ...(params.scope ? { operatorId: params.scope } : {}),
        ...(params.principalId ? { principalId: params.principalId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(params.limit ?? 200, 1000),
    });
  }
}

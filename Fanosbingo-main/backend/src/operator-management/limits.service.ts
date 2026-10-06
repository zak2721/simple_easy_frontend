import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { tenantSetConfigOp } from '../common/tenant/rls';

/** Ceilings the Super Admin imposes per operator ("Limit Operator Features"). Stored in operator_limits; these are the defaults. */
export const LIMIT_DEFAULTS = {
  MAX_ROOMS: 10,
  MAX_TOTAL_CARTELAS: 10000,
  MIN_CARTELA_PRICE: 1,
  MAX_CARTELA_PRICE: 100000,
  MAX_STAFF: 20,
  /** Maximum games this operator may complete in a single calendar day. */
  MAX_GAMES_PER_DAY: 9999,
  /** Maximum distinct active players across all games at any one moment. */
  MAX_ACTIVE_PLAYERS: 99999,
} as const;

export type LimitKey = keyof typeof LIMIT_DEFAULTS;
export type OperatorLimits = Record<LimitKey, number>;

@Injectable()
export class LimitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(operatorId: string): Promise<OperatorLimits> {
    const rows = await this.prisma.operatorLimit.findMany({ where: { operatorId } });
    const limits: OperatorLimits = { ...LIMIT_DEFAULTS };
    for (const r of rows) {
      if (r.key in LIMIT_DEFAULTS) limits[r.key as LimitKey] = Number(r.value);
    }
    return limits;
  }

  async set(actingAdminId: string, operatorId: string, values: Partial<Record<string, number>>) {
    const before = await this.get(operatorId);
    const entries = Object.entries(values).filter(([, v]) => v !== undefined) as Array<[string, number]>;
    for (const [key, value] of entries) {
      if (!(key in LIMIT_DEFAULTS)) throw new BadRequestException(`Unknown limit: ${key}`);
      if (!Number.isFinite(value) || value < 0) throw new BadRequestException(`${key} must be a non-negative number`);
    }
    const merged = { ...before, ...Object.fromEntries(entries) } as OperatorLimits;
    if (merged.MIN_CARTELA_PRICE > merged.MAX_CARTELA_PRICE) throw new BadRequestException('MIN_CARTELA_PRICE cannot exceed MAX_CARTELA_PRICE');

    await this.prisma.$transaction([
      tenantSetConfigOp(this.prisma, operatorId),
      ...entries.map(([key, value]) =>
        this.prisma.operatorLimit.upsert({
          where: { operatorId_key: { operatorId, key } },
          create: { operatorId, key, value: String(value) },
          update: { value: String(value) },
        }),
      ),
    ]);
    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId,
      action: 'OPERATOR_LIMITS_UPDATED',
      entityType: 'operator',
      entityId: operatorId,
      previousState: before,
      newState: merged,
    });
    return merged;
  }
}

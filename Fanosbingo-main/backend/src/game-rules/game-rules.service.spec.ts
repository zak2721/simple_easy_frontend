import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { GameRulesService } from './game-rules.service';

describe('GameRulesService (per-operator ownership)', () => {
  let prisma: {
    gameRule: {
      findMany: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      aggregate: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
  };
  let audit: { log: ReturnType<typeof vi.fn> };
  let service: GameRulesService;

  beforeEach(() => {
    prisma = {
      gameRule: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn(),
        aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: 3 } }),
        create: vi.fn(async ({ data }) => ({ id: 'r1', isActive: true, ...data })),
        update: vi.fn(),
        delete: vi.fn(),
      },
    };
    audit = { log: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new GameRulesService(prisma as any, audit as any);
  });

  it("the player Help page lists only that operator's active rules", async () => {
    await service.listActive('op-a');
    expect(prisma.gameRule.findMany).toHaveBeenCalledWith({ where: { operatorId: 'op-a', isActive: true }, orderBy: { sortOrder: 'asc' } });
  });

  it("creates the rule under the target operator, numbered after that operator's own last rule", async () => {
    const rule = await service.create({ title: 'T', body: 'B' }, 'admin1', 'op-a');
    expect(prisma.gameRule.aggregate).toHaveBeenCalledWith({ where: { operatorId: 'op-a' }, _max: { sortOrder: true } });
    expect(rule).toMatchObject({ operatorId: 'op-a', sortOrder: 4 });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ operatorId: 'op-a', action: 'GAME_RULE_CREATED' }));
  });

  it("refuses to update or delete a rule that belongs to a different operator", async () => {
    prisma.gameRule.findFirst.mockResolvedValue(null); // (id, operatorId) matches nothing
    await expect(service.update('r-other', { title: 'x' }, 'admin1', 'op-a')).rejects.toThrow(NotFoundException);
    await expect(service.remove('r-other', 'admin1', 'op-a')).rejects.toThrow(NotFoundException);
    expect(prisma.gameRule.findFirst).toHaveBeenCalledWith({ where: { id: 'r-other', operatorId: 'op-a' } });
    expect(prisma.gameRule.update).not.toHaveBeenCalled();
    expect(prisma.gameRule.delete).not.toHaveBeenCalled();
  });
});

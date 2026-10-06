import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateGameRuleDto, UpdateGameRuleDto } from './dto/game-rules.dto';
import { tenantSetConfigOp } from '../common/tenant/rls';

/**
 * Help-page rules. Every rule belongs to exactly one operator: rule text
 * typically names rooms and prices, which differ per operator. Every
 * mutation matches on (id, operatorId), so an admin can only touch rules of
 * the operator they're acting for.
 */
@Injectable()
export class GameRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Active rules only, in display order — consumed by the Mini App Help page. */
  listActive(operatorId: string) {
    return this.prisma.gameRule.findMany({
      where: { operatorId, isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  /** All of one operator's rules, including inactive — the admin list view. */
  listAll(operatorId: string) {
    return this.prisma.gameRule.findMany({ where: { operatorId }, orderBy: { sortOrder: 'asc' } });
  }

  private async getOwned(id: string, operatorId: string) {
    const rule = await this.prisma.gameRule.findFirst({ where: { id, operatorId } });
    if (!rule) throw new NotFoundException('Rule not found');
    return rule;
  }

  async create(dto: CreateGameRuleDto, adminId: string, operatorId: string) {
    const max = await this.prisma.gameRule.aggregate({ where: { operatorId }, _max: { sortOrder: true } });
    const rule = await this.prisma.gameRule.create({
      data: {
        operatorId,
        title: dto.title,
        body: dto.body,
        category: dto.category,
        sortOrder: (max._max.sortOrder ?? 0) + 1,
      },
    });
    await this.audit.log({
      actorType: 'admin',
      adminId,
      operatorId,
      action: 'GAME_RULE_CREATED',
      entityType: 'game_rule',
      entityId: rule.id,
      newState: { title: rule.title, category: rule.category, isActive: rule.isActive },
    });
    return rule;
  }

  async update(id: string, dto: UpdateGameRuleDto, adminId: string, operatorId: string) {
    const previous = await this.getOwned(id, operatorId);

    const rule = await this.prisma.gameRule.update({
      where: { id: previous.id },
      data: {
        title: dto.title,
        body: dto.body,
        category: dto.category,
        isActive: dto.isActive,
      },
    });
    await this.audit.log({
      actorType: 'admin',
      adminId,
      operatorId,
      action: 'GAME_RULE_UPDATED',
      entityType: 'game_rule',
      entityId: rule.id,
      previousState: { title: previous.title, body: previous.body, category: previous.category, isActive: previous.isActive },
      newState: { title: rule.title, body: rule.body, category: rule.category, isActive: rule.isActive },
    });
    return rule;
  }

  async remove(id: string, adminId: string, operatorId: string) {
    const previous = await this.getOwned(id, operatorId);

    await this.prisma.gameRule.delete({ where: { id: previous.id } });
    await this.audit.log({
      actorType: 'admin',
      adminId,
      operatorId,
      action: 'GAME_RULE_DELETED',
      entityType: 'game_rule',
      entityId: id,
      previousState: { title: previous.title, category: previous.category },
    });
    return { success: true };
  }

  /** Swaps sortOrder with the adjacent rule of the same operator — no gap/renumber logic needed. */
  async reorder(id: string, direction: 'up' | 'down', adminId: string, operatorId: string) {
    const all = await this.listAll(operatorId);
    const index = all.findIndex((r) => r.id === id);
    if (index === -1) throw new NotFoundException('Rule not found');

    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= all.length) return all[index]; // already at the edge — no-op

    const current = all[index];
    const swapWith = all[swapIndex];

    await this.prisma.$transaction([
      tenantSetConfigOp(this.prisma, operatorId),
      this.prisma.gameRule.update({ where: { id: current.id }, data: { sortOrder: swapWith.sortOrder } }),
      this.prisma.gameRule.update({ where: { id: swapWith.id }, data: { sortOrder: current.sortOrder } }),
    ]);

    await this.audit.log({
      actorType: 'admin',
      adminId,
      operatorId,
      action: 'GAME_RULE_REORDERED',
      entityType: 'game_rule',
      entityId: current.id,
      previousState: { sortOrder: current.sortOrder },
      newState: { sortOrder: swapWith.sortOrder },
    });

    return this.listAll(operatorId);
  }
}

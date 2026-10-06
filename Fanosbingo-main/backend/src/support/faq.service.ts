import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { tenantSetConfigOp } from '../common/tenant/rls';

/** Operator-owned FAQ entries. Each operator manages its own; there is no shared/platform FAQ. */
@Injectable()
export class FaqService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  listActive(operatorId: string) {
    return this.prisma.faqEntry.findMany({
      where: { operatorId, isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  listAll(operatorId: string) {
    return this.prisma.faqEntry.findMany({ where: { operatorId }, orderBy: { sortOrder: 'asc' } });
  }

  private async getOwned(id: string, operatorId: string) {
    const row = await this.prisma.faqEntry.findFirst({ where: { id, operatorId } });
    if (!row) throw new NotFoundException('FAQ entry not found');
    return row;
  }

  async create(actingAdminId: string, operatorId: string, dto: { question: string; answer: string }) {
    const max = await this.prisma.faqEntry.aggregate({ where: { operatorId }, _max: { sortOrder: true } });
    const row = await this.prisma.faqEntry.create({
      data: { operatorId, question: dto.question, answer: dto.answer, sortOrder: (max._max.sortOrder ?? 0) + 1 },
    });
    await this.audit.log({ actorType: 'admin', adminId: actingAdminId, operatorId, action: 'FAQ_CREATED', entityType: 'faq_entry', entityId: row.id, newState: dto });
    return row;
  }

  async update(actingAdminId: string, operatorId: string, id: string, dto: { question?: string; answer?: string; isActive?: boolean }) {
    const before = await this.getOwned(id, operatorId);
    const row = await this.prisma.faqEntry.update({ where: { id: before.id }, data: dto });
    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId,
      action: 'FAQ_UPDATED',
      entityType: 'faq_entry',
      entityId: id,
      previousState: { question: before.question, answer: before.answer, isActive: before.isActive },
      newState: { question: row.question, answer: row.answer, isActive: row.isActive },
    });
    return row;
  }

  async remove(actingAdminId: string, operatorId: string, id: string) {
    const before = await this.getOwned(id, operatorId);
    await this.prisma.faqEntry.delete({ where: { id: before.id } });
    await this.audit.log({ actorType: 'admin', adminId: actingAdminId, operatorId, action: 'FAQ_DELETED', entityType: 'faq_entry', entityId: id, previousState: { question: before.question } });
    return { success: true };
  }

  async reorder(actingAdminId: string, operatorId: string, id: string, direction: 'up' | 'down') {
    const all = await this.listAll(operatorId);
    const index = all.findIndex((r) => r.id === id);
    if (index === -1) throw new NotFoundException('FAQ entry not found');
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= all.length) return all[index];
    const current = all[index];
    const swapWith = all[swapIndex];
    await this.prisma.$transaction([
      tenantSetConfigOp(this.prisma, operatorId),
      this.prisma.faqEntry.update({ where: { id: current.id }, data: { sortOrder: swapWith.sortOrder } }),
      this.prisma.faqEntry.update({ where: { id: swapWith.id }, data: { sortOrder: current.sortOrder } }),
    ]);
    await this.audit.log({ actorType: 'admin', adminId: actingAdminId, operatorId, action: 'FAQ_REORDERED', entityType: 'faq_entry', entityId: current.id });
    return this.listAll(operatorId);
  }
}

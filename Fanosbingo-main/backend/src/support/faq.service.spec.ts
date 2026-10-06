import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { FaqService } from './faq.service';

describe('FaqService ownership', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let service: FaqService;

  beforeEach(() => {
    prisma = {
      faqEntry: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn(),
        aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: 2 } }),
        create: vi.fn(async ({ data }) => ({ id: 'f1', ...data })),
        update: vi.fn(),
        delete: vi.fn(),
      },
      $transaction: vi.fn(async (arg) => Promise.all(arg)),
    };
    service = new FaqService(prisma, { log: vi.fn() } as never);
  });

  it('listActive is scoped to one operator', async () => {
    await service.listActive('op-1');
    expect(prisma.faqEntry.findMany).toHaveBeenCalledWith({ where: { operatorId: 'op-1', isActive: true }, orderBy: { sortOrder: 'asc' } });
  });

  it('create numbers the new entry after that operator\'s own last entry', async () => {
    const r = await service.create('admin1', 'op-1', { question: 'How do I deposit?', answer: 'Via Telebirr.' });
    expect(prisma.faqEntry.aggregate).toHaveBeenCalledWith({ where: { operatorId: 'op-1' }, _max: { sortOrder: true } });
    expect(r).toMatchObject({ operatorId: 'op-1', sortOrder: 3 });
  });

  it('an entry belonging to a different operator is not found for update/delete', async () => {
    prisma.faqEntry.findFirst.mockResolvedValue(null);
    await expect(service.update('admin1', 'op-1', 'f-of-op-2', { answer: 'x' })).rejects.toThrow(NotFoundException);
    await expect(service.remove('admin1', 'op-1', 'f-of-op-2')).rejects.toThrow(NotFoundException);
    expect(prisma.faqEntry.findFirst).toHaveBeenCalledWith({ where: { id: 'f-of-op-2', operatorId: 'op-1' } });
    expect(prisma.faqEntry.update).not.toHaveBeenCalled();
    expect(prisma.faqEntry.delete).not.toHaveBeenCalled();
  });
});

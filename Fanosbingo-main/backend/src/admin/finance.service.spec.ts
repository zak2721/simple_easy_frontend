import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FinanceService } from './finance.service';

function aggResult(total: number, count: number) {
  return { _sum: { amount: total }, _count: count };
}

describe('FinanceService.financialReport', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let service: FinanceService;

  beforeEach(() => {
    prisma = {
      walletLedgerEntry: {
        aggregate: vi.fn().mockResolvedValue(aggResult(0, 0)),
        groupBy: vi.fn().mockResolvedValue([]),
      },
      manualDeposit: { count: vi.fn().mockResolvedValue(0) },
      withdrawalRequest: { count: vi.fn().mockResolvedValue(0) },
      operator: { findMany: vi.fn().mockResolvedValue([{ id: 'op-1', slug: 'yena', name: 'Yena', status: 'active' }]) },
      telegramUser: { aggregate: vi.fn().mockResolvedValue({ _sum: {} }) },
    };
    service = new FinanceService(prisma, {} as never);
  });

  it('yearly period filters the ledger from Jan 1 of the current year', async () => {
    await service.financialReport('yearly', null);
    const call = prisma.walletLedgerEntry.aggregate.mock.calls[0][0];
    const gte: Date = call.where.createdAt.gte;
    expect(gte.getMonth()).toBe(0);
    expect(gte.getDate()).toBe(1);
    expect(gte.getFullYear()).toBe(new Date().getFullYear());
  });

  it('a custom range overrides the fixed period bucket, using [from, to)', async () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z');
    const result = await service.financialReport('monthly', null, { from, to });
    const call = prisma.walletLedgerEntry.aggregate.mock.calls[0][0];
    expect(call.where.createdAt).toEqual({ gte: from, lt: to });
    expect(result.range).toEqual({ from: from.toISOString(), to: to.toISOString() });
    expect(result.period).toBe('monthly'); // echoed back even though range overrode it
  });

  it('alltime with no range applies no date filter', async () => {
    await service.financialReport('alltime', 'op-1');
    const call = prisma.walletLedgerEntry.aggregate.mock.calls[0][0];
    expect(call.where.createdAt).toBeUndefined();
    expect(call.where.operatorId).toBe('op-1');
  });

  it('a platform admin (scope null) gets a per-operator breakdown; an operator-scoped report does not', async () => {
    const platformReport = await service.financialReport('alltime', null);
    expect(platformReport.by_operator).toBeDefined();
    const operatorReport = await service.financialReport('alltime', 'op-1');
    expect(operatorReport.by_operator).toBeUndefined();
  });
});

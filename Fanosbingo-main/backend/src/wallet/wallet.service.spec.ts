import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { WalletService } from './wallet.service';

/**
 * Audit finding TEST-2 (Critical): zero tests existed for any financial
 * service before this. WalletService is the single choke point every other
 * money-moving service (deposits, withdrawals, bonus, cards) routes through
 * — `writeEntry` is the ONLY sanctioned way to touch the ledger, so its
 * invariants (positive-amount enforcement, ledger-write shape) are the
 * highest-leverage thing to lock down first.
 */
describe('WalletService', () => {
  let prisma: { walletLedgerEntry: { create: ReturnType<typeof vi.fn> }; telegramUser: { findUnique: ReturnType<typeof vi.fn> }; withdrawalRequest: { aggregate: ReturnType<typeof vi.fn> } };
  let audit: { log: ReturnType<typeof vi.fn> };
  let service: WalletService;
  let tx: { $queryRaw: ReturnType<typeof vi.fn>; walletLedgerEntry: { create: ReturnType<typeof vi.fn> }; telegramUser: { update: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    prisma = {
      walletLedgerEntry: { create: vi.fn() },
      telegramUser: { findUnique: vi.fn() },
      withdrawalRequest: { aggregate: vi.fn() },
    };
    audit = { log: vi.fn() };
    tx = {
      $queryRaw: vi.fn(),
      walletLedgerEntry: { create: vi.fn() },
      telegramUser: { update: vi.fn() },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new WalletService(prisma as any, audit as any);
  });

  describe('writeEntry', () => {
    it('rejects a zero amount', async () => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        service.writeEntry(tx as any, { telegramUserId: 'u1', operatorId: 'op-1', entryType: 'BONUS_GRANT', direction: 'credit', amount: 0 }),
      ).rejects.toThrow(BadRequestException);
      expect(tx.walletLedgerEntry.create).not.toHaveBeenCalled();
    });

    it('rejects a negative amount', async () => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        service.writeEntry(tx as any, { telegramUserId: 'u1', operatorId: 'op-1', entryType: 'ADJUSTMENT', direction: 'debit', amount: -5 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('writes exactly the fields it was given, nothing more', async () => {
      tx.walletLedgerEntry.create.mockResolvedValue({ id: 'entry-1' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await service.writeEntry(tx as any, {
        telegramUserId: 'u1',
        operatorId: 'op-1',
        entryType: 'MANUAL_TELEBIRR_DEPOSIT',
        direction: 'credit',
        amount: 100,
        relatedEntityType: 'manual_deposit',
        relatedEntityId: 'd1',
        note: 'test',
      });
      expect(tx.walletLedgerEntry.create).toHaveBeenCalledWith({
        data: {
          telegramUserId: 'u1',
          operatorId: 'op-1',
          entryType: 'MANUAL_TELEBIRR_DEPOSIT',
          direction: 'credit',
          amount: 100,
          relatedEntityType: 'manual_deposit',
          relatedEntityId: 'd1',
          note: 'test',
        },
      });
    });
  });

  describe('lockUserForUpdate', () => {
    it('throws if the user row does not exist', async () => {
      tx.$queryRaw.mockResolvedValue([]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(service.lockUserForUpdate(tx as any, 'missing-user')).rejects.toThrow(BadRequestException);
    });

    it('returns the locked row when found', async () => {
      const row = { id: 'u1', deposited_balance: 10, won_balance: 20, bonus_balance: 30 };
      tx.$queryRaw.mockResolvedValue([row]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await service.lockUserForUpdate(tx as any, 'u1');
      expect(result).toEqual(row);
    });
  });

  describe('getWallet', () => {
    it('computes total_balance as the sum of all three buckets', async () => {
      prisma.telegramUser.findUnique.mockResolvedValue({ depositedBalance: 10, wonBalance: 20, bonusBalance: 5 });
      prisma.withdrawalRequest.aggregate.mockResolvedValue({ _sum: { amount: null } });
      const wallet = await service.getWallet('u1');
      expect(wallet.total_balance).toBe(35);
    });

    it('production readiness audit fix: withdrawable equals won_balance directly, not won_balance minus on_hold', async () => {
      // WithdrawalsService.request() already debits won_balance the moment a
      // withdrawal is requested (the hold) — won_balance is therefore already
      // net of every pending/approved request. Subtracting on_hold again here
      // would double-count the same hold and understate what's withdrawable.
      prisma.telegramUser.findUnique.mockResolvedValue({ depositedBalance: 0, wonBalance: 50, bonusBalance: 0 });
      prisma.withdrawalRequest.aggregate.mockResolvedValue({ _sum: { amount: 200 } });
      const wallet = await service.getWallet('u1');
      expect(wallet.withdrawable).toBe(50);
      expect(wallet.on_hold).toBe(200); // still reported, purely informational
    });

    it('throws if the user does not exist', async () => {
      prisma.telegramUser.findUnique.mockResolvedValue(null);
      await expect(service.getWallet('missing')).rejects.toThrow(BadRequestException);
    });
  });

  describe('adjustBalance', () => {
    it('rejects a reason shorter than 3 characters', async () => {
      await expect(
        service.adjustBalance({ telegramUserId: 'u1', bucket: 'won', amount: 10, direction: 'credit', reason: 'ab', actingAdminId: 'admin1' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a non-positive amount', async () => {
      await expect(
        service.adjustBalance({ telegramUserId: 'u1', bucket: 'won', amount: 0, direction: 'credit', reason: 'valid reason', actingAdminId: 'admin1' }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});

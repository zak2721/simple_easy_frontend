import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { WithdrawalsService } from './withdrawals.service';

/**
 * Covers the withdrawal state machine (pending -> approved -> paid, or
 * pending -> rejected) and the two places money can silently leak: a hold
 * placed on `request()` that's never released, and a `review()` transition
 * applied twice because of a concurrent admin action.
 */
describe('WithdrawalsService', () => {
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    withdrawalRequest: { findUnique: ReturnType<typeof vi.fn> };
  };
  let wallet: { lockUserForUpdate: ReturnType<typeof vi.fn>; writeEntry: ReturnType<typeof vi.fn> };
  let storage: { saveReceipt: ReturnType<typeof vi.fn>; signPath: ReturnType<typeof vi.fn> };
  let settings: { getGameConfig: ReturnType<typeof vi.fn> };
  let audit: { log: ReturnType<typeof vi.fn> };
  let telegram: { sendMessage: ReturnType<typeof vi.fn> };
  let metrics: { withdrawalsTotal: { inc: ReturnType<typeof vi.fn> } };
  let service: WithdrawalsService;
  let tx: {
    telegramUser: { update: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
    withdrawalRequest: { create: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; findUniqueOrThrow: ReturnType<typeof vi.fn> };
    $executeRaw: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    tx = {
      telegramUser: { update: vi.fn(), findUnique: vi.fn() },
      withdrawalRequest: { create: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
      $executeRaw: vi.fn(),
    };
    prisma = {
      $transaction: vi.fn(async (cb) => cb(tx)),
      withdrawalRequest: { findUnique: vi.fn() },
    };
    wallet = { lockUserForUpdate: vi.fn(), writeEntry: vi.fn() };
    storage = { saveReceipt: vi.fn().mockResolvedValue({ path: '/proofs/x.png' }), signPath: vi.fn() };
    settings = { getGameConfig: vi.fn().mockResolvedValue({ minWithdrawalEtb: 200 }) };
    audit = { log: vi.fn() };
    telegram = { sendMessage: vi.fn() };
    metrics = { withdrawalsTotal: { inc: vi.fn() } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new WithdrawalsService(prisma as any, wallet as any, storage as any, settings as any, audit as any, telegram as any, metrics as any);
  });

  describe('request', () => {
    it('rejects an amount below the configured minimum withdrawal', async () => {
      await expect(service.request('u1', 'op-1', { amount: 199, telebirrAccount: '0911...' })).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects when the locked won_balance is insufficient, without creating a request', async () => {
      wallet.lockUserForUpdate.mockResolvedValue({ won_balance: 100, operator_id: 'op-1' });
      await expect(service.request('u1', 'op-1', { amount: 200, telebirrAccount: '0911...' })).rejects.toThrow(ForbiddenException);
      expect(tx.withdrawalRequest.create).not.toHaveBeenCalled();
      expect(tx.telegramUser.update).not.toHaveBeenCalled();
    });

    it("rejects a request when the locked player row belongs to a different operator than the caller's", async () => {
      wallet.lockUserForUpdate.mockResolvedValue({ won_balance: 500, operator_id: 'op-other' });
      await expect(service.request('u1', 'op-1', { amount: 200, telebirrAccount: '0911...' })).rejects.toThrow(ForbiddenException);
      expect(tx.withdrawalRequest.create).not.toHaveBeenCalled();
      expect(tx.telegramUser.update).not.toHaveBeenCalled();
    });

    it('places a hold: decrements won_balance and writes a WITHDRAWAL_HOLD debit atomically with the request row', async () => {
      wallet.lockUserForUpdate.mockResolvedValue({ won_balance: 500, operator_id: 'op-1' });
      tx.withdrawalRequest.create.mockResolvedValue({ id: 'w1', amount: 200 });

      await service.request('u1', 'op-1', { amount: 200, telebirrAccount: '0911...' });

      expect(tx.telegramUser.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { wonBalance: { decrement: 200 } } });
      expect(wallet.writeEntry).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ entryType: 'WITHDRAWAL_HOLD', direction: 'debit', amount: 200, relatedEntityId: 'w1' }),
      );
    });
  });

  describe('cancel', () => {
    it('throws ConflictException when not owned or not pending, without touching the balance', async () => {
      tx.withdrawalRequest.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.cancel('w1', 'u1')).rejects.toThrow(ConflictException);
      expect(tx.telegramUser.update).not.toHaveBeenCalled();
    });

    it('releases the hold back to won_balance on cancel', async () => {
      tx.withdrawalRequest.updateMany.mockResolvedValue({ count: 1 });
      tx.withdrawalRequest.findUniqueOrThrow.mockResolvedValue({ id: 'w1', telegramUserId: 'u1', amount: 200 });

      await service.cancel('w1', 'u1');

      expect(tx.telegramUser.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { wonBalance: { increment: 200 } } });
      expect(wallet.writeEntry).toHaveBeenCalledWith(tx, expect.objectContaining({ entryType: 'WITHDRAWAL_RELEASE', direction: 'credit', amount: 200 }));
    });
  });

  describe('review', () => {
    it('rejects a second concurrent "approve" on an already-processed request', async () => {
      tx.withdrawalRequest.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.review('w1', 'admin1', 'approve', {})).rejects.toThrow(ConflictException);
      expect(tx.telegramUser.update).not.toHaveBeenCalled();
    });

    it('approve requires fromStatus=pending and applies no balance change', async () => {
      tx.withdrawalRequest.updateMany.mockResolvedValue({ count: 1 });
      tx.withdrawalRequest.findUniqueOrThrow.mockResolvedValue({ id: 'w1', telegramUserId: 'u1', amount: 200, status: 'approved' });
      tx.telegramUser.findUnique.mockResolvedValue({ telegramUserId: 999n });

      await service.review('w1', 'admin1', 'approve', {});

      expect(tx.withdrawalRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'w1', status: 'pending' }, data: expect.objectContaining({ status: 'approved' }) }),
      );
      expect(tx.telegramUser.update).not.toHaveBeenCalled();
      expect(wallet.writeEntry).not.toHaveBeenCalled();
      expect(metrics.withdrawalsTotal.inc).toHaveBeenCalledWith({ decision: 'approve' });
    });

    it('reject requires fromStatus=pending and releases the hold back to won_balance', async () => {
      tx.withdrawalRequest.updateMany.mockResolvedValue({ count: 1 });
      tx.withdrawalRequest.findUniqueOrThrow.mockResolvedValue({ id: 'w1', telegramUserId: 'u1', amount: 200, status: 'rejected' });
      tx.telegramUser.findUnique.mockResolvedValue({ telegramUserId: 999n });

      await service.review('w1', 'admin1', 'reject', { rejectionReason: 'invalid account' });

      expect(tx.withdrawalRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'w1', status: 'pending' } }),
      );
      expect(tx.telegramUser.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { wonBalance: { increment: 200 } } });
      expect(wallet.writeEntry).toHaveBeenCalledWith(tx, expect.objectContaining({ entryType: 'WITHDRAWAL_RELEASE', direction: 'credit' }));
    });

    it('mark_paid requires fromStatus=approved (not pending) and debits the hold permanently', async () => {
      tx.withdrawalRequest.updateMany.mockResolvedValue({ count: 1 });
      tx.withdrawalRequest.findUniqueOrThrow.mockResolvedValue({ id: 'w1', telegramUserId: 'u1', amount: 200, status: 'paid' });
      tx.telegramUser.findUnique.mockResolvedValue({ telegramUserId: 999n });

      await service.review('w1', 'admin1', 'mark_paid', { proofBase64: 'data:image/png;base64,xyz' });

      expect(storage.saveReceipt).toHaveBeenCalledWith('data:image/png;base64,xyz', 'withdrawals');
      expect(tx.withdrawalRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'w1', status: 'approved' }, data: expect.objectContaining({ paymentProofPath: '/proofs/x.png' }) }),
      );
      expect(wallet.writeEntry).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ entryType: 'WITHDRAWAL_PAID', direction: 'debit', amount: 200 }),
      );
      expect(tx.telegramUser.update).not.toHaveBeenCalled(); // hold was already deducted from won_balance at request() time
    });

    it('mark_paid without fromStatus=approved is rejected before any file save side effect matters', async () => {
      tx.withdrawalRequest.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.review('w1', 'admin1', 'mark_paid', {})).rejects.toThrow(ConflictException);
      expect(wallet.writeEntry).not.toHaveBeenCalled();
    });
  });
});

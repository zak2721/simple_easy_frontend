import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DepositsService } from './deposits.service';

/**
 * Audit spec §31 / finding SEC-8: "two admins approve the same deposit —
 * only one approval should change the balance." review()'s idempotency is
 * the single most important behavior to lock down here — the whole guard is
 * one `updateMany` WHERE clause, so a regression there is a real double-credit
 * bug, not just a test nitpick.
 */
describe('DepositsService', () => {
  let prisma: {
    manualDeposit: {
      create: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      findUniqueOrThrow: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let wallet: { writeEntry: ReturnType<typeof vi.fn> };
  let storage: { saveReceipt: ReturnType<typeof vi.fn>; signPath: ReturnType<typeof vi.fn> };
  let settings: { getGameConfig: ReturnType<typeof vi.fn> };
  let audit: { log: ReturnType<typeof vi.fn> };
  let telegram: { sendMessage: ReturnType<typeof vi.fn> };
  let metrics: { depositsTotal: { inc: ReturnType<typeof vi.fn> } };
  let service: DepositsService;
  let tx: {
    manualDeposit: { updateMany: ReturnType<typeof vi.fn>; findUniqueOrThrow: ReturnType<typeof vi.fn> };
    telegramUser: { update: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
    $executeRaw: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    tx = {
      manualDeposit: { updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
      telegramUser: { update: vi.fn(), findUnique: vi.fn() },
      $executeRaw: vi.fn(),
    };
    prisma = {
      manualDeposit: { create: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
      $transaction: vi.fn(async (cb) => cb(tx)),
    };
    wallet = { writeEntry: vi.fn() };
    storage = { saveReceipt: vi.fn().mockResolvedValue({ path: '/receipts/x.png', mime: 'image/png' }), signPath: vi.fn() };
    settings = { getGameConfig: vi.fn().mockResolvedValue({ minDepositEtb: 30 }) };
    audit = { log: vi.fn() };
    telegram = { sendMessage: vi.fn() };
    metrics = { depositsTotal: { inc: vi.fn() } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new DepositsService(prisma as any, wallet as any, storage as any, settings as any, audit as any, telegram as any, metrics as any);
  });

  describe('submit', () => {
    it('rejects an amount below the configured minimum deposit', async () => {
      await expect(
        service.submit('u1', 'op-1', { amount: 29, receiptBase64: 'data:...', telebirrReference: 'TXN123456' }),
      ).rejects.toThrow(BadRequestException);
      expect(storage.saveReceipt).not.toHaveBeenCalled();
      expect(prisma.manualDeposit.create).not.toHaveBeenCalled();
    });

    it('accepts an amount exactly at the configured minimum, and stores the Telebirr reference', async () => {
      prisma.manualDeposit.create.mockResolvedValue({ id: 'd1' });
      await service.submit('u1', 'op-1', { amount: 30, receiptBase64: 'data:...', telebirrReference: 'TXN123456' });
      expect(prisma.manualDeposit.create).toHaveBeenCalledWith({
        data: {
          telegramUserId: 'u1',
          operatorId: 'op-1',
          amount: 30,
          receiptPath: '/receipts/x.png',
          receiptMimeType: 'image/png',
          telebirrReference: 'TXN123456',
          notes: undefined,
        },
      });
    });
  });

  describe('cancel', () => {
    it('throws ConflictException when the deposit is not pending or not owned by this user', async () => {
      prisma.manualDeposit.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.cancel('d1', 'u1')).rejects.toThrow(ConflictException);
      expect(prisma.manualDeposit.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('cancels and returns the updated row when owned and pending', async () => {
      prisma.manualDeposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.manualDeposit.findUniqueOrThrow.mockResolvedValue({ id: 'd1', status: 'cancelled' });
      const result = await service.cancel('d1', 'u1');
      expect(prisma.manualDeposit.updateMany).toHaveBeenCalledWith({
        where: { id: 'd1', telegramUserId: 'u1', status: 'pending' },
        data: { status: 'cancelled' },
      });
      expect(result).toEqual({ id: 'd1', status: 'cancelled' });
    });
  });

  describe('review', () => {
    it('throws ConflictException on a second concurrent approval instead of crediting twice', async () => {
      tx.manualDeposit.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.review('d1', 'admin1', 'approve', {})).rejects.toThrow(ConflictException);
      expect(tx.telegramUser.update).not.toHaveBeenCalled();
      expect(wallet.writeEntry).not.toHaveBeenCalled();
    });

    it('credits depositedBalance and writes a ledger entry exactly once on approval', async () => {
      tx.manualDeposit.updateMany.mockResolvedValue({ count: 1 });
      tx.manualDeposit.findUniqueOrThrow.mockResolvedValue({ id: 'd1', telegramUserId: 'u1', amount: 100, status: 'approved' });
      tx.telegramUser.findUnique.mockResolvedValue({ telegramUserId: 12345n });

      await service.review('d1', 'admin1', 'approve', {});

      expect(tx.telegramUser.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { depositedBalance: { increment: 100 } },
      });
      expect(wallet.writeEntry).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ telegramUserId: 'u1', entryType: 'MANUAL_TELEBIRR_DEPOSIT', direction: 'credit', amount: 100 }),
      );
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DEPOSIT_APPROVED' }));
      expect(metrics.depositsTotal.inc).toHaveBeenCalledWith({ decision: 'approve' });
    });

    it('does not touch the balance or ledger on rejection', async () => {
      tx.manualDeposit.updateMany.mockResolvedValue({ count: 1 });
      tx.manualDeposit.findUniqueOrThrow.mockResolvedValue({ id: 'd1', telegramUserId: 'u1', amount: 100, status: 'rejected' });
      tx.telegramUser.findUnique.mockResolvedValue({ telegramUserId: 12345n });

      await service.review('d1', 'admin1', 'reject', { rejectionReason: 'blurry receipt' });

      expect(tx.telegramUser.update).not.toHaveBeenCalled();
      expect(wallet.writeEntry).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DEPOSIT_REJECTED', reason: 'blurry receipt' }));
    });

    it('finding DEP-1: surfaces a clear conflict, not a raw 500, when approving would violate the partial unique index on an already-approved Telebirr reference', async () => {
      tx.manualDeposit.updateMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`telebirr_reference`)', {
          code: 'P2002',
          clientVersion: '5.22.0',
        }),
      );
      await expect(service.review('d2', 'admin1', 'approve', {})).rejects.toThrow(ConflictException);
    });

    it('an operator-bound admin cannot review another operator\'s deposit: the scope is part of the WHERE clause', async () => {
      tx.manualDeposit.updateMany.mockResolvedValue({ count: 0 }); // no pending row matches inside this admin's operator
      await expect(service.review('d1', 'admin1', 'approve', {}, 'op-other')).rejects.toThrow();
      expect(tx.manualDeposit.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'd1', status: 'pending', operatorId: 'op-other' } }));
      expect(wallet.writeEntry).not.toHaveBeenCalled();
    });

    it('escapes HTML in an admin rejectionReason before it reaches the player Telegram message', async () => {
      tx.manualDeposit.updateMany.mockResolvedValue({ count: 1 });
      tx.manualDeposit.findUniqueOrThrow.mockResolvedValue({ id: 'd1', telegramUserId: 'u1', operatorId: 'op-1', amount: 100, status: 'rejected' });
      tx.telegramUser.findUnique.mockResolvedValue({ telegramUserId: 12345n });

      await service.review('d1', 'admin1', 'reject', { rejectionReason: '<a href="evil">click</a>' });

      // Sent from the deposit's own operator bot, to the player's chat.
      const [botOperatorId, chatId, sentText] = telegram.sendMessage.mock.calls[0];
      expect(botOperatorId).toBe('op-1');
      expect(chatId).toBe(12345);
      expect(sentText).toContain('&lt;a href="evil"&gt;click&lt;/a&gt;');
      expect(sentText).not.toContain('<a href=');
    });
  });
});

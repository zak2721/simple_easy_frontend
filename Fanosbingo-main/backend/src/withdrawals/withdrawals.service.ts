import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { StorageService } from '../storage/storage.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { TelegramService, escapeTelegramHtml } from '../telegram/telegram.service';
import { MetricsService } from '../metrics/metrics.service';
import { setTenantOnTx } from '../common/tenant/rls';

@Injectable()
export class WithdrawalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly telegram: TelegramService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Only WON balance is withdrawable (spec: "only your winnings can be
   * withdrawn"). Places a HOLD immediately (debits won_balance) so the same
   * winnings can't be spent on a cartela purchase AND withdrawn — this is
   * the row-locked read-then-decide pattern, same as CardsService.
   */
  async request(userId: string, operatorId: string, params: { amount: number; telebirrAccount: string; notes?: string }) {
    const config = await this.settings.getGameConfig(operatorId);
    if (params.amount < config.minWithdrawalEtb) {
      throw new BadRequestException(`Minimum withdrawal is ${config.minWithdrawalEtb} ETB`);
    }

    return this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx, operatorId);
      const locked = await this.wallet.lockUserForUpdate(tx, userId);
      if (locked.operator_id !== operatorId) throw new ForbiddenException('Account does not belong to this operator');
      if (Number(locked.won_balance) < params.amount) {
        throw new ForbiddenException('Insufficient withdrawable (won) balance');
      }

      await tx.telegramUser.update({ where: { id: userId }, data: { wonBalance: { decrement: params.amount } } });

      const withdrawal = await tx.withdrawalRequest.create({
        data: { telegramUserId: userId, operatorId, amount: params.amount, telebirrAccount: params.telebirrAccount, notes: params.notes },
      });

      await this.wallet.writeEntry(tx, {
        telegramUserId: userId,
        operatorId,
        entryType: 'WITHDRAWAL_HOLD',
        direction: 'debit',
        amount: params.amount,
        relatedEntityType: 'withdrawal_request',
        relatedEntityId: withdrawal.id,
      });

      return withdrawal;
    });
  }

  async cancel(withdrawalId: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx);
      const updateResult = await tx.withdrawalRequest.updateMany({
        where: { id: withdrawalId, telegramUserId: userId, status: 'pending' },
        data: { status: 'cancelled' },
      });
      if (updateResult.count === 0) throw new ConflictException('Only a pending withdrawal you own can be cancelled');

      const withdrawal = await tx.withdrawalRequest.findUniqueOrThrow({ where: { id: withdrawalId } });
      await tx.telegramUser.update({ where: { id: userId }, data: { wonBalance: { increment: withdrawal.amount } } });
      await this.wallet.writeEntry(tx, {
        telegramUserId: userId,
        operatorId: withdrawal.operatorId,
        entryType: 'WITHDRAWAL_RELEASE',
        direction: 'credit',
        amount: withdrawal.amount,
        relatedEntityType: 'withdrawal_request',
        relatedEntityId: withdrawal.id,
        note: 'Player cancelled',
      });
      return withdrawal;
    });
  }

  async listForUser(userId: string) {
    return this.prisma.withdrawalRequest.findMany({ where: { telegramUserId: userId }, orderBy: { requestedAt: 'desc' } });
  }

  async listForAdmin(status?: string, operatorId?: string | null) {
    return this.prisma.withdrawalRequest.findMany({
      where: { ...(status ? { status: status as never } : {}), ...(operatorId ? { operatorId } : {}) },
      orderBy: { requestedAt: 'desc' },
      include: {
        user: { select: { telegramUserId: true, username: true, firstName: true } },
        operator: { select: { slug: true, name: true } },
      },
    });
  }

  getProofUrl(withdrawal: { paymentProofPath: string | null }) {
    return withdrawal.paymentProofPath ? this.storage.signPath(withdrawal.paymentProofPath) : null;
  }

  /** `operatorId` = the caller's operator scope; null/undefined = platform admin (all operators). */
  async findOne(withdrawalId: string, operatorId?: string | null) {
    const withdrawal = await this.prisma.withdrawalRequest.findFirst({ where: { id: withdrawalId, ...(operatorId ? { operatorId } : {}) } });
    if (!withdrawal) throw new BadRequestException('Withdrawal not found');
    return withdrawal;
  }

  async review(
    withdrawalId: string,
    adminId: string,
    decision: 'approve' | 'reject' | 'mark_paid',
    extra: { proofBase64?: string; rejectionReason?: string; adminNote?: string },
    scopeOperatorId?: string | null,
  ) {
    // File I/O happens outside the transaction — a DB transaction connection
    // shouldn't sit open across a filesystem write.
    const proofPath = decision === 'mark_paid' && extra.proofBase64
      ? (await this.storage.saveReceipt(extra.proofBase64, 'withdrawals')).path
      : undefined;

    const fromStatus = decision === 'approve' ? 'pending' : decision === 'mark_paid' ? 'approved' : 'pending';
    const toStatus = decision === 'approve' ? 'approved' : decision === 'mark_paid' ? 'paid' : 'rejected';

    const { withdrawal, tgId } = await this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx, scopeOperatorId ?? null);
      // Operator scope is part of the WHERE clause, so an operator admin can never act on another operator's withdrawal.
      const updateResult = await tx.withdrawalRequest.updateMany({
        where: { id: withdrawalId, status: fromStatus, ...(scopeOperatorId ? { operatorId: scopeOperatorId } : {}) },
        data: {
          status: toStatus,
          reviewedByAdminId: adminId,
          reviewedAt: new Date(),
          paidAt: decision === 'mark_paid' ? new Date() : undefined,
          paymentProofPath: proofPath,
          rejectionReason: decision === 'reject' ? extra.rejectionReason : undefined,
          adminNote: extra.adminNote,
        },
      });
      if (updateResult.count === 0) {
        throw new ConflictException(`Withdrawal must be '${fromStatus}' for this action — already processed?`);
      }

      const withdrawal = await tx.withdrawalRequest.findUniqueOrThrow({ where: { id: withdrawalId } });

      if (decision === 'reject') {
        // Release the hold back to the player's won_balance.
        await tx.telegramUser.update({ where: { id: withdrawal.telegramUserId }, data: { wonBalance: { increment: withdrawal.amount } } });
        await this.wallet.writeEntry(tx, {
          telegramUserId: withdrawal.telegramUserId,
          operatorId: withdrawal.operatorId,
          entryType: 'WITHDRAWAL_RELEASE',
          direction: 'credit',
          amount: withdrawal.amount,
          relatedEntityType: 'withdrawal_request',
          relatedEntityId: withdrawal.id,
          note: extra.rejectionReason,
        });
      }
      if (decision === 'mark_paid') {
        await this.wallet.writeEntry(tx, {
          telegramUserId: withdrawal.telegramUserId,
          operatorId: withdrawal.operatorId,
          entryType: 'WITHDRAWAL_PAID',
          direction: 'debit',
          amount: withdrawal.amount,
          relatedEntityType: 'withdrawal_request',
          relatedEntityId: withdrawal.id,
          note: 'Paid via manual Telebirr transfer',
        });
      }

      const user = await tx.telegramUser.findUnique({ where: { id: withdrawal.telegramUserId }, select: { telegramUserId: true } });
      return { withdrawal, tgId: user?.telegramUserId ?? null };
    });

    await this.audit.log({
      actorType: 'admin',
      adminId,
      operatorId: withdrawal.operatorId,
      action: decision === 'approve' ? 'WITHDRAWAL_APPROVED' : decision === 'mark_paid' ? 'WITHDRAWAL_COMPLETED' : 'WITHDRAWAL_REJECTED',
      entityType: 'withdrawal_request',
      entityId: withdrawalId,
      newState: { status: toStatus },
      reason: extra.rejectionReason,
    });

    if (tgId !== null) {
      const message =
        decision === 'mark_paid'
          ? `💸 Your withdrawal of ${withdrawal.amount} ETB has been paid via Telebirr.`
          : decision === 'reject'
            ? `❌ Your withdrawal was rejected${extra.rejectionReason ? `: ${escapeTelegramHtml(extra.rejectionReason)}` : '.'}`
            : `⏳ Your withdrawal of ${withdrawal.amount} ETB was approved and will be paid shortly.`;
      void this.telegram.sendMessage(withdrawal.operatorId, Number(tgId), message);
    }

    this.metrics.withdrawalsTotal.inc({ decision });
    return withdrawal;
  }
}

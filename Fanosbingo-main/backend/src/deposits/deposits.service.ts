import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { StorageService } from '../storage/storage.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { TelegramService, escapeTelegramHtml } from '../telegram/telegram.service';
import { MetricsService } from '../metrics/metrics.service';
import { setTenantOnTx } from '../common/tenant/rls';

@Injectable()
export class DepositsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly telegram: TelegramService,
    private readonly metrics: MetricsService,
  ) {}

  async submit(userId: string, operatorId: string, params: { amount: number; receiptBase64: string; telebirrReference: string; notes?: string }) {
    const config = await this.settings.getGameConfig(operatorId);
    if (params.amount < config.minDepositEtb) {
      throw new BadRequestException(`Minimum deposit is ${config.minDepositEtb} ETB`);
    }

    const { path: receiptPath, mime } = await this.storage.saveReceipt(params.receiptBase64, 'deposits');

    return this.prisma.manualDeposit.create({
      data: {
        telegramUserId: userId,
        operatorId,
        amount: params.amount,
        receiptPath,
        receiptMimeType: mime,
        telebirrReference: params.telebirrReference,
        notes: params.notes,
      },
    });
  }

  /** `operatorId` = the caller's operator scope; null/undefined = platform admin (all operators). */
  async findOne(depositId: string, operatorId?: string | null) {
    const deposit = await this.prisma.manualDeposit.findFirst({ where: { id: depositId, ...(operatorId ? { operatorId } : {}) } });
    if (!deposit) throw new BadRequestException('Deposit not found');
    return deposit;
  }

  /**
   * Audit finding SEC-8 (Low): this used to `findUnique` by id alone, then
   * compare ownership in application code as a separate step, then `update`
   * by id alone again — correct today, but a shape that silently regresses
   * into an IDOR if a future edit drops the comparison. Folding ownership +
   * status into the SAME updateMany's WHERE clause (matching how
   * WithdrawalsService.cancel already does it) makes that impossible: the
   * database itself won't touch a row that doesn't match all three
   * conditions, no application-code check to accidentally remove.
   */
  async cancel(depositId: string, userId: string) {
    const updateResult = await this.prisma.manualDeposit.updateMany({
      where: { id: depositId, telegramUserId: userId, status: 'pending' },
      data: { status: 'cancelled' },
    });
    if (updateResult.count === 0) {
      throw new ConflictException('Only a pending deposit you own can be cancelled');
    }
    return this.prisma.manualDeposit.findUniqueOrThrow({ where: { id: depositId } });
  }

  async listForUser(userId: string) {
    return this.prisma.manualDeposit.findMany({ where: { telegramUserId: userId }, orderBy: { submittedAt: 'desc' } });
  }

  async listForAdmin(status?: string, operatorId?: string | null) {
    return this.prisma.manualDeposit.findMany({
      where: { ...(status ? { status: status as never } : {}), ...(operatorId ? { operatorId } : {}) },
      orderBy: { submittedAt: 'desc' },
      include: {
        user: { select: { telegramUserId: true, username: true, firstName: true } },
        operator: { select: { slug: true, name: true } },
      },
    });
  }

  getReceiptUrl(deposit: { receiptPath: string | null }) {
    return deposit.receiptPath ? this.storage.signPath(deposit.receiptPath) : null;
  }

  /**
   * Approve/reject a deposit. Idempotent by construction: the WHERE clause
   * only matches rows still `pending`, so a double-click (or two admins
   * racing) results in the second call updating 0 rows — we detect that and
   * throw ConflictException instead of crediting twice (spec §31: "Two
   * admins approve the same deposit — only one approval should change the balance").
   *
   * Finding DEP-1 (High): the SAME physical Telebirr payment can still be
   * submitted as two separate pending rows (nothing stops a player from
   * doing that, honestly or not) — this method doesn't try to prevent that.
   * What it prevents is BOTH of them ever being approved: the partial unique
   * index on (telebirr_reference) WHERE status='approved' means the second
   * approval's UPDATE fails at the database level (P2002), caught below and
   * surfaced as a clear conflict rather than a raw 500.
   */
  async review(
    depositId: string,
    adminId: string,
    decision: 'approve' | 'reject',
    extra: { rejectionReason?: string; adminNote?: string },
    scopeOperatorId?: string | null,
  ) {
    try {
      return await this.reviewInTransaction(depositId, adminId, decision, extra, scopeOperatorId);
    } catch (e: unknown) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('DUPLICATE_TELEBIRR_REFERENCE — another deposit with this Telebirr reference was already approved');
      }
      throw e;
    }
  }

  private async reviewInTransaction(
    depositId: string,
    adminId: string,
    decision: 'approve' | 'reject',
    extra: { rejectionReason?: string; adminNote?: string },
    scopeOperatorId?: string | null,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx, scopeOperatorId ?? null);
      // Operator scope is part of the WHERE clause, so an operator admin can never approve another operator's deposit.
      const updateResult = await tx.manualDeposit.updateMany({
        where: { id: depositId, status: 'pending', ...(scopeOperatorId ? { operatorId: scopeOperatorId } : {}) },
        data: {
          status: decision === 'approve' ? 'approved' : 'rejected',
          reviewedByAdminId: adminId,
          reviewedAt: new Date(),
          rejectionReason: decision === 'reject' ? extra.rejectionReason : undefined,
          adminNote: extra.adminNote,
        },
      });
      if (updateResult.count === 0) {
        throw new ConflictException('Deposit already reviewed (or not pending) — no change applied');
      }

      const deposit = await tx.manualDeposit.findUniqueOrThrow({ where: { id: depositId } });

      if (decision === 'approve') {
        await tx.telegramUser.update({
          where: { id: deposit.telegramUserId },
          data: { depositedBalance: { increment: deposit.amount } },
        });
        await this.wallet.writeEntry(tx, {
          telegramUserId: deposit.telegramUserId,
          operatorId: deposit.operatorId,
          entryType: 'MANUAL_TELEBIRR_DEPOSIT',
          direction: 'credit',
          amount: deposit.amount,
          relatedEntityType: 'manual_deposit',
          relatedEntityId: deposit.id,
          note: 'Manual Telebirr deposit',
        });
      }

      const user = await tx.telegramUser.findUnique({ where: { id: deposit.telegramUserId }, select: { telegramUserId: true } });
      return { deposit, tgId: user?.telegramUserId ?? null };
    });

    const { deposit, tgId } = result;
    await this.audit.log({
      actorType: 'admin',
      adminId,
      operatorId: deposit.operatorId,
      action: decision === 'approve' ? 'DEPOSIT_APPROVED' : 'DEPOSIT_REJECTED',
      entityType: 'manual_deposit',
      entityId: depositId,
      newState: { status: deposit.status, amount: Number(deposit.amount) },
      reason: extra.rejectionReason,
    });

    if (tgId !== null) {
      void this.telegram.sendMessage(
        deposit.operatorId,
        Number(tgId),
        decision === 'approve'
          ? `✅ Your deposit of ${deposit.amount} ETB was approved.`
          : `❌ Your deposit was rejected${extra.rejectionReason ? `: ${escapeTelegramHtml(extra.rejectionReason)}` : '.'}`,
      );
    }

    this.metrics.depositsTotal.inc({ decision });
    return deposit;
  }
}

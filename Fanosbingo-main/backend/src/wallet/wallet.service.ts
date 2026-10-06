import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, LedgerEntryType, LedgerDirection } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { setTenantOnTx } from '../common/tenant/rls';

export interface LedgerWriteInput {
  telegramUserId: string; // TelegramUser.id (uuid)
  /** Must be the player's own operator — take it from lockUserForUpdate()'s row, never from request input. */
  operatorId: string;
  entryType: LedgerEntryType;
  direction: LedgerDirection;
  amount: Prisma.Decimal | number | string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  note?: string;
}

/**
 * The financial ledger. Every balance change MUST go through writeEntry()
 * inside the SAME Prisma transaction as the balance-column update, so the
 * ledger and the cached balance columns can never drift.
 *
 * Concurrency: callers are responsible for locking the TelegramUser row
 * first (see `lockUserForUpdate`) before reading a balance and deciding
 * whether an operation is allowed — this service does not lock on its own,
 * because the lock must cover the caller's read-then-decide logic too
 * (e.g. CardsService checking "is balance >= price" before writing the debit).
 */
@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * SELECT ... FOR UPDATE equivalent. Must be called inside a
   * `prisma.$transaction(async (tx) => ...)` callback, passing that `tx` in.
   * This is the row lock that prevents two concurrent requests (e.g. two
   * cartela purchases, or an admin double-clicking "Approve") from both
   * reading the same stale balance.
   */
  async lockUserForUpdate(tx: Prisma.TransactionClient, telegramUserId: string) {
    const rows = await tx.$queryRaw<
      Array<{ id: string; operator_id: string; deposited_balance: Prisma.Decimal; won_balance: Prisma.Decimal; bonus_balance: Prisma.Decimal }>
    >`SELECT id, operator_id, deposited_balance, won_balance, bonus_balance FROM telegram_users WHERE id = ${telegramUserId} FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new BadRequestException('User not found');
    return row;
  }

  /** Writes one immutable ledger row. Must run inside the caller's transaction. */
  async writeEntry(tx: Prisma.TransactionClient, entry: LedgerWriteInput) {
    if (Number(entry.amount) <= 0) throw new BadRequestException('Ledger amount must be positive');
    return tx.walletLedgerEntry.create({
      data: {
        telegramUserId: entry.telegramUserId,
        operatorId: entry.operatorId,
        entryType: entry.entryType,
        direction: entry.direction,
        amount: entry.amount,
        relatedEntityType: entry.relatedEntityType,
        relatedEntityId: entry.relatedEntityId,
        note: entry.note,
      },
    });
  }

  async getWallet(telegramUserId: string) {
    const user = await this.prisma.telegramUser.findUnique({
      where: { id: telegramUserId },
      select: { depositedBalance: true, wonBalance: true, bonusBalance: true },
    });
    if (!user) throw new BadRequestException('User not found');

    const pendingWithdrawal = await this.prisma.withdrawalRequest.aggregate({
      where: { telegramUserId, status: { in: ['pending', 'approved'] } },
      _sum: { amount: true },
    });
    const onHold = pendingWithdrawal._sum.amount ?? new Prisma.Decimal(0);

    const total = Number(user.depositedBalance) + Number(user.wonBalance) + Number(user.bonusBalance);
    // Production Readiness Audit (Low-Medium): `won_balance` is already net of
    // any hold — WithdrawalsService.request() debits it as a HOLD the moment
    // a withdrawal is requested (see withdrawals.service.ts:43), it isn't
    // debited again on approval. Subtracting `onHold` here a second time
    // understated what the player could actually still withdraw. `on_hold`
    // is kept in the response below purely as informational context (how
    // much of their history is tied up in in-flight requests), not as
    // something to net out of a balance that already excludes it.
    const withdrawable = Number(user.wonBalance);

    return {
      deposited_balance: Number(user.depositedBalance),
      won_balance: Number(user.wonBalance),
      bonus_balance: Number(user.bonusBalance),
      total_balance: total,
      on_hold: Number(onHold),
      withdrawable,
    };
  }

  async getLedger(telegramUserId: string, take = 100) {
    return this.prisma.walletLedgerEntry.findMany({
      where: { telegramUserId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /** A Telegram id is only unique within one operator — the same person has a separate account (and wallet) per operator. */
  async findByTelegramNumericId(operatorId: string, telegramNumericId: number) {
    const user = await this.prisma.telegramUser.findUnique({
      where: { operatorId_telegramUserId: { operatorId, telegramUserId: BigInt(telegramNumericId) } },
    });
    if (!user) throw new BadRequestException('Player not found');
    return user;
  }

  /**
   * The ONLY sanctioned way to correct a wallet — never `UPDATE telegram_users
   * SET deposited_balance = ...` directly (spec §8: "SUPER_ADMIN must never
   * directly overwrite a balance"). Every adjustment is a signed delta against
   * one specific balance bucket, requires a reason, is written through the
   * same lock+ledger+audit path as every other financial mutation, and is
   * fully reversible in principle (an over-correction is just another
   * adjustment in the opposite direction — there is no destructive "set" path
   * to misuse).
   */
  async adjustBalance(params: {
    telegramUserId: string;
    bucket: 'deposited' | 'won' | 'bonus';
    amount: number;
    direction: LedgerDirection;
    reason: string;
    actingAdminId: string;
  }) {
    if (!params.reason || params.reason.trim().length < 3) {
      throw new BadRequestException('A reason (at least 3 characters) is required for a wallet adjustment');
    }
    if (params.amount <= 0) throw new BadRequestException('Adjustment amount must be positive');

    const result = await this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx);
      const locked = await this.lockUserForUpdate(tx, params.telegramUserId);

      const field = params.bucket === 'deposited' ? 'depositedBalance' : params.bucket === 'won' ? 'wonBalance' : 'bonusBalance';
      const currentValue = Number(locked[params.bucket === 'deposited' ? 'deposited_balance' : params.bucket === 'won' ? 'won_balance' : 'bonus_balance']);

      if (params.direction === 'debit' && currentValue < params.amount) {
        throw new BadRequestException(`Cannot debit ${params.amount} — current ${params.bucket} balance is only ${currentValue}`);
      }

      const updated = await tx.telegramUser.update({
        where: { id: params.telegramUserId },
        data: { [field]: params.direction === 'credit' ? { increment: params.amount } : { decrement: params.amount } },
      });

      const entry = await this.writeEntry(tx, {
        telegramUserId: params.telegramUserId,
        operatorId: locked.operator_id,
        entryType: 'ADJUSTMENT',
        direction: params.direction,
        amount: params.amount,
        note: `[${params.bucket}] ${params.reason}`,
      });

      // Only pass along plain JSON-serializable fields — `updated` is the raw
      // Prisma row and carries a BigInt `telegramUserId`, which throws in
      // JSON.stringify if returned as-is to a controller.
      const wallet = {
        deposited_balance: Number(updated.depositedBalance),
        won_balance: Number(updated.wonBalance),
        bonus_balance: Number(updated.bonusBalance),
      };

      return { entry, wallet, currentValue, operatorId: locked.operator_id };
    });

    // Audit write happens AFTER the financial transaction commits, on the
    // normal (non-tx) connection — writing it from inside the $transaction
    // callback above would use a different DB connection than the one
    // holding the row lock, breaking atomicity rather than preserving it.
    await this.audit.log({
      actorType: 'admin',
      adminId: params.actingAdminId,
      operatorId: result.operatorId,
      action: 'WALLET_ADJUSTED',
      entityType: 'telegram_user',
      entityId: params.telegramUserId,
      previousState: { [params.bucket]: result.currentValue },
      newState: { [params.bucket]: params.direction === 'credit' ? result.currentValue + params.amount : result.currentValue - params.amount },
      reason: params.reason,
    });

    return result;
  }
}

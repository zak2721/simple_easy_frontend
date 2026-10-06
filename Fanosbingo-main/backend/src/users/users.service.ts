import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { SettingsService } from '../settings/settings.service';
import { DepositsService } from '../deposits/deposits.service';
import { WithdrawalsService } from '../withdrawals/withdrawals.service';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly settings: SettingsService,
    private readonly deposits: DepositsService,
    private readonly withdrawals: WithdrawalsService,
  ) {}

  async setLanguage(userId: string, languageCode: string) {
    await this.prisma.telegramUser.update({ where: { id: userId }, data: { languageCode } });
    return { success: true };
  }

  /** `themeId: null` reverts to whatever the theme catalog currently resolves as the system default. */
  async setTheme(userId: string, themeId: string | null) {
    if (themeId) {
      const theme = await this.prisma.theme.findUnique({ where: { id: themeId } });
      if (!theme || !theme.isActive) throw new BadRequestException('Theme not found or inactive');
    }
    await this.prisma.telegramUser.update({ where: { id: userId }, data: { selectedThemeId: themeId } });
    return { success: true };
  }

  /**
   * Replaces the `my-finance` edge function. Field names are deliberately
   * snake_case to match the existing frontend's FinanceData type exactly
   * (src/lib/useFinance.ts) — Prisma models return camelCase by default, so
   * this is an explicit serialization boundary, not an accident.
   */
  async myFinance(userId: string, operatorId: string) {
    const [wallet, deposits, withdrawalList, ledger, telebirr] = await Promise.all([
      this.wallet.getWallet(userId),
      this.deposits.listForUser(userId),
      this.withdrawals.listForUser(userId),
      this.wallet.getLedger(userId),
      // The player's own operator's Telebirr account — the one they must pay into.
      this.settings.getTelebirrAccount(operatorId),
    ]);

    return {
      wallet,
      deposits: deposits.map((d) => ({
        id: d.id,
        amount: Number(d.amount),
        notes: d.notes,
        status: d.status,
        rejection_reason: d.rejectionReason,
        submitted_at: d.submittedAt,
      })),
      withdrawals: withdrawalList.map((w) => ({
        id: w.id,
        amount: Number(w.amount),
        telebirr_account: w.telebirrAccount,
        notes: w.notes,
        status: w.status,
        rejection_reason: w.rejectionReason,
        requested_at: w.requestedAt,
        paid_at: w.paidAt,
      })),
      ledger: ledger.map((l) => ({
        id: l.id,
        entry_type: l.entryType,
        direction: l.direction,
        amount: Number(l.amount),
        note: l.note,
        created_at: l.createdAt,
      })),
      telebirr,
    };
  }
}

import { Injectable } from '@nestjs/common';
import { LedgerEntryType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const day = x.getDay(); // 0=Sun
  const diff = (day + 6) % 7; // days since Monday
  x.setDate(x.getDate() - diff);
  return x;
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function startOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 0, 1);
}

export type ReportPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'alltime';

/** Ledger entry types summed into every period snapshot, and the report field each feeds. */
const SNAPSHOT_TYPES: Array<[LedgerEntryType, string]> = [
  ['MANUAL_TELEBIRR_DEPOSIT', 'deposits'],
  ['WITHDRAWAL_PAID', 'withdrawals_paid'],
  ['HOUSE_REVENUE', 'house_revenue'],
  ['WINNING_CREDIT', 'winner_payouts'],
  ['GAME_REFUND', 'refunds'],
  ['BONUS_GRANT', 'bonus_activity'],
];

/** `scope` everywhere below: an operator id, or null = every operator (platform admin, no filter). */
type Scope = string | null;
const opWhere = (scope: Scope) => (scope ? { operatorId: scope } : {});

/**
 * Financial Control Center backing service — everything the Super Admin's
 * financial dashboard/reports/reconciliation views need. Deliberately
 * separate from AdminService (deposits/withdrawals/cartelas admin actions
 * already live there) so this file stays focused on aggregation and
 * read-side reporting; the actual money-moving mutations still live in
 * DepositsService/WithdrawalsService/WalletService, which this only reads.
 */
@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
  ) {}

  private async sumLedger(entryType: LedgerEntryType, scope: Scope, since?: Date, until?: Date) {
    const r = await this.prisma.walletLedgerEntry.aggregate({
      where: { entryType, ...opWhere(scope), ...(since || until ? { createdAt: { ...(since ? { gte: since } : {}), ...(until ? { lt: until } : {}) } } : {}) },
      _sum: { amount: true },
      _count: true,
    });
    return { total: Number(r._sum.amount ?? 0), count: r._count };
  }

  private async periodSnapshot(scope: Scope, since?: Date, until?: Date) {
    const [deposits, withdrawalsPaid, houseRevenue, winnings, refunds, bonus] = await Promise.all(
      SNAPSHOT_TYPES.map(([type]) => this.sumLedger(type, scope, since, until)),
    );
    return {
      deposits_total: deposits.total,
      deposits_count: deposits.count,
      withdrawals_paid_total: withdrawalsPaid.total,
      withdrawals_paid_count: withdrawalsPaid.count,
      house_revenue: houseRevenue.total,
      winner_payouts: winnings.total,
      refunds: refunds.total,
      bonus_activity: bonus.total,
    };
  }

  /**
   * Per-operator totals for the Super Admin, in one grouped query over the
   * ledger (operator revenue, deposits, withdrawals, bonus cost, ...).
   */
  async operatorBreakdown(since?: Date, until?: Date) {
    const [groups, operators] = await Promise.all([
      this.prisma.walletLedgerEntry.groupBy({
        by: ['operatorId', 'entryType'],
        where: { entryType: { in: SNAPSHOT_TYPES.map(([t]) => t) }, ...(since || until ? { createdAt: { ...(since ? { gte: since } : {}), ...(until ? { lt: until } : {}) } } : {}) },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.operator.findMany({ select: { id: true, slug: true, name: true, status: true }, orderBy: { createdAt: 'asc' } }),
    ]);
    return operators.map((op) => {
      const row: Record<string, unknown> = { operator_id: op.id, slug: op.slug, name: op.name, status: op.status };
      for (const [type, field] of SNAPSHOT_TYPES) {
        const g = groups.find((x) => x.operatorId === op.id && x.entryType === type);
        row[`${field}_total`] = Number(g?._sum.amount ?? 0);
        row[`${field}_count`] = g?._count ?? 0;
      }
      return row;
    });
  }

  /** Today / This Week / This Month / All-Time — spec §4. */
  async dashboard(scope: Scope) {
    const now = new Date();
    const op = opWhere(scope);
    const [today, week, month, allTime, pendingDeposits, pendingWithdrawals, unpaidWithdrawals] = await Promise.all([
      this.periodSnapshot(scope, startOfDay(now)),
      this.periodSnapshot(scope, startOfWeek(now)),
      this.periodSnapshot(scope, startOfMonth(now)),
      this.periodSnapshot(scope, undefined),
      this.prisma.manualDeposit.count({ where: { ...op, status: 'pending' } }),
      this.prisma.withdrawalRequest.count({ where: { ...op, status: 'pending' } }),
      this.prisma.withdrawalRequest.count({ where: { ...op, status: 'approved' } }), // approved but not yet marked paid
    ]);

    const outstandingWithdrawals = await this.prisma.withdrawalRequest.aggregate({
      where: { ...op, status: { in: ['pending', 'approved'] } },
      _sum: { amount: true },
    });

    const walletLiability = await this.prisma.telegramUser.aggregate({
      where: op,
      _sum: { depositedBalance: true, wonBalance: true, bonusBalance: true },
    });

    return {
      today: { ...today, pending_deposits: pendingDeposits, pending_withdrawals: pendingWithdrawals, unpaid_withdrawals: unpaidWithdrawals },
      this_week: week,
      this_month: month,
      all_time: {
        ...allTime,
        current_wallet_liability:
          Number(walletLiability._sum.depositedBalance ?? 0) + Number(walletLiability._sum.wonBalance ?? 0) + Number(walletLiability._sum.bonusBalance ?? 0),
        outstanding_withdrawals: Number(outstandingWithdrawals._sum.amount ?? 0),
      },
    };
  }

  /** Full financial picture for one player, looked up by their real Telegram id. */
  async walletDetail(operatorId: string, telegramNumericId: number) {
    const user = await this.wallet.findByTelegramNumericId(operatorId, telegramNumericId);
    const [wallet, ledger, deposits, withdrawals] = await Promise.all([
      this.wallet.getWallet(user.id),
      this.wallet.getLedger(user.id, 500),
      this.prisma.manualDeposit.findMany({ where: { telegramUserId: user.id }, orderBy: { submittedAt: 'desc' } }),
      this.prisma.withdrawalRequest.findMany({ where: { telegramUserId: user.id }, orderBy: { requestedAt: 'desc' } }),
    ]);

    return {
      player: { telegram_user_id: telegramNumericId, username: user.username, first_name: user.firstName },
      wallet,
      ledger: ledger.map((l) => ({ ...l, amount: Number(l.amount) })),
      deposits: deposits.map((d) => ({ ...d, amount: Number(d.amount) })),
      withdrawals: withdrawals.map((w) => ({ ...w, amount: Number(w.amount) })),
    };
  }

  async adjustWallet(params: { operatorId: string; telegramNumericId: number; bucket: 'deposited' | 'won' | 'bonus'; amount: number; direction: 'credit' | 'debit'; reason: string; actingAdminId: string }) {
    const user = await this.wallet.findByTelegramNumericId(params.operatorId, params.telegramNumericId);
    return this.wallet.adjustBalance({
      telegramUserId: user.id,
      bucket: params.bucket,
      amount: params.amount,
      direction: params.direction,
      reason: params.reason,
      actingAdminId: params.actingAdminId,
    });
  }

  /** Per-game payout breakdown — spec §10 "game settlements". */
  async gameSettlements(scope: Scope, limit = 100) {
    const games = await this.prisma.game.findMany({
      where: { ...opWhere(scope), status: 'finished' },
      orderBy: { finishedAt: 'desc' },
      take: limit,
      include: { operator: { select: { slug: true } } },
    });

    return Promise.all(
      games.map(async (g) => {
        const winners = g.winnerIds.length
          ? await this.prisma.gameCartela.findMany({
              where: { id: { in: g.winnerIds } },
              include: {
                user: { select: { telegramUserId: true, username: true, firstName: true } },
                room: { select: { code: true } },
              },
            })
          : [];
        return {
          game_id: g.id,
          operator_slug: g.operator.slug,
          game_number: g.gameNumber,
          finished_at: g.finishedAt,
          gross_entry_revenue: Number(g.totalPot),
          house_percentage_amount: g.houseShareAmount ? Number(g.houseShareAmount) : 0,
          player_payout_pool: g.winnerPrizeAmount ? Number(g.winnerPrizeAmount) : 0,
          winner_count: winners.length,
          winners: winners.map((w) => ({
            cartela_id: w.id,
            telegram_user_id: Number(w.user.telegramUserId),
            username: w.user.username,
            room: w.room.code,
            cartela_number: w.cartelaNumber,
            payout: g.winnerPayouts ? Number((g.winnerPayouts as Record<string, number>)[w.id] ?? 0) : 0,
          })),
        };
      }),
    );
  }

  /**
   * Detection-only reconciliation (spec §11). Compares each player's cached
   * balance columns against what their own ledger history sums to — these
   * should always match exactly, since every balance mutation in this
   * codebase goes through WalletService.writeEntry() in the same transaction
   * as the column update. A mismatch here would mean a bug slipped past that
   * discipline (or direct DB tampering), not a normal operating condition.
   * Resolution is intentionally NOT automated — a human with
   * RESOLVE_RECONCILIATION must investigate and act via a normal adjustment.
   */
  async reconciliation(scope: Scope) {
    // DB audit finding (High): a single aggregate groupBy across all users
    // (grouped by telegramUserId + direction) replaces what was an N+1 loop.
    const [users, ledgerSums] = await Promise.all([
      this.prisma.telegramUser.findMany({
        where: opWhere(scope),
        select: {
          id: true,
          telegramUserId: true,
          username: true,
          depositedBalance: true,
          wonBalance: true,
          bonusBalance: true,
          operator: { select: { slug: true } },
        },
      }),
      this.prisma.walletLedgerEntry.groupBy({
        by: ['telegramUserId', 'direction'],
        where: { ...opWhere(scope), telegramUserId: { not: null } },
        _sum: { amount: true },
      }),
    ]);

    const sumsByUser = new Map<string, { credit: number; debit: number }>();
    for (const row of ledgerSums) {
      if (!row.telegramUserId) continue;
      const entry = sumsByUser.get(row.telegramUserId) ?? { credit: 0, debit: 0 };
      if (row.direction === 'credit') entry.credit = Number(row._sum.amount ?? 0);
      else entry.debit = Number(row._sum.amount ?? 0);
      sumsByUser.set(row.telegramUserId, entry);
    }

    const discrepancies: Array<Record<string, unknown>> = [];

    for (const u of users) {
      const { credit, debit } = sumsByUser.get(u.id) ?? { credit: 0, debit: 0 };
      const expected = credit - debit;
      const actual = Number(u.depositedBalance) + Number(u.wonBalance) + Number(u.bonusBalance);
      const diff = Math.round((actual - expected) * 100) / 100;

      if (Math.abs(diff) > 0.01) {
        discrepancies.push({
          operator_slug: u.operator.slug,
          telegram_user_id: Number(u.telegramUserId),
          username: u.username,
          expected_total_balance: expected,
          actual_total_balance: actual,
          difference: diff,
          detected_at: new Date(),
        });
      }
    }

    return {
      status: discrepancies.length === 0 ? 'BALANCED' : 'DISCREPANCY',
      checked_players: users.length,
      discrepancies,
    };
  }

  /**
   * Day/week/month/year/all-time report — spec §14, same underlying data as
   * the dashboard buckets. For a platform admin with no operator filter it
   * also carries the per-operator breakdown. `range` overrides the fixed
   * bucket with an explicit [from, to) window (e.g. a custom date range in
   * the admin UI); `period` is still echoed back for display.
   */
  async financialReport(period: ReportPeriod, scope: Scope, range?: { from?: Date; to?: Date }) {
    const now = new Date();
    const since = range?.from ?? (period === 'daily' ? startOfDay(now) : period === 'weekly' ? startOfWeek(now) : period === 'monthly' ? startOfMonth(now) : period === 'yearly' ? startOfYear(now) : undefined);
    const until = range?.to;
    const op = opWhere(scope);
    const submittedWindow = since || until ? { submittedAt: { ...(since ? { gte: since } : {}), ...(until ? { lt: until } : {}) } } : {};
    const [snapshot, pending, unpaid, failed, byOperator] = await Promise.all([
      this.periodSnapshot(scope, since, until),
      this.prisma.manualDeposit.count({ where: { ...op, status: 'pending', ...submittedWindow } }),
      this.prisma.withdrawalRequest.count({ where: { ...op, status: 'approved' } }),
      this.prisma.manualDeposit.count({ where: { ...op, status: 'rejected', ...submittedWindow } }),
      scope ? Promise.resolve(undefined) : this.operatorBreakdown(since, until),
    ]);
    return {
      period,
      range: { from: since?.toISOString() ?? null, to: until?.toISOString() ?? null },
      generated_at: new Date().toISOString(),
      ...snapshot,
      pending_transactions: pending,
      unpaid_withdrawals: unpaid,
      failed_transactions: failed,
      ...(byOperator ? { by_operator: byOperator } : {}),
    };
  }

  async unpaidWithdrawals(scope: Scope, sort: 'oldest' | 'newest' | 'highest_amount' | 'longest_pending' = 'oldest') {
    const rows = await this.prisma.withdrawalRequest.findMany({
      where: { ...opWhere(scope), status: 'approved' },
      include: { user: { select: { telegramUserId: true, username: true } }, operator: { select: { slug: true } } },
    });
    const withAge = rows.map((r) => ({
      id: r.id,
      operator_slug: r.operator.slug,
      telegram_user_id: Number(r.user.telegramUserId),
      username: r.user.username,
      amount: Number(r.amount),
      telebirr_account: r.telebirrAccount,
      requested_at: r.requestedAt,
      age_hours: Math.round((Date.now() - r.requestedAt.getTime()) / 3_600_000),
      reviewed_by: r.reviewedByAdminId,
    }));
    const sorters: Record<string, (a: (typeof withAge)[number], b: (typeof withAge)[number]) => number> = {
      oldest: (a, b) => a.requested_at.getTime() - b.requested_at.getTime(),
      newest: (a, b) => b.requested_at.getTime() - a.requested_at.getTime(),
      highest_amount: (a, b) => b.amount - a.amount,
      longest_pending: (a, b) => b.age_hours - a.age_hours,
    };
    return withAge.sort(sorters[sort]);
  }
}

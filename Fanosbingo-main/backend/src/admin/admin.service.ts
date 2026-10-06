import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PlayerStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  /** `scope` null = every operator (platform admin, no filter) — room figures only make sense for one operator, so they're omitted in that case. */
  async dashboard(scope: string | null) {
    const op = scope ? { operatorId: scope } : {};
    const [activeGames, pendingDeposits, pendingWithdrawals, todayDeposits, todayWithdrawals, totalPlayers] = await Promise.all([
      this.prisma.game.count({ where: { ...op, status: { in: ['waiting', 'playing'] } } }),
      this.prisma.manualDeposit.count({ where: { ...op, status: 'pending' } }),
      this.prisma.withdrawalRequest.count({ where: { ...op, status: { in: ['pending', 'approved'] } } }),
      this.prisma.manualDeposit.aggregate({
        where: { ...op, status: 'approved', reviewedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
        _sum: { amount: true },
      }),
      this.prisma.withdrawalRequest.aggregate({
        where: { ...op, status: 'paid', paidAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
        _sum: { amount: true },
      }),
      this.prisma.telegramUser.count({ where: op }),
    ]);

    const houseRevenue = await this.prisma.walletLedgerEntry.aggregate({
      where: { ...op, entryType: 'HOUSE_REVENUE' },
      _sum: { amount: true },
    });

    return {
      dashboard: {
        active_games: activeGames,
        pending_deposits: pendingDeposits,
        pending_withdrawals: pendingWithdrawals,
        today_deposits_etb: Number(todayDeposits._sum.amount ?? 0),
        today_withdrawals_etb: Number(todayWithdrawals._sum.amount ?? 0),
        total_players: totalPlayers,
        total_house_revenue_etb: Number(houseRevenue._sum.amount ?? 0),
        rooms: scope ? await this.roomAvailability(scope) : [],
      },
    };
  }

  private async roomAvailability(operatorId: string) {
    const [rooms, activeGame] = await Promise.all([
      this.prisma.operatorRoom.findMany({ where: { operatorId }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.game.findFirst({ where: { operatorId, status: { in: ['waiting', 'playing'] } }, select: { id: true } }),
    ]);
    const [sold, inactive] = await Promise.all([
      activeGame
        ? this.prisma.gameCartela.findMany({ where: { gameId: activeGame.id }, select: { roomId: true } })
        : Promise.resolve<{ roomId: string }[]>([]),
      this.prisma.cartelaSlot.findMany({ where: { operatorId, isActive: false }, select: { roomId: true, cartelaNumber: true } }),
    ]);
    return rooms.map((r) => {
      const soldCount = sold.filter((s) => s.roomId === r.id).length;
      const inactiveCount = inactive.filter((s) => s.roomId === r.id && s.cartelaNumber <= r.capacity).length;
      return { code: r.code, name: r.name, price: Number(r.price), capacity: r.capacity, available: r.capacity - soldCount - inactiveCount };
    });
  }

  /**
   * The operator's rooms (price/capacity/available) plus who currently holds
   * each cartela number in the live game, grouped by room code — any number
   * of operator-defined rooms, not just the original etb5/etb10 pair.
   */
  async cartelas(operatorId: string) {
    const [activeGame, rooms, config] = await Promise.all([
      this.prisma.game.findFirst({ where: { operatorId, status: { in: ['waiting', 'playing'] } } }),
      this.prisma.operatorRoom.findMany({ where: { operatorId }, orderBy: { sortOrder: 'asc' } }),
      this.settings.getGameConfig(operatorId),
    ]);
    const holders: Record<string, unknown[]> = Object.fromEntries(rooms.map((r) => [r.code, []]));
    if (activeGame) {
      const rows = await this.prisma.gameCartela.findMany({
        where: { gameId: activeGame.id },
        include: { user: { select: { username: true, firstName: true, telegramUserId: true } } },
      });
      // BigInt doesn't serialize to JSON — converted at the boundary, same as every other admin listing that selects telegramUserId.
      const serialized = rows.map((r) => ({
        id: r.id,
        cartelaNumber: r.cartelaNumber,
        isDisqualified: r.isDisqualified,
        roomId: r.roomId,
        user: { username: r.user.username, firstName: r.user.firstName, telegramUserId: Number(r.user.telegramUserId) },
      }));
      for (const room of rooms) holders[room.code] = serialized.filter((r) => r.roomId === room.id);
    }
    return {
      rooms: rooms.map((r) => ({ code: r.code, name: r.name, price: Number(r.price), capacity: r.capacity })),
      holders,
      total_capacity: rooms.reduce((sum, r) => sum + r.capacity, 0),
      max_per_player: config.maxCartelasPerPlayer,
      // Enforced at purchase time (CardsService) and by DB constraints — this is never expected to be non-empty.
      limit_violations: [] as Array<{ telegram_user_id: number; cartelas: number }>,
    };
  }

  /** For routes addressing a player by internal id: an operator-bound admin may only reach their own operator's players. */
  async assertPlayerInScope(userId: string, scope: string | null): Promise<void> {
    if (!scope) return;
    const player = await this.prisma.telegramUser.findFirst({ where: { id: userId, operatorId: scope }, select: { id: true } });
    if (!player) throw new NotFoundException('Player not found');
  }

  async playerCartelas(telegramUserId: string, scope: string | null) {
    return this.prisma.gameCartela.findMany({
      where: { telegramUserId, ...(scope ? { operatorId: scope } : {}) },
      orderBy: { joinedAt: 'desc' },
      take: 50,
    });
  }

  // -------------------------------------------------------------------
  // Player account management — audit finding ADMIN-1 (Critical): there was
  // previously no way to suspend or ban an abusive/fraudulent player anywhere
  // in the system. Suspension/ban is enforced at the JwtPlayerStrategy level
  // (every authenticated player request re-checks status, not just login),
  // so it takes effect immediately — not after the player's current access
  // token naturally expires.
  // -------------------------------------------------------------------

  async listPlayers(params: { status?: PlayerStatus; search?: string; take?: number; skip?: number; operatorId: string | null }) {
    const where = {
      ...(params.operatorId ? { operatorId: params.operatorId } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.search
        ? {
            OR: [
              { username: { contains: params.search, mode: 'insensitive' as const } },
              { firstName: { contains: params.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.telegramUser.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: params.take ?? 50,
        skip: params.skip ?? 0,
        select: {
          id: true,
          telegramUserId: true,
          username: true,
          firstName: true,
          status: true,
          statusReason: true,
          statusChangedAt: true,
          depositedBalance: true,
          wonBalance: true,
          bonusBalance: true,
          createdAt: true,
          operator: { select: { id: true, slug: true } },
        },
      }),
      this.prisma.telegramUser.count({ where }),
    ]);
    return {
      total,
      players: rows.map((p) => ({
        operator_id: p.operator.id,
        operator_slug: p.operator.slug,
        telegram_user_id: Number(p.telegramUserId),
        username: p.username,
        first_name: p.firstName,
        status: p.status,
        status_reason: p.statusReason,
        status_changed_at: p.statusChangedAt,
        total_balance: Number(p.depositedBalance) + Number(p.wonBalance) + Number(p.bonusBalance),
        created_at: p.createdAt,
      })),
    };
  }

  /** A Telegram id identifies a player only within one operator, so every lookup needs the operator. */
  async getPlayer(operatorId: string, telegramNumericId: number) {
    const user = await this.prisma.telegramUser.findUnique({
      where: { operatorId_telegramUserId: { operatorId, telegramUserId: BigInt(telegramNumericId) } },
    });
    if (!user) throw new BadRequestException('Player not found');
    return {
      telegram_user_id: Number(user.telegramUserId),
      username: user.username,
      first_name: user.firstName,
      status: user.status,
      status_reason: user.statusReason,
      status_changed_at: user.statusChangedAt,
      status_changed_by_admin_id: user.statusChangedByAdminId,
      created_at: user.createdAt,
    };
  }

  /**
   * The one and only way a player's status changes. `suspended` and `banned`
   * both immediately block login/deposits/withdrawals/gameplay (see
   * JwtPlayerStrategy.validate + AuthService.telegramLogin) — the distinction
   * is operational (suspended = under review, banned = confirmed abuse), not
   * technical. Never deletes the player row or their financial history.
   */
  async setPlayerStatus(operatorId: string, telegramNumericId: number, status: PlayerStatus, reason: string, adminId: string) {
    const user = await this.prisma.telegramUser.findUnique({
      where: { operatorId_telegramUserId: { operatorId, telegramUserId: BigInt(telegramNumericId) } },
    });
    if (!user) throw new BadRequestException('Player not found');

    const updated = await this.prisma.telegramUser.update({
      where: { id: user.id },
      data: {
        status,
        statusReason: reason,
        statusChangedAt: new Date(),
        statusChangedByAdminId: adminId,
      },
    });

    await this.audit.log({
      actorType: 'admin',
      adminId,
      operatorId,
      action: 'PLAYER_STATUS_CHANGED',
      entityType: 'telegram_user',
      entityId: user.id,
      previousState: { status: user.status },
      newState: { status: updated.status },
      reason,
    });

    return { telegram_user_id: telegramNumericId, status: updated.status };
  }
}

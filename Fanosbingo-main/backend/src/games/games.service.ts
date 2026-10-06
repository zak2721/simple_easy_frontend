import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { BingoService } from '../bingo/bingo.service';
import { MetricsService } from '../metrics/metrics.service';
import { OperatorsService } from '../operators/operators.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LimitsService } from '../operator-management/limits.service';
import { DEFAULT_WINNING_PATTERNS, parseWinningPatterns, validatePatternList } from '../cards/bingo-card-generator';
import { setTenantOnTx } from '../common/tenant/rls';

const SELECTION_CUTOFF_MS = 5000; // matches previous behaviour: selection closes 5s before start
/** A scheduled game needs at least this much sales time; less means it's cancelled as missed. */
const MIN_SALES_WINDOW_MS = 60_000;
const MIN_GAME_GAP_MINUTES = 10;

function validatePatterns(patterns: string[]): string[] {
  try {
    return validatePatternList(patterns);
  } catch (e) {
    throw new BadRequestException((e as Error).message);
  }
}
const CLAIM_WINDOW_MS = 1000; // simultaneous-claim window (spec §20: handle simultaneous claims safely)

/**
 * One independent game loop per operator. Every query here is scoped by
 * operatorId: an unscoped `findFirst({ status })` would pick up another
 * operator's game. The partial unique index uniq_live_game_per_operator
 * guarantees at most one waiting/playing game per operator at the DB level.
 */
@Injectable()
export class GamesService {
  private readonly logger = new Logger(GamesService.name);
  /** Operators whose tick is currently running — a slow tick is skipped, not stacked, on the next 4s cron fire. */
  private readonly ticking = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly bingo: BingoService,
    private readonly metrics: MetricsService,
    private readonly operators: OperatorsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly limits: LimitsService,
  ) {}

  /**
   * Full lobby snapshot for the player's own operator. In scheduled mode there
   * may be no game on sale yet: then `game` is null and `next_game` says when
   * the next one opens.
   */
  async lobby(userId: string, operatorId: string) {
    const config = await this.settings.getGameConfig(operatorId);
    const game = await this.ensureWaitingGame(operatorId);
    if (!game) {
      const [next, wallet] = await Promise.all([
        this.prisma.game.findFirst({ where: { operatorId, status: 'scheduled' }, orderBy: { startsAt: 'asc' } }),
        this.prisma.telegramUser.findUnique({ where: { id: userId }, select: { depositedBalance: true, wonBalance: true, bonusBalance: true } }),
      ]);
      return {
        server_time_ms: Date.now(),
        config: { name: config.name, currency: config.currency, max_cartelas_per_player: config.maxCartelasPerPlayer, winner_percentage: config.winnerPercentage, house_percentage: config.housePercentage },
        game: null,
        next_game: next ? { id: next.id, starts_at: next.startsAt.toISOString(), sales_open_at: next.salesOpenAt?.toISOString() ?? null, winning_patterns: next.winningPatterns } : null,
        rooms: {},
        room_list: config.rooms.map((r) => ({ id: r.id, code: r.code, name: r.name, price: r.price, capacity: r.capacity, max_per_player: r.maxPerPlayer, taken: [], unavailable: [] })),
        my_cartelas: [],
        my_counts: { total: 0 },
        wallet: wallet ? { deposited_balance: Number(wallet.depositedBalance), won_balance: Number(wallet.wonBalance), bonus_balance: Number(wallet.bonusBalance) } : null,
      };
    }

    const [sold, inactiveSlots, myCartelas, wallet] = await Promise.all([
      this.prisma.gameCartela.findMany({ where: { gameId: game.id }, select: { roomId: true, cartelaNumber: true } }),
      this.prisma.cartelaSlot.findMany({ where: { operatorId, isActive: false }, select: { roomId: true, cartelaNumber: true } }),
      this.prisma.gameCartela.findMany({ where: { gameId: game.id, telegramUserId: userId }, include: { room: { select: { code: true } } } }),
      this.prisma.telegramUser.findUnique({
        where: { id: userId },
        select: { depositedBalance: true, wonBalance: true, bonusBalance: true },
      }),
    ]);

    const counts: Record<string, number> = { total: 0 };
    for (const room of config.rooms) counts[room.code] = 0;
    for (const c of myCartelas) {
      counts[c.room.code] = (counts[c.room.code] ?? 0) + 1;
      counts.total++;
    }

    const roomList = config.rooms.map((room) => ({
      id: room.id,
      code: room.code,
      name: room.name,
      price: room.price,
      capacity: room.capacity,
      max_per_player: room.maxPerPlayer,
      taken: sold.filter((c) => c.roomId === room.id).map((c) => c.cartelaNumber),
      unavailable: inactiveSlots.filter((s) => s.roomId === room.id && s.cartelaNumber <= room.capacity).map((s) => s.cartelaNumber),
    }));

    return {
      server_time_ms: Date.now(),
      config: {
        name: config.name,
        currency: config.currency,
        etb5_price: config.etb5Price,
        etb5_capacity: config.etb5Capacity,
        etb10_price: config.etb10Price,
        etb10_capacity: config.etb10Capacity,
        standard_total_cartelas: config.standardTotalCartelas,
        max_cartelas_per_player: config.maxCartelasPerPlayer,
        winner_percentage: config.winnerPercentage,
        house_percentage: config.housePercentage,
      },
      game: this.serializeGame(game),
      /** Keyed by room code; the default operator's codes are etb5/etb10, so existing clients read this unchanged. */
      rooms: Object.fromEntries(roomList.map((r) => [r.code, { price: r.price, capacity: r.capacity, taken: r.taken, unavailable: r.unavailable }])),
      room_list: roomList,
      my_cartelas: myCartelas.map((c) => ({
        player_id: c.id,
        room: c.room.code,
        number: c.cartelaNumber,
        card: c.cardNumbers,
        is_disqualified: c.isDisqualified,
      })),
      my_counts: counts,
      wallet: wallet
        ? {
            deposited_balance: Number(wallet.depositedBalance),
            won_balance: Number(wallet.wonBalance),
            bonus_balance: Number(wallet.bonusBalance),
          }
        : null,
    };
  }

  private serializeGame(game: { id: string; status: string; gameNumber: number; startsAt: Date; selectionClosedAt: Date | null; calledNumbers: number[]; currentNumber: number | null; totalPot: unknown; winnerPrizeEach: unknown; winnerIds: string[]; winningPatterns?: string[]; cancelledReason?: string | null }) {
    return {
      winning_patterns: game.winningPatterns ?? null,
      cancelled_reason: game.cancelledReason ?? null,
      id: game.id,
      status: game.status,
      game_number: game.gameNumber,
      starts_at: game.startsAt.toISOString(),
      selection_closed_at: game.selectionClosedAt?.toISOString() ?? null,
      called_numbers: game.calledNumbers,
      current_number: game.currentNumber,
      total_pot: Number(game.totalPot),
      winner_prize: game.winnerPrizeEach ? Number(game.winnerPrizeEach) : 0,
      winner_ids: game.winnerIds.length ? game.winnerIds : null,
    };
  }

  /**
   * Continuous mode: lazily creates the operator's next `waiting` game if it
   * has no live one (spec §13: single active game per operator). Scheduled
   * mode: never invents a game — returns the live one, or null.
   */
  async ensureWaitingGame(operatorId: string) {
    const active = await this.getActiveGame(operatorId);
    if (active) return active;
    const operator = await this.operators.get(operatorId);
    if (operator.gameMode === 'scheduled') return null;

    const startsAt = new Date(Date.now() + 30_000); // 30s from now, mirrors previous "smart countdown" default

    // Enforce MAX_GAMES_PER_DAY plan limit before creating a new continuous-mode game.
    const opLimits = await this.limits.get(operatorId);
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const todayGamesCount = await this.prisma.game.count({
      where: { operatorId, createdAt: { gte: todayStart, lte: todayEnd } },
    });
    if (todayGamesCount >= opLimits.MAX_GAMES_PER_DAY) {
      throw new BadRequestException('Daily game limit reached for your plan');
    }

    try {
      return await this.prisma.game.create({
        data: {
          operatorId,
          status: 'waiting',
          startsAt,
          selectionClosedAt: new Date(startsAt.getTime() - SELECTION_CUTOFF_MS),
          winningPatterns: await this.defaultPatterns(operatorId),
        },
      });
    } catch (e) {
      // Two concurrent lobby loads both saw "no live game"; uniq_live_game_per_operator let exactly one create win.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.getActiveGame(operatorId);
        if (winner) return winner;
      }
      throw e;
    }
  }

  async getActiveGame(operatorId: string) {
    return this.prisma.game.findFirst({ where: { operatorId, status: { in: ['waiting', 'playing'] } } });
  }

  /**
   * Fetches ONE specific game by id, regardless of its current status —
   * replaces the frontend's previous direct `supabase.from('games')...`
   * read. Deliberately NOT the same as getActiveGame()/lobby(): once a game
   * finishes, a new `waiting` game may already exist, and GameRoom.tsx must
   * keep showing the game the player just finished (winner screen, etc.),
   * not whatever is newly active.
   */
  async getGameForPlayer(gameId: string, userId: string, operatorId: string) {
    const game = await this.prisma.game.findFirst({ where: { id: gameId, operatorId } });
    if (!game) return { game: null, my_cartelas: [] };

    const mine = await this.prisma.gameCartela.findMany({ where: { gameId, telegramUserId: userId }, include: { room: { select: { code: true, name: true } } } });

    return {
      game: this.serializeGame(game),
      my_cartelas: mine.map((c) => ({
        id: c.id,
        game_id: c.gameId,
        name: '',
        card_numbers: c.cardNumbers,
        marked_cells: c.markedCells,
        selected_number: c.cartelaNumber,
        room_type: c.room.code,
        room_name: c.room.name,
        entry_price: Number(c.entryPrice),
        telegram_user_id: 0, // not needed client-side; JWT already identifies the caller
        is_disqualified: c.isDisqualified,
        stake_paid: true,
        joined_at: c.joinedAt.toISOString(),
        winning_pattern: c.winningPattern,
      })),
    };
  }

  /**
   * Number-calling cron (spec §14/§35 draw system), every 4 seconds. Each
   * active operator's loop runs independently: one operator's failure or slow
   * tick never stops the others.
   *
   * Cross-instance safety (Phase 7 hardening): the in-process `ticking` Set
   * only stops THIS instance's own tick from overlapping itself — it does
   * nothing to stop a second backend replica from also entering
   * tickOperator() for the same operator at the same moment, which would
   * double the call rate (or worse, race two finalizations of the same
   * game). `withOperatorLock` closes that gap with a Postgres session
   * advisory lock (`pg_try_advisory_xact_lock`), scoped to one Prisma
   * interactive transaction so it's held on a single pinned connection for
   * the tick's whole duration and released automatically when that
   * transaction ends — no separate unlock call, and nothing to leak if the
   * tick throws. A replica that loses the race just skips this operator for
   * this tick, exactly like the existing in-process guard already does for
   * this instance's own overlapping ticks.
   */
  @Cron('*/4 * * * * *')
  async callNumbersTick(): Promise<void> {
    let operators;
    try {
      operators = await this.operators.listActive();
    } catch (e) {
      this.metrics.gameCronFailuresTotal.inc();
      this.logger.error('callNumbersTick: could not list operators', e instanceof Error ? e.stack : String(e));
      return;
    }

    let allOk = true;
    await Promise.all(
      operators.map(async (op) => {
        if (this.ticking.has(op.id)) return;
        this.ticking.add(op.id);
        try {
          await this.withOperatorLock(op.id, () => this.tickOperator(op.id));
        } catch (e) {
          allOk = false;
          this.metrics.gameCronFailuresTotal.inc();
          this.logger.error(`callNumbersTick failed for operator ${op.slug}`, e instanceof Error ? e.stack : String(e));
        } finally {
          this.ticking.delete(op.id);
        }
      }),
    );
    // Audit finding LOG-4 (High): a Prometheus alert on this gauge not
    // advancing for >30s (should tick every 4s) catches a silently dying cron.
    if (allOk) this.metrics.gameCronLastSuccessTimestamp.set(Date.now() / 1000);
  }

  /**
   * Runs `fn` only if this process wins the advisory lock for `operatorId`;
   * a competing replica that loses simply returns without running `fn` at
   * all. `hashtext` folds the operator's UUID into the 32-bit key
   * `pg_try_advisory_xact_lock` takes — a theoretical hash collision would
   * make two different operators briefly share a lock (one operator's tick
   * would wait out another's), never a correctness problem, and is
   * astronomically unlikely at any realistic operator count.
   *
   * Deliberately does NOT call setTenantOnTx: this transaction's only
   * content is the advisory lock check on `tx`, a session-level primitive
   * with no tenant table underneath it. `fn()` runs its own real work
   * (tickPromoteScheduled/cancelAndRefund/etc.) via `this.prisma` on a
   * separate connection, each of which sets its own tenant context where it
   * actually touches a table — setting it here would scope nothing.
   */
  private async withOperatorLock(operatorId: string, fn: () => Promise<void>): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<[{ locked: boolean }]>`SELECT pg_try_advisory_xact_lock(hashtext(${operatorId})) AS locked`;
        if (!locked) return;
        await fn();
      },
      { timeout: 10_000 },
    );
  }

  private async tickOperator(operatorId: string) {
    await this.tickPromoteScheduled(operatorId);
    await this.tickWaitingToPlaying(operatorId);
    await this.tickCallNumber(operatorId);
    await this.tickFinishExpiredClaim(operatorId);
    await this.tickFinishExhaustedGame(operatorId);
  }

  private async tickWaitingToPlaying(operatorId: string) {
    const game = await this.prisma.game.findFirst({ where: { operatorId, status: 'waiting' } });
    if (!game) return;
    if (game.startsAt.getTime() > Date.now()) return;

    const distinctPlayers = await this.prisma.gameCartela.findMany({
      where: { gameId: game.id },
      distinct: ['telegramUserId'],
      select: { telegramUserId: true },
    });

    if (distinctPlayers.length < 2) {
      // spec §16: single-player game cannot proceed — cancel + refund.
      // cancelAndRefund re-verifies both the lock and the player count
      // itself (see its own comment) before actually cancelling — this
      // outer check is just a cheap pre-filter so we don't open a
      // transaction on every 4s tick for every waiting game.
      await this.cancelAndRefund(game.id, operatorId, { reason: 'Fewer than 2 players' });
      return;
    }

    // Enforce MAX_ACTIVE_PLAYERS plan limit before starting the game.
    const startLimits = await this.limits.get(operatorId);
    if (distinctPlayers.length > startLimits.MAX_ACTIVE_PLAYERS) {
      throw new BadRequestException('Player limit reached for your plan');
    }

    await this.prisma.game.update({ where: { id: game.id }, data: { status: 'playing', startedAt: new Date() } });

    await this.audit.log({
      actorType: 'system',
      operatorId,
      action: 'GAME_STARTED',
      entityType: 'game',
      entityId: game.id,
      newState: { playerCount: distinctPlayers.length },
    });
  }

  /**
   * Cancels a not-yet-playing game and refunds every cartela in full.
   * Without `force` (engine auto-cancel) it only proceeds if the game still
   * has fewer than 2 players under the lock; with `force` (operator cancel,
   * missed scheduled game) it cancels regardless of player count.
   */
  private async cancelAndRefund(
    gameId: string,
    operatorId: string,
    opts: { reason: string; force?: boolean },
  ): Promise<{ cancelled: boolean; refunded: number }> {
    const cancelled = await this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx, operatorId);
      // DB audit finding (High): this previously read the cartela list
      // OUTSIDE any lock, then cancelled unconditionally. A concurrent
      // CardsService.selectCartela (which FOR-UPDATE-locks this same games
      // row) could purchase a cartela AFTER that snapshot was taken but
      // BEFORE the game flipped to 'finished' — that purchase gets charged,
      // isn't in the already-captured refund list, and the game finishes
      // with no refund and no error surfaced anywhere. Locking the row here,
      // re-checking status AND re-counting distinct players inside the lock,
      // and flipping status to 'finished' as the FIRST write (before any
      // refund work) closes the race: any purchase blocked on this same
      // lock sees status !== 'waiting' — or a since-arrived 2nd player —
      // the instant it acquires the lock, and is correctly rejected/allowed.
      const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM games WHERE id = ${gameId} FOR UPDATE
      `;
      const game = rows[0];
      if (!game || !['waiting', 'scheduled'].includes(game.status)) return false; // already transitioned by a concurrent tick — nothing to do

      if (!opts.force) {
        const distinctPlayers = await tx.gameCartela.findMany({
          where: { gameId },
          distinct: ['telegramUserId'],
          select: { telegramUserId: true },
        });
        if (distinctPlayers.length >= 2) return false; // a 2nd player joined between the outer pre-filter and this lock — let the next tick transition it to 'playing' instead
      }

      await tx.game.update({
        where: { id: gameId },
        data: { status: 'finished', finishedAt: new Date(), returnToLobbyAt: new Date(Date.now() + 3000), cancelledAt: new Date(), cancelledReason: opts.reason },
      });

      return true;
    });
    if (cancelled) this.logger.log(`Game ${gameId} cancelled: ${opts.reason}`);
    return { cancelled, refunded: 0 };
  }

  /**
   * Scheduled mode: opens sales (scheduled -> waiting) on the operator's next
   * game once its salesOpenAt arrives and nothing else is live. A scheduled
   * game whose start has effectively passed while an earlier game was still
   * running is cancelled as missed rather than started with no time to sell.
   */
  private async tickPromoteScheduled(operatorId: string) {
    const next = await this.prisma.game.findFirst({ where: { operatorId, status: 'scheduled' }, orderBy: { startsAt: 'asc' } });
    if (!next || !next.salesOpenAt || next.salesOpenAt.getTime() > Date.now()) return;
    const tooLate = next.startsAt.getTime() < Date.now() + MIN_SALES_WINDOW_MS;
    if (await this.getActiveGame(operatorId)) {
      if (tooLate) await this.cancelAndRefund(next.id, operatorId, { reason: 'Missed: the previous game was still running', force: true });
      return;
    }
    if (tooLate) {
      await this.cancelAndRefund(next.id, operatorId, { reason: 'Missed: too late to open sales', force: true });
      return;
    }
    try {
      await this.prisma.game.updateMany({ where: { id: next.id, status: 'scheduled' }, data: { status: 'waiting' } });
    } catch (e) {
      // Another live game appeared between the check and the update: uniq_live_game_per_operator refused it; retry next tick.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }
  }

  private async defaultPatterns(operatorId: string): Promise<string[]> {
    const raw = await this.settings.get('WINNING_PATTERNS', operatorId);
    return parseWinningPatterns(raw ?? '') ?? [...DEFAULT_WINNING_PATTERNS];
  }

  // -------------------------------------------------------------------
  // Operator game management (scheduled mode)
  // -------------------------------------------------------------------

  async listForAdmin(operatorId: string, limit = 50) {
    const upcoming = await this.prisma.game.findMany({
      where: { operatorId, status: { in: ['scheduled', 'waiting', 'playing'] } },
      orderBy: { startsAt: 'asc' },
    });
    const recent = await this.prisma.game.findMany({
      where: { operatorId, status: 'finished' },
      orderBy: { finishedAt: 'desc' },
      take: Math.min(limit, 200),
    });
    const counts = await this.prisma.gameCartela.groupBy({
      by: ['gameId'],
      where: { gameId: { in: [...upcoming, ...recent].map((g) => g.id) } },
      _count: { _all: true },
    });
    const sold = (id: string) => counts.find((c) => c.gameId === id)?._count._all ?? 0;
    const shape = (g: (typeof upcoming)[number]) => ({
      id: g.id,
      gameNumber: g.gameNumber,
      status: g.status,
      startsAt: g.startsAt,
      salesOpenAt: g.salesOpenAt,
      winningPatterns: g.winningPatterns,
      cartelasSold: sold(g.id),
      totalPot: Number(g.totalPot),
      cancelledReason: g.cancelledReason,
      finishedAt: g.finishedAt,
    });
    return { upcoming: upcoming.map(shape), recent: recent.map(shape) };
  }

  async scheduleGame(actingAdminId: string, operatorId: string, dto: { startsAt: Date; salesOpenMinutes?: number; winningPatterns?: string[] }) {
    const operator = await this.operators.get(operatorId);
    if (operator.gameMode !== 'scheduled') {
      throw new BadRequestException('This operator runs games continuously. Ask the platform to switch it to scheduled mode first.');
    }
    const startsAt = dto.startsAt;
    const salesOpenAt = new Date(startsAt.getTime() - (dto.salesOpenMinutes ?? 10) * 60_000);
    if (startsAt.getTime() < Date.now() + MIN_SALES_WINDOW_MS + 60_000) throw new BadRequestException('Start time must be at least 2 minutes from now');
    if (startsAt.getTime() > Date.now() + 60 * 24 * 60 * 60_000) throw new BadRequestException('Games can be scheduled at most 60 days ahead');
    const patterns = dto.winningPatterns ? validatePatterns(dto.winningPatterns) : await this.defaultPatterns(operatorId);
    await this.assertNoOverlap(operatorId, startsAt);

    // Enforce MAX_GAMES_PER_DAY plan limit before scheduling a new game.
    const schedLimits = await this.limits.get(operatorId);
    const schedTodayStart = new Date(startsAt); schedTodayStart.setHours(0, 0, 0, 0);
    const schedTodayEnd = new Date(startsAt); schedTodayEnd.setHours(23, 59, 59, 999);
    const schedDayCount = await this.prisma.game.count({
      where: { operatorId, createdAt: { gte: schedTodayStart, lte: schedTodayEnd } },
    });
    if (schedDayCount >= schedLimits.MAX_GAMES_PER_DAY) {
      throw new BadRequestException('Daily game limit reached for your plan');
    }

    const game = await this.prisma.game.create({
      data: {
        operatorId,
        status: 'scheduled',
        startsAt,
        salesOpenAt: salesOpenAt.getTime() < Date.now() ? new Date() : salesOpenAt,
        selectionClosedAt: new Date(startsAt.getTime() - SELECTION_CUTOFF_MS),
        winningPatterns: patterns,
        createdByAdminId: actingAdminId,
      },
    });
    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId,
      action: 'GAME_SCHEDULED',
      entityType: 'game',
      entityId: game.id,
      newState: { startsAt, salesOpenAt: game.salesOpenAt, winningPatterns: patterns },
    });
    await this.notifications.notifyPlatform({
      type: 'GAME_CREATED',
      title: `Game #${game.gameNumber} scheduled`,
      body: `Starts ${startsAt.toISOString()}; patterns: ${patterns.join(', ')}`,
      operatorId,
      relatedEntityType: 'game',
      relatedEntityId: game.id,
    });
    return game;
  }

  /** Scheduled games — or a waiting game with no sales yet — can be moved or re-patterned. Patterns lock at the first sale. */
  async updateGame(actingAdminId: string, operatorId: string, gameId: string, dto: { startsAt?: Date; winningPatterns?: string[] }) {
    const game = await this.prisma.game.findFirst({ where: { id: gameId, operatorId } });
    if (!game) throw new NotFoundException('Game not found');
    const sold = await this.prisma.gameCartela.count({ where: { gameId } });
    if (!(game.status === 'scheduled' || (game.status === 'waiting' && sold === 0))) {
      throw new ConflictException('Only a scheduled game, or one with no cartelas sold yet, can be changed');
    }
    const data: Prisma.GameUpdateInput = {};
    if (dto.winningPatterns) data.winningPatterns = validatePatterns(dto.winningPatterns);
    if (dto.startsAt) {
      if (game.status !== 'scheduled') throw new ConflictException('Sales are already open — the start time can no longer move');
      if (dto.startsAt.getTime() < Date.now() + MIN_SALES_WINDOW_MS + 60_000) throw new BadRequestException('Start time must be at least 2 minutes from now');
      await this.assertNoOverlap(operatorId, dto.startsAt, gameId);
      const openLead = game.salesOpenAt ? game.startsAt.getTime() - game.salesOpenAt.getTime() : 10 * 60_000;
      data.startsAt = dto.startsAt;
      data.salesOpenAt = new Date(Math.max(Date.now(), dto.startsAt.getTime() - openLead));
      data.selectionClosedAt = new Date(dto.startsAt.getTime() - SELECTION_CUTOFF_MS);
    }
    // Re-check under the row lock that nothing was sold in the meantime (patterns lock at the first sale).
    const updated = await this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx, operatorId);
      await tx.$queryRaw`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`;
      if (dto.winningPatterns && (await tx.gameCartela.count({ where: { gameId } })) > 0) {
        throw new ConflictException('Cartelas have been sold — the winning patterns are now locked');
      }
      return tx.game.update({ where: { id: gameId }, data });
    });
    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId,
      action: 'GAME_UPDATED',
      entityType: 'game',
      entityId: gameId,
      previousState: { startsAt: game.startsAt, winningPatterns: game.winningPatterns },
      newState: { startsAt: updated.startsAt, winningPatterns: updated.winningPatterns },
    });
    return updated;
  }

  /** Cancels a scheduled or waiting game and refunds every cartela sold. A playing game must be finished (force-finish), not cancelled. */
  async cancelByAdmin(actingAdminId: string, operatorId: string, gameId: string, reason: string) {
    const game = await this.prisma.game.findFirst({ where: { id: gameId, operatorId } });
    if (!game) throw new NotFoundException('Game not found');
    if (!['scheduled', 'waiting'].includes(game.status)) throw new ConflictException(`A ${game.status} game can't be cancelled`);
    const result = await this.cancelAndRefund(gameId, operatorId, { reason: `Cancelled by operator: ${reason}`, force: true });
    if (!result.cancelled) throw new ConflictException('The game started or finished before it could be cancelled');
    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId,
      action: 'GAME_CANCELLED',
      entityType: 'game',
      entityId: gameId,
      newState: { refundedCartelas: result.refunded },
      reason,
    });
    await this.notifications.notifyPlatform({
      type: 'GAME_CANCELLED',
      severity: result.refunded > 0 ? 'warning' : 'info',
      title: `Game #${game.gameNumber} cancelled`,
      body: `${reason} — ${result.refunded} cartela(s) refunded`,
      operatorId,
      relatedEntityType: 'game',
      relatedEntityId: gameId,
    });
    return { id: gameId, cancelled: true, refundedCartelas: result.refunded };
  }

  private async assertNoOverlap(operatorId: string, startsAt: Date, excludeId?: string) {
    const gap = MIN_GAME_GAP_MINUTES * 60_000;
    const clash = await this.prisma.game.findFirst({
      where: {
        operatorId,
        status: { in: ['scheduled', 'waiting', 'playing'] },
        startsAt: { gt: new Date(startsAt.getTime() - gap), lt: new Date(startsAt.getTime() + gap) },
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { gameNumber: true, startsAt: true },
    });
    if (clash) {
      throw new ConflictException(`Too close to game #${clash.gameNumber} at ${clash.startsAt.toISOString()} — keep games at least ${MIN_GAME_GAP_MINUTES} minutes apart`);
    }
  }

  private async tickCallNumber(operatorId: string) {
    const game = await this.prisma.game.findFirst({ where: { operatorId, status: 'playing' } });
    if (!game) return;
    if (game.calledNumbers.length >= 75) return; // hard stop, spec: no duplicate drawn ball, 1-75

    const remaining = Array.from({ length: 75 }, (_, i) => i + 1).filter((n) => !game.calledNumbers.includes(n));
    if (remaining.length === 0) return;
    // Audit finding GAME-1 (High): the draw must use a CSPRNG, same standard
    // as bingo-card-generator.ts — never Math.random() for a money-determining event.
    const next = remaining[crypto.randomInt(0, remaining.length)];

    await this.prisma.game.update({
      where: { id: game.id },
      data: { currentNumber: next, calledNumbers: { push: next } },
    });

    await this.bingo.checkAutoWinAfterDraw(game.id);
  }

  private async tickFinishExpiredClaim(operatorId: string) {
    const game = await this.prisma.game.findFirst({ where: { operatorId, status: 'playing', claimWindowStart: { not: null } } });
    if (!game || !game.claimWindowStart) return;
    if (Date.now() - game.claimWindowStart.getTime() < CLAIM_WINDOW_MS) return;
    const result = await this.bingo.finalizeGame(game.id);
    if (!result?.alreadyFinished) {
      await this.audit.log({
        actorType: 'system',
        operatorId,
        action: 'GAME_COMPLETED',
        entityType: 'game',
        entityId: game.id,
        newState: { reason: 'CLAIM_WINDOW_EXPIRED' },
      });
    }
  }

  /**
   * Self-healing fallback for a production incident: a game that calls all
   * 75 numbers with no WINNING claim ever submitted has no other path to
   * `finished`. `claimWindowStart` is only ever set by BingoService.claimBingo
   * on a genuine win (a false/disqualified claim never sets it), so filtering
   * on `claimWindowStart: null` here is exactly the complement of
   * tickFinishExpiredClaim above — together they cover every way a `playing`
   * game can end: a confirmed win (handled by the claim-expiry tick once its
   * 1s review window passes) or no confirmed win at all (handled here). Without
   * this, the game sits in `playing` forever, and since
   * uniq_live_game_per_operator allows only one live game per operator, EVERY
   * future game for this operator is blocked too — this is what produced the
   * `GAME_NOT_WAITING` purchase failures investigated as a live incident.
   *
   * finalizeGame() is idempotent by construction (it row-locks the game under
   * `FOR UPDATE` and no-ops with `alreadyFinished` if the status is already
   * `finished`), so checking this on every 4-second tick is safe even against
   * a concurrent admin force-finish or another replica's tick for the same
   * operator: withOperatorLock already serializes ticks per operator, and
   * finalizeGame's own row lock covers the remaining cross-path race.
   */
  private async tickFinishExhaustedGame(operatorId: string) {
    const game = await this.prisma.game.findFirst({ where: { operatorId, status: 'playing', claimWindowStart: null } });
    if (!game) return;
    if (game.calledNumbers.length < 75) return;
    if (game.winnerIds.length > 0) return; // defensive only: a real win always sets claimWindowStart, so this should be unreachable

    const result = await this.bingo.finalizeGame(game.id);
    if (result.alreadyFinished) return; // lost a race to another finalizer (e.g. a manual force-finish) — nothing new to report

    const refundedPlayers = await this.prisma.gameCartela.count({ where: { gameId: game.id } });
    const refundAmount = Number(game.totalPot);

    await this.audit.log({
      actorType: 'system',
      operatorId,
      action: 'GAME_AUTO_FINALIZED',
      entityType: 'game',
      entityId: game.id,
      newState: { reason: 'ALL_NUMBERS_CALLED_NO_WINNER', refundAmount, refundedPlayers },
      reason: 'All 75 numbers were called and no bingo claim was ever submitted',
    });

    const title = `Game #${game.gameNumber} auto-finalized — no winner`;
    const body = `All 75 numbers were called with no bingo claim submitted. ${refundedPlayers} player(s) refunded a total of ${refundAmount} ETB.`;
    await this.notifications.notifyOperator(operatorId, {
      type: 'GAME_AUTO_FINALIZED',
      severity: 'warning',
      title,
      body,
      relatedEntityType: 'game',
      relatedEntityId: game.id,
    });
    await this.notifications.notifyPlatform({
      type: 'GAME_AUTO_FINALIZED',
      severity: 'warning',
      title,
      body,
      operatorId,
      relatedEntityType: 'game',
      relatedEntityId: game.id,
    });
  }

  /** `scope` = the admin's operator (null = platform admin, any operator). */
  async forceFinishGame(gameId: string, adminId: string, scope: string | null) {
    if (scope) {
      const game = await this.prisma.game.findFirst({ where: { id: gameId, operatorId: scope }, select: { id: true } });
      if (!game) throw new NotFoundException('Game not found');
    }
    return this.bingo.finalizeGame(gameId, adminId);
  }
}

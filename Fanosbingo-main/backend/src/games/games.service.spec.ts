import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GamesService } from './games.service';

/**
 * Audit finding GAME-1 (High): tickCallNumber previously drew the actual
 * money-determining ball with Math.random() instead of a CSPRNG. The draw
 * tests below assert two properties directly: the drawn number always comes
 * from the *actual* remaining pool (never a repeat, never out of 1-75), and
 * crypto.randomInt — not Math.random — is what's called to pick it.
 */
const OP = 'op-1';

describe('GamesService', () => {
  let prisma: {
    game: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
    gameCartela: { count: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
    telegramUser: { update: ReturnType<typeof vi.fn> };
    walletLedgerEntry: { create: ReturnType<typeof vi.fn> };
  };
  let settings: { getGameConfig: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  let bingo: { checkAutoWinAfterDraw: ReturnType<typeof vi.fn>; finalizeGame: ReturnType<typeof vi.fn> };
  let operators: { listActive: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  let notifications: { notifyPlatform: ReturnType<typeof vi.fn>; notifyOperator: ReturnType<typeof vi.fn> };
  let audit: { log: ReturnType<typeof vi.fn> };
  let metrics: { gameCronLastSuccessTimestamp: { set: ReturnType<typeof vi.fn> }; gameCronFailuresTotal: { inc: ReturnType<typeof vi.fn> } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any;
  let tx: {
    $queryRaw: ReturnType<typeof vi.fn>;
    $executeRaw: ReturnType<typeof vi.fn>;
    gameCartela: { findMany: ReturnType<typeof vi.fn> };
    telegramUser: { update: ReturnType<typeof vi.fn> };
    walletLedgerEntry: { create: ReturnType<typeof vi.fn> };
    game: { update: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    tx = {
      // Shared default across every `tx.$queryRaw` call site in GamesService: the
      // per-operator advisory-lock check (destructures `locked`), the scheduled-game
      // row lock (destructures `id`/`status`), and the plain `FOR UPDATE` lock (return
      // value ignored) — `locked: true` here means "this instance wins the lock" by default.
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'g1', status: 'waiting', locked: true }]),
      $executeRaw: vi.fn(),
      gameCartela: { findMany: vi.fn() },
      telegramUser: { update: vi.fn() },
      walletLedgerEntry: { create: vi.fn() },
      game: { update: vi.fn() },
    };
    prisma = {
      game: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
      gameCartela: { count: vi.fn(), findMany: vi.fn() },
      $transaction: vi.fn(async (cb) => cb(tx)),
      telegramUser: { update: vi.fn() },
      walletLedgerEntry: { create: vi.fn() },
    };
    settings = { getGameConfig: vi.fn(), get: vi.fn().mockResolvedValue(null) };
    bingo = { checkAutoWinAfterDraw: vi.fn(), finalizeGame: vi.fn() };
    metrics = { gameCronLastSuccessTimestamp: { set: vi.fn() }, gameCronFailuresTotal: { inc: vi.fn() } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    operators = { listActive: vi.fn().mockResolvedValue([{ id: OP, slug: 'yena' }]), get: vi.fn().mockResolvedValue({ id: OP, gameMode: 'continuous' }) };
    notifications = { notifyPlatform: vi.fn(), notifyOperator: vi.fn() };
    audit = { log: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const limits = { get: vi.fn().mockResolvedValue({ MAX_GAMES_PER_DAY: 9999, MAX_ACTIVE_PLAYERS: 99999 }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new GamesService(prisma as any, settings as any, bingo as any, metrics as any, operators as any, audit as any, notifications as any, limits as any);
  });

  describe('ensureWaitingGame', () => {
    it('returns the existing waiting/playing game instead of creating a new one', async () => {
      const existing = { id: 'g1', status: 'waiting' };
      prisma.game.findFirst.mockResolvedValue(existing);
      const result = await service.ensureWaitingGame(OP);
      expect(result).toBe(existing);
      expect(prisma.game.create).not.toHaveBeenCalled();
    });

    it('creates a new waiting game with selectionClosedAt exactly 5s before startsAt', async () => {
      prisma.game.findFirst.mockResolvedValue(null);
      prisma.game.create.mockImplementation(async ({ data }) => data);
      const result = await service.ensureWaitingGame(OP);
      const gap = result.startsAt.getTime() - result.selectionClosedAt.getTime();
      expect(gap).toBe(5000);
      expect(result.status).toBe('waiting');
    });
  });

  describe('tickWaitingToPlaying (private)', () => {
    it('does nothing when there is no waiting game', async () => {
      prisma.game.findFirst.mockResolvedValue(null);
      await service.tickWaitingToPlaying(OP);
      expect(prisma.game.update).not.toHaveBeenCalled();
    });

    it('does nothing before the scheduled start time', async () => {
      prisma.game.findFirst.mockResolvedValue({ id: 'g1', startsAt: new Date(Date.now() + 10_000) });
      await service.tickWaitingToPlaying(OP);
      expect(prisma.game.update).not.toHaveBeenCalled();
      expect(prisma.gameCartela.findMany).not.toHaveBeenCalled();
    });

    it('cancels and refunds when fewer than 2 distinct players joined', async () => {
      prisma.game.findFirst.mockResolvedValue({ id: 'g1', startsAt: new Date(Date.now() - 1000) });
      prisma.gameCartela.findMany.mockResolvedValue([{ telegramUserId: 'u1' }]); // outer pre-filter: 1 distinct player
      tx.$queryRaw.mockResolvedValue([{ id: 'g1', status: 'waiting' }]);
      tx.gameCartela.findMany
        .mockResolvedValueOnce([{ telegramUserId: 'u1' }]) // re-check inside the lock: still 1 player
        .mockResolvedValueOnce([{ telegramUserId: 'u1', entryPrice: 10, operatorId: OP }]); // full cartela list to refund

      await service.tickWaitingToPlaying(OP);

      expect(tx.telegramUser.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { depositedBalance: { increment: 10 } } });
      expect(tx.game.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'g1' }, data: expect.objectContaining({ status: 'finished' }) }));
      expect(prisma.game.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'playing' }) }));
    });

    it('transitions to playing when at least 2 distinct players have joined', async () => {
      prisma.game.findFirst.mockResolvedValue({ id: 'g1', startsAt: new Date(Date.now() - 1000) });
      prisma.gameCartela.findMany.mockResolvedValue([{ telegramUserId: 'u1' }, { telegramUserId: 'u2' }]);

      await service.tickWaitingToPlaying(OP);

      expect(prisma.game.update).toHaveBeenCalledWith({ where: { id: 'g1' }, data: { status: 'playing', startedAt: expect.any(Date) } });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('does not cancel if a game already transitioned away from waiting under the lock (race with a concurrent tick)', async () => {
      prisma.game.findFirst.mockResolvedValue({ id: 'g1', startsAt: new Date(Date.now() - 1000) });
      prisma.gameCartela.findMany.mockResolvedValue([{ telegramUserId: 'u1' }]);
      tx.$queryRaw.mockResolvedValue([{ id: 'g1', status: 'playing' }]); // already moved on by the time the lock was acquired

      await service.tickWaitingToPlaying(OP);

      expect(tx.game.update).not.toHaveBeenCalled();
      expect(tx.telegramUser.update).not.toHaveBeenCalled();
    });

    it('does not cancel if a 2nd player joined between the outer pre-filter and acquiring the lock', async () => {
      prisma.game.findFirst.mockResolvedValue({ id: 'g1', startsAt: new Date(Date.now() - 1000) });
      prisma.gameCartela.findMany.mockResolvedValue([{ telegramUserId: 'u1' }]); // outer pre-filter still sees 1
      tx.$queryRaw.mockResolvedValue([{ id: 'g1', status: 'waiting' }]);
      tx.gameCartela.findMany.mockResolvedValueOnce([{ telegramUserId: 'u1' }, { telegramUserId: 'u2' }]); // re-check under the lock sees 2

      await service.tickWaitingToPlaying(OP);

      expect(tx.game.update).not.toHaveBeenCalled();
      expect(tx.telegramUser.update).not.toHaveBeenCalled();
    });
  });

  describe('tickCallNumber (private)', () => {
    it('does nothing when no game is playing', async () => {
      prisma.game.findFirst.mockResolvedValue(null);
      await service.tickCallNumber(OP);
      expect(prisma.game.update).not.toHaveBeenCalled();
    });

    it('does nothing once all 75 numbers have been called', async () => {
      prisma.game.findFirst.mockResolvedValue({ id: 'g1', calledNumbers: Array.from({ length: 75 }, (_, i) => i + 1) });
      await service.tickCallNumber(OP);
      expect(prisma.game.update).not.toHaveBeenCalled();
    });

    it('draws the correct single remaining number without ever calling Math.random (not a CSPRNG)', async () => {
      // crypto.randomInt is non-configurable in this Node build (can't be
      // vi.spyOn'd directly), so the CSPRNG requirement is verified the other
      // way around: Math.random must never be touched, and with only one
      // number left in the pool, whichever RNG picked it must return 42.
      const mathSpy = vi.spyOn(Math, 'random');
      const called = Array.from({ length: 75 }, (_, i) => i + 1).filter((n) => n !== 42); // all 75 except 42 -> exactly one number left in the pool
      prisma.game.findFirst.mockResolvedValue({ id: 'g1', calledNumbers: called });

      await service.tickCallNumber(OP);

      expect(mathSpy).not.toHaveBeenCalled();
      expect(prisma.game.update).toHaveBeenCalledWith({ where: { id: 'g1' }, data: { currentNumber: 42, calledNumbers: { push: 42 } } });
      expect(bingo.checkAutoWinAfterDraw).toHaveBeenCalled();
      mathSpy.mockRestore();
    });

    it('never draws a number already present in calledNumbers, across many ticks', async () => {
      const called = [5, 10, 15, 20, 25];
      prisma.game.findFirst.mockResolvedValue({ id: 'g1', calledNumbers: called });
      for (let i = 0; i < 25; i++) {
        prisma.game.update.mockClear();
        await service.tickCallNumber(OP);
        const drawn = prisma.game.update.mock.calls[0][0].data.currentNumber;
        expect(called).not.toContain(drawn);
        expect(drawn).toBeGreaterThanOrEqual(1);
        expect(drawn).toBeLessThanOrEqual(75);
      }
    });
  });

  describe('tickFinishExpiredClaim (private)', () => {
    it('does nothing when no game has an open claim window', async () => {
      prisma.game.findFirst.mockResolvedValue(null);
      await service.tickFinishExpiredClaim(OP);
      expect(bingo.finalizeGame).not.toHaveBeenCalled();
    });

    it('does nothing while the 1-second claim window is still open', async () => {
      prisma.game.findFirst.mockResolvedValue({ id: 'g1', claimWindowStart: new Date(Date.now() - 500) });
      await service.tickFinishExpiredClaim(OP);
      expect(bingo.finalizeGame).not.toHaveBeenCalled();
    });

    it('finalizes the game once the claim window has expired', async () => {
      prisma.game.findFirst.mockResolvedValue({ id: 'g1', claimWindowStart: new Date(Date.now() - 2000) });
      await service.tickFinishExpiredClaim(OP);
      expect(bingo.finalizeGame).toHaveBeenCalledWith('g1');
    });
  });

  /**
   * Production incident fix: a game that called all 75 numbers with no
   * bingo claim ever submitted had no path back to `finished` —
   * tickFinishExpiredClaim only acts once a claim window has opened, which
   * a game with zero claims never reaches. This left the game (and every
   * future game for that operator, since only one live game is allowed at
   * a time) permanently stuck, failing every purchase with GAME_NOT_WAITING.
   * See PRODUCTION_READINESS_AUDIT.md and the incident writeup for game #787.
   */
  describe('tickFinishExhaustedGame (private) — all numbers called, no claim submitted', () => {
    it('does nothing when there is no playing game with an unset claim window', async () => {
      prisma.game.findFirst.mockResolvedValue(null);
      await service.tickFinishExhaustedGame(OP);
      expect(bingo.finalizeGame).not.toHaveBeenCalled();
    });

    it('does nothing while fewer than 75 numbers have been called', async () => {
      prisma.game.findFirst.mockResolvedValue({
        id: 'g1',
        calledNumbers: Array.from({ length: 74 }, (_, i) => i + 1),
        winnerIds: [],
        gameNumber: 1,
        totalPot: 0,
      });
      await service.tickFinishExhaustedGame(OP);
      expect(bingo.finalizeGame).not.toHaveBeenCalled();
    });

    it('Scenario 3 (claim review active): the WHERE clause excludes any game with an open claim window, so this tick never touches it — tickFinishExpiredClaim owns that case', async () => {
      // claimWindowStart: null is baked into the query itself; a game under
      // review simply never comes back from findFirst here.
      prisma.game.findFirst.mockResolvedValue(null);
      await service.tickFinishExhaustedGame(OP);
      expect(bingo.finalizeGame).not.toHaveBeenCalled();
    });

    it('Scenario 2 (winner already confirmed): defensively refuses to touch a game with a recorded winner, even if claimWindowStart were somehow unset', async () => {
      prisma.game.findFirst.mockResolvedValue({
        id: 'g1',
        calledNumbers: Array.from({ length: 75 }, (_, i) => i + 1),
        winnerIds: ['c1'],
        gameNumber: 1,
        totalPot: 100,
      });
      await service.tickFinishExhaustedGame(OP);
      expect(bingo.finalizeGame).not.toHaveBeenCalled();
    });

    it('Scenario 1: finalizes a game that exhausted all 75 numbers with zero claims, and records an audit entry plus operator + platform notifications', async () => {
      prisma.game.findFirst.mockResolvedValue({
        id: 'g1',
        calledNumbers: Array.from({ length: 75 }, (_, i) => i + 1),
        winnerIds: [],
        gameNumber: 787,
        totalPot: 10,
      });
      bingo.finalizeGame.mockResolvedValue({ winners: 0 });
      prisma.gameCartela.count.mockResolvedValue(2);

      await service.tickFinishExhaustedGame(OP);

      expect(bingo.finalizeGame).toHaveBeenCalledWith('g1');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'system',
          action: 'GAME_AUTO_FINALIZED',
          entityType: 'game',
          entityId: 'g1',
          operatorId: OP,
          newState: expect.objectContaining({ reason: 'ALL_NUMBERS_CALLED_NO_WINNER', refundedPlayers: 2, refundAmount: 10 }),
        }),
      );
      expect(notifications.notifyOperator).toHaveBeenCalledWith(OP, expect.objectContaining({ type: 'GAME_AUTO_FINALIZED', severity: 'warning' }));
      expect(notifications.notifyPlatform).toHaveBeenCalledWith(expect.objectContaining({ type: 'GAME_AUTO_FINALIZED', operatorId: OP }));
    });

    it('Scenario 4 (concurrency): a race already finalized the game elsewhere (admin force-finish, or another replica) — no duplicate audit or notifications', async () => {
      prisma.game.findFirst.mockResolvedValue({
        id: 'g1',
        calledNumbers: Array.from({ length: 75 }, (_, i) => i + 1),
        winnerIds: [],
        gameNumber: 1,
        totalPot: 10,
      });
      bingo.finalizeGame.mockResolvedValue({ alreadyFinished: true });

      await service.tickFinishExhaustedGame(OP);

      expect(bingo.finalizeGame).toHaveBeenCalledWith('g1');
      expect(audit.log).not.toHaveBeenCalled();
      expect(notifications.notifyOperator).not.toHaveBeenCalled();
      expect(notifications.notifyPlatform).not.toHaveBeenCalled();
    });
  });

  describe('callNumbersTick', () => {
    it('advances the success-timestamp metric when every sub-tick succeeds', async () => {
      prisma.game.findFirst.mockResolvedValue(null); // every sub-tick becomes a fast no-op
      await service.callNumbersTick();
      expect(metrics.gameCronLastSuccessTimestamp.set).toHaveBeenCalled();
      expect(metrics.gameCronFailuresTotal.inc).not.toHaveBeenCalled();
    });

    it('audit finding LOG-4: swallows a sub-tick failure so the cron process survives, but records it as a metric instead of losing the signal entirely', async () => {
      prisma.game.findFirst.mockRejectedValue(new Error('db down'));
      await expect(service.callNumbersTick()).resolves.toBeUndefined();
      expect(metrics.gameCronFailuresTotal.inc).toHaveBeenCalled();
      expect(metrics.gameCronLastSuccessTimestamp.set).not.toHaveBeenCalled();
    });
  });

  describe('forceFinishGame', () => {
    it('delegates directly to BingoService.finalizeGame with the acting admin id', async () => {
      bingo.finalizeGame.mockResolvedValue({ winners: 1 });
      const result = await service.forceFinishGame('g1', 'admin1', null);
      expect(bingo.finalizeGame).toHaveBeenCalledWith('g1', 'admin1');
      expect(result).toEqual({ winners: 1 });
    });

    it("refuses an operator-bound admin a game belonging to another operator, without finalizing", async () => {
      prisma.game.findFirst.mockResolvedValue(null); // no game g1 inside this admin's operator
      await expect(service.forceFinishGame('g1', 'admin1', 'op-other')).rejects.toThrow('Game not found');
      expect(prisma.game.findFirst).toHaveBeenCalledWith({ where: { id: 'g1', operatorId: 'op-other' }, select: { id: true } });
      expect(bingo.finalizeGame).not.toHaveBeenCalled();
    });
  });

  describe('multi-operator isolation', () => {
    it('scopes every engine lookup by operator, so one operator never picks up another operator\'s game', async () => {
      prisma.game.findFirst.mockResolvedValue(null);
      await service.tickWaitingToPlaying(OP);
      await service.tickCallNumber(OP);
      await service.tickFinishExpiredClaim(OP);
      for (const [args] of prisma.game.findFirst.mock.calls) expect(args.where.operatorId).toBe(OP);
    });

    it('runs one tick per active operator, and one operator failing does not stop the others', async () => {
      operators.listActive.mockResolvedValue([{ id: 'op-a', slug: 'a' }, { id: 'op-b', slug: 'b' }]);
      prisma.game.findFirst.mockImplementation(async ({ where }) => {
        if (where.operatorId === 'op-a') throw new Error('op-a db error');
        return null;
      });

      await expect(service.callNumbersTick()).resolves.toBeUndefined();

      const scopedTo = new Set(prisma.game.findFirst.mock.calls.map(([args]) => args.where.operatorId));
      expect(scopedTo).toEqual(new Set(['op-a', 'op-b']));
      // op-b ran all five sub-ticks (promote-scheduled, waiting->playing, call number, finish expired claim, finish exhausted game) despite op-a failing on its first.
      expect(prisma.game.findFirst.mock.calls.filter(([args]) => args.where.operatorId === 'op-b')).toHaveLength(5);
      expect(metrics.gameCronFailuresTotal.inc).toHaveBeenCalledTimes(1);
      expect(metrics.gameCronLastSuccessTimestamp.set).not.toHaveBeenCalled();
    });

    it('stamps the new game with its operator, and recovers from a concurrent-create race (uniq_live_game_per_operator) by returning the winner', async () => {
      const { Prisma } = await import('@prisma/client');
      const winner = { id: 'g-winner', status: 'waiting', operatorId: OP };
      prisma.game.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
      prisma.game.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }));

      const result = await service.ensureWaitingGame(OP);

      expect(prisma.game.create).toHaveBeenCalledWith({ data: expect.objectContaining({ operatorId: OP, status: 'waiting' }) });
      expect(result).toBe(winner);
    });
  });

  describe('cross-instance advisory lock (withOperatorLock)', () => {
    it('runs the tick when it wins the advisory lock', async () => {
      tx.$queryRaw.mockResolvedValueOnce([{ locked: true }]);
      prisma.game.findFirst.mockResolvedValue(null);
      await service.withOperatorLock(OP, () => service.tickWaitingToPlaying(OP));
      expect(prisma.game.findFirst).toHaveBeenCalled();
    });

    it('a lost lock (a competing replica already ticking this operator) skips the work entirely', async () => {
      tx.$queryRaw.mockResolvedValueOnce([{ locked: false }]);
      const fn = vi.fn();
      await service.withOperatorLock(OP, fn);
      expect(fn).not.toHaveBeenCalled();
    });

    it('is keyed per operator: winning the lock for one operator says nothing about another', async () => {
      tx.$queryRaw.mockResolvedValueOnce([{ locked: true }]).mockResolvedValueOnce([{ locked: false }]);
      const fnA = vi.fn();
      const fnB = vi.fn();
      await service.withOperatorLock('op-a', fnA);
      await service.withOperatorLock('op-b', fnB);
      expect(fnA).toHaveBeenCalledTimes(1);
      expect(fnB).not.toHaveBeenCalled();
    });

    it('callNumbersTick still processes every operator whose lock it wins, even when another operator loses theirs', async () => {
      operators.listActive.mockResolvedValue([{ id: 'op-a', slug: 'a' }, { id: 'op-b', slug: 'b' }]);
      tx.$queryRaw
        .mockResolvedValueOnce([{ locked: false }]) // op-a: another replica already has it
        .mockResolvedValue([{ locked: true, id: 'g1', status: 'waiting' }]); // op-b and everything inside its tick
      prisma.game.findFirst.mockResolvedValue(null);

      await service.callNumbersTick();

      const scopedTo = new Set(prisma.game.findFirst.mock.calls.map(([args]) => args.where.operatorId));
      expect(scopedTo).toEqual(new Set(['op-b'])); // op-a never ran any sub-tick — it lost the lock before tickOperator started
    });
  });

  describe('scheduled mode + winning patterns', () => {
    it('continuous mode: a new game takes the operator WINNING_PATTERNS setting', async () => {
      prisma.game.findFirst.mockResolvedValue(null);
      settings.get.mockResolvedValue('full_house');
      prisma.game.create.mockImplementation(async ({ data }) => data);
      const g = await service.ensureWaitingGame(OP);
      expect(g.winningPatterns).toEqual(['full_house']);
    });

    it('continuous mode: an invalid WINNING_PATTERNS setting falls back to the default set, never to "no pattern"', async () => {
      prisma.game.findFirst.mockResolvedValue(null);
      settings.get.mockResolvedValue('zigzag');
      prisma.game.create.mockImplementation(async ({ data }) => data);
      const g = await service.ensureWaitingGame(OP);
      expect(g.winningPatterns).toEqual(['row', 'column', 'diagonal', 'corners']);
    });

    it('scheduled mode: never invents a game', async () => {
      operators.get.mockResolvedValue({ id: OP, gameMode: 'scheduled' });
      prisma.game.findFirst.mockResolvedValue(null);
      expect(await service.ensureWaitingGame(OP)).toBeNull();
      expect(prisma.game.create).not.toHaveBeenCalled();
    });

    it('opens sales on a scheduled game once its salesOpenAt arrives and nothing else is live', async () => {
      prisma.game.findFirst
        .mockResolvedValueOnce({ id: 'g-next', status: 'scheduled', salesOpenAt: new Date(Date.now() - 1000), startsAt: new Date(Date.now() + 10 * 60_000) })
        .mockResolvedValueOnce(null); // no live game
      await service.tickPromoteScheduled(OP);
      expect(prisma.game.updateMany).toHaveBeenCalledWith({ where: { id: 'g-next', status: 'scheduled' }, data: { status: 'waiting' } });
    });

    it('does not open sales early', async () => {
      prisma.game.findFirst.mockResolvedValueOnce({ id: 'g-next', status: 'scheduled', salesOpenAt: new Date(Date.now() + 60_000), startsAt: new Date(Date.now() + 10 * 60_000) });
      await service.tickPromoteScheduled(OP);
      expect(prisma.game.updateMany).not.toHaveBeenCalled();
    });

    it('a scheduled game whose start passed while the previous game ran is cancelled (with refunds) as missed', async () => {
      prisma.game.findFirst
        .mockResolvedValueOnce({ id: 'g-late', status: 'scheduled', salesOpenAt: new Date(Date.now() - 20 * 60_000), startsAt: new Date(Date.now() - 1000) })
        .mockResolvedValueOnce({ id: 'g-live', status: 'playing' });
      tx.$queryRaw.mockResolvedValue([{ id: 'g-late', status: 'scheduled' }]);
      tx.gameCartela.findMany.mockResolvedValue([]);
      await service.tickPromoteScheduled(OP);
      expect(tx.game.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'finished', cancelledReason: expect.stringContaining('Missed') }) }));
      expect(prisma.game.updateMany).not.toHaveBeenCalled();
    });

    it('operator cancel refunds every cartela even with 2+ players (force), and records the reason', async () => {
      prisma.game.findFirst.mockResolvedValue({ id: 'g1', operatorId: OP, status: 'waiting', gameNumber: 7 });
      tx.$queryRaw.mockResolvedValue([{ id: 'g1', status: 'waiting' }]);
      tx.gameCartela.findMany.mockResolvedValue([
        { telegramUserId: 'u1', entryPrice: 20, operatorId: OP },
        { telegramUserId: 'u2', entryPrice: 20, operatorId: OP },
      ]);
      const r = await service.cancelByAdmin('owner', OP, 'g1', 'venue closed');
      expect(r).toEqual({ id: 'g1', cancelled: true, refundedCartelas: 2 });
      expect(tx.telegramUser.update).toHaveBeenCalledTimes(2);
      expect(tx.game.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ cancelledReason: 'Cancelled by operator: venue closed' }) }));
      expect(notifications.notifyPlatform).toHaveBeenCalledWith(expect.objectContaining({ type: 'GAME_CANCELLED' }));
    });

    it("a playing game can't be cancelled", async () => {
      prisma.game.findFirst.mockResolvedValue({ id: 'g1', operatorId: OP, status: 'playing' });
      await expect(service.cancelByAdmin('owner', OP, 'g1', 'x')).rejects.toThrow("can't be cancelled");
    });

    it('scheduling is refused in continuous mode, and unknown patterns are rejected', async () => {
      await expect(service.scheduleGame('owner', OP, { startsAt: new Date(Date.now() + 3_600_000) })).rejects.toThrow('continuously');
      operators.get.mockResolvedValue({ id: OP, gameMode: 'scheduled' });
      await expect(service.scheduleGame('owner', OP, { startsAt: new Date(Date.now() + 3_600_000), winningPatterns: ['zigzag'] })).rejects.toThrow('Unknown winning pattern');
    });
  });
});

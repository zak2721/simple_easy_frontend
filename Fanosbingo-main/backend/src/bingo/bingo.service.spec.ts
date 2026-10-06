import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { BingoService } from './bingo.service';

// Column-major [col][row]; row 0 = card[c][0] for c in 0..4.
const WINNING_ROW_CARD = [
  [1, 2, 3, 4, 5],
  [16, 17, 18, 19, 20],
  [31, 32, 0, 34, 35],
  [46, 47, 48, 49, 50],
  [61, 62, 63, 64, 65],
];
const NO_MARKS = Array.from({ length: 5 }, () => [false, false, false, false, false]);

/**
 * Audit finding GAME-2 (Critical): the whole point of the rounding fix is
 * that `houseShareAmount + winnerPrizeAmount === totalPot` must hold EXACTLY,
 * for every winner count — that invariant is asserted directly below rather
 * than just checking the individual numbers, since that's the actual
 * business guarantee ("the house never silently pockets or loses a
 * fractional birr with no ledger trace").
 */
const OP = 'op-1';

describe('BingoService', () => {
  let prisma: { $transaction: ReturnType<typeof vi.fn>; game: { findUnique: ReturnType<typeof vi.fn> } };
  let telegram: { sendMessage: ReturnType<typeof vi.fn> };
  let settings: { get: ReturnType<typeof vi.fn> };
  let service: BingoService;
  let tx: {
    gameCartela: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    $queryRaw: ReturnType<typeof vi.fn>;
    $executeRaw: ReturnType<typeof vi.fn>;
    game: { update: ReturnType<typeof vi.fn> };
    telegramUser: { update: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
    walletLedgerEntry: { create: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    tx = {
      gameCartela: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      game: { update: vi.fn() },
      telegramUser: { update: vi.fn(), findUnique: vi.fn().mockResolvedValue({ telegramUserId: 1n }) },
      walletLedgerEntry: { create: vi.fn() },
    };
    prisma = { $transaction: vi.fn(async (cb) => cb(tx)), game: { findUnique: vi.fn().mockResolvedValue({ operatorId: OP }) } };
    telegram = { sendMessage: vi.fn() };
    settings = { get: vi.fn(async (key: string) => (key === 'WINNER_PERCENTAGE' ? '80' : null)) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new BingoService(prisma as any, telegram as any, settings as any);
  });

  describe('claimBingo', () => {
    it('rejects a cartela that does not belong to the claiming user', async () => {
      tx.gameCartela.findUnique.mockResolvedValue({ id: 'c1', telegramUserId: 'other-user', gameId: 'g1' });
      await expect(service.claimBingo('c1', 'u1')).rejects.toThrow(BadRequestException);
    });

    it('rejects a claim when the game is not currently playing', async () => {
      tx.gameCartela.findUnique.mockResolvedValue({ id: 'c1', telegramUserId: 'u1', gameId: 'g1' });
      tx.$queryRaw.mockResolvedValue([{ id: 'g1', status: 'finished', called_numbers: [], winner_ids: [] }]);
      await expect(service.claimBingo('c1', 'u1')).rejects.toThrow(BadRequestException);
    });

    it('returns alreadyClaimed for a cartela already in winner_ids, without re-processing', async () => {
      tx.gameCartela.findUnique.mockResolvedValue({ id: 'c1', telegramUserId: 'u1', gameId: 'g1' });
      tx.$queryRaw.mockResolvedValue([{ id: 'g1', status: 'playing', called_numbers: [], winner_ids: ['c1'] }]);
      const result = await service.claimBingo('c1', 'u1');
      expect(result).toEqual({ alreadyClaimed: true });
      expect(tx.gameCartela.update).not.toHaveBeenCalled();
    });

    it('rejects a claim from an already-disqualified cartela', async () => {
      tx.gameCartela.findUnique.mockResolvedValue({ id: 'c1', telegramUserId: 'u1', gameId: 'g1', isDisqualified: true });
      tx.$queryRaw.mockResolvedValue([{ id: 'g1', status: 'playing', called_numbers: [], winner_ids: [] }]);
      await expect(service.claimBingo('c1', 'u1')).rejects.toThrow(ForbiddenException);
    });

    it('rejects a claim submitted after the 1-second claim window has closed', async () => {
      tx.gameCartela.findUnique.mockResolvedValue({
        id: 'c1',
        telegramUserId: 'u1',
        gameId: 'g1',
        isDisqualified: false,
        cardNumbers: WINNING_ROW_CARD,
        markedCells: NO_MARKS,
      });
      tx.$queryRaw.mockResolvedValue([
        { id: 'g1', status: 'playing', called_numbers: [1, 16, 31, 46, 61], winner_ids: [], claim_window_start: new Date(Date.now() - 2000) },
      ]);
      await expect(service.claimBingo('c1', 'u1')).rejects.toThrow('CLAIM_WINDOW_CLOSED');
    });

    it('disqualifies a cartela on a false claim (pattern does not actually exist)', async () => {
      tx.gameCartela.findUnique.mockResolvedValue({
        id: 'c1',
        telegramUserId: 'u1',
        gameId: 'g1',
        isDisqualified: false,
        cardNumbers: WINNING_ROW_CARD,
        markedCells: NO_MARKS,
      });
      tx.$queryRaw.mockResolvedValue([{ id: 'g1', status: 'playing', called_numbers: [], winner_ids: [], claim_window_start: null }]);

      const result = await service.claimBingo('c1', 'u1');

      expect(result).toEqual({ disqualified: true, isWinner: false });
      expect(tx.gameCartela.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { isDisqualified: true } });
      expect(tx.game.update).not.toHaveBeenCalled();
    });

    it('confirms a real win: records the pattern and appends the cartela to winner_ids', async () => {
      tx.gameCartela.findUnique.mockResolvedValue({
        id: 'c1',
        telegramUserId: 'u1',
        gameId: 'g1',
        isDisqualified: false,
        cardNumbers: WINNING_ROW_CARD,
        markedCells: NO_MARKS,
      });
      tx.$queryRaw.mockResolvedValue([
        { id: 'g1', status: 'playing', called_numbers: [1, 16, 31, 46, 61], winner_ids: ['other-cartela'], claim_window_start: null },
      ]);

      const result = await service.claimBingo('c1', 'u1');

      expect(result).toMatchObject({ isWinner: true });
      expect(tx.gameCartela.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { winningPattern: expect.any(Object) } });
      expect(tx.game.update).toHaveBeenCalledWith({
        where: { id: 'g1' },
        data: expect.objectContaining({ winnerIds: ['other-cartela', 'c1'] }),
      });
    });
  });

  describe('finalizeGame', () => {
    it('returns alreadyFinished without touching any balances for a game already finished', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: 'g1', status: 'finished', winner_ids: [], total_pot: 1000, called_numbers: [] }]);
      const result = await service.finalizeGame('g1');
      expect(result).toEqual({ alreadyFinished: true });
      expect(tx.telegramUser.update).not.toHaveBeenCalled();
    });

    it('refunds every participating cartela in full when there is no winner', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: 'g1', status: 'playing', winner_ids: [], total_pot: 300, called_numbers: [] }]);
      tx.gameCartela.findMany.mockResolvedValue([
        { telegramUserId: 'u1', entryPrice: 100 },
        { telegramUserId: 'u2', entryPrice: 100 },
        { telegramUserId: 'u3', entryPrice: 100 },
      ]);

      const result = await service.finalizeGame('g1');

      expect(result).toEqual({ winners: 0 });
      expect(tx.telegramUser.update).toHaveBeenCalledTimes(3);
      expect(tx.telegramUser.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { depositedBalance: { increment: 100 } } });
      expect(tx.walletLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ entryType: 'GAME_REFUND' }) }));
    });

    it('single winner: houseShare + winner payout always sum to exactly totalPot', async () => {
      // totalPot=101, winnerPct=80 -> winnerPool = floor(80.8) = 80, 1 winner -> perWinner=80, houseShare=21
      tx.$queryRaw.mockResolvedValue([{ id: 'g1', status: 'playing', winner_ids: ['c1'], total_pot: 101, called_numbers: [] }]);
      tx.gameCartela.findMany.mockResolvedValue([{ id: 'c1', telegramUserId: 'u1' }]);

      const result = await service.finalizeGame('g1');

      expect(result.perWinner).toBe(80);
      expect(result.houseShare).toBe(21);
      expect(result.perWinner! + result.houseShare!).toBe(101);
    });

    it('multi-winner uneven split: the leftover remainder goes to the house, not to a winner or nowhere', async () => {
      // totalPot=100, winnerPct=80 -> winnerPool=80, 3 winners -> perWinner=floor(80/3)=26, distributed=78, houseShare=22
      tx.$queryRaw.mockResolvedValue([{ id: 'g1', status: 'playing', winner_ids: ['c1', 'c2', 'c3'], total_pot: 100, called_numbers: [] }]);
      tx.gameCartela.findMany.mockResolvedValue([
        { id: 'c1', telegramUserId: 'u1' },
        { id: 'c2', telegramUserId: 'u2' },
        { id: 'c3', telegramUserId: 'u3' },
      ]);

      const result = await service.finalizeGame('g1');

      expect(result.perWinner).toBe(26);
      expect(result.houseShare).toBe(22);
      expect(result.perWinner! * 3 + result.houseShare!).toBe(100);
      expect(tx.game.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ winnerPrizeAmount: 78, houseShareAmount: 22 }) }),
      );
    });

    it('credits each winner cartela exactly perWinner, once each', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: 'g1', status: 'playing', winner_ids: ['c1', 'c2'], total_pot: 200, called_numbers: [] }]);
      tx.gameCartela.findMany.mockResolvedValue([
        { id: 'c1', telegramUserId: 'u1' },
        { id: 'c2', telegramUserId: 'u2' },
      ]);

      await service.finalizeGame('g1');

      expect(tx.telegramUser.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { wonBalance: { increment: 80 } } });
      expect(tx.telegramUser.update).toHaveBeenCalledWith({ where: { id: 'u2' }, data: { wonBalance: { increment: 80 } } });
    });

    it("uses the game's own operator for the winner percentage and stamps it on every ledger row, including house revenue", async () => {
      settings.get.mockImplementation(async (key: string) => (key === 'WINNER_PERCENTAGE' ? '70' : null));
      tx.$queryRaw.mockResolvedValue([{ id: 'g1', status: 'playing', winner_ids: ['c1'], total_pot: 100, called_numbers: [] }]);
      tx.gameCartela.findMany.mockResolvedValue([{ id: 'c1', telegramUserId: 'u1' }]);

      const result = await service.finalizeGame('g1');

      expect(settings.get).toHaveBeenCalledWith('WINNER_PERCENTAGE', OP);
      expect(result.perWinner).toBe(70);
      const ledgerRows = tx.walletLedgerEntry.create.mock.calls.map((c) => c[0].data);
      expect(ledgerRows.map((d) => d.entryType)).toEqual(['WINNING_CREDIT', 'HOUSE_REVENUE']);
      expect(ledgerRows.every((d) => d.operatorId === OP)).toBe(true);
    });

    it("notifies winners through the game's own operator bot, after the payout commits", async () => {
      tx.$queryRaw.mockResolvedValue([{ id: 'g1', status: 'playing', winner_ids: ['c1'], total_pot: 100, called_numbers: [] }]);
      tx.gameCartela.findMany.mockResolvedValue([{ id: 'c1', telegramUserId: 'u1' }]);

      await service.finalizeGame('g1');

      expect(telegram.sendMessage).toHaveBeenCalledWith(OP, 1, expect.stringContaining('80'));
    });

    it('notifies every refunded player when there is no winner (production incident fix: previously silent)', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: 'g1', status: 'playing', winner_ids: [], total_pot: 300, called_numbers: [] }]);
      tx.gameCartela.findMany.mockResolvedValue([
        { telegramUserId: 'u1', entryPrice: 100 },
        { telegramUserId: 'u2', entryPrice: 100 },
        { telegramUserId: 'u3', entryPrice: 100 },
      ]);

      await service.finalizeGame('g1');

      expect(telegram.sendMessage).toHaveBeenCalledTimes(3);
      expect(telegram.sendMessage).toHaveBeenCalledWith(OP, 1, expect.stringContaining('100'));
    });

    it('Scenario 5: a failure mid-refund rolls back the whole transaction — the game is never left partially finalized', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: 'g1', status: 'playing', winner_ids: [], total_pot: 300, called_numbers: [] }]);
      tx.gameCartela.findMany.mockResolvedValue([
        { telegramUserId: 'u1', entryPrice: 100 },
        { telegramUserId: 'u2', entryPrice: 100 },
      ]);
      tx.telegramUser.update.mockRejectedValueOnce(new Error('db connection lost mid-refund'));

      await expect(service.finalizeGame('g1')).rejects.toThrow('db connection lost mid-refund');

      // The status flip to 'finished' happens AFTER the refund loop — a failure
      // partway through the loop means it's never reached, so the whole
      // transaction (Prisma's real $transaction, mocked here as a direct
      // await of the callback) rolls back atomically: no player is refunded
      // twice, and the game is not left in a half-finished state.
      expect(tx.game.update).not.toHaveBeenCalled();
      expect(telegram.sendMessage).not.toHaveBeenCalled();
    });
  });
});

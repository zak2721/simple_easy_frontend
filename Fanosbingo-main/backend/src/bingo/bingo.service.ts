import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { SettingsService } from '../settings/settings.service';
import { checkWin } from '../cards/bingo-card-generator';
import type { BingoCard } from '../cards/bingo-card-generator';
import { setTenantOnTx } from '../common/tenant/rls';

const CLAIM_WINDOW_MS = 1000;

export interface FinalizeResult {
  alreadyFinished?: boolean;
  winners?: number;
  perWinner?: number;
  houseShare?: number;
  adminForced?: boolean;
}

/**
 * Winner detection + payout — server-authoritative (spec §20). The frontend
 * can never submit `winner=true` or a payout amount; every branch here
 * either rejects the claim or computes the prize from the game's actual pot.
 */
@Injectable()
export class BingoService {
  private readonly logger = new Logger(BingoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly settings: SettingsService,
  ) {}

  async claimBingo(cartelaId: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx);
      // Lock the single active game — since only one game is ever `playing`,
      // this serializes ALL simultaneous claims against it, which is what
      // makes the multi-winner window below race-free.
      const cartela = await tx.gameCartela.findUnique({ where: { id: cartelaId } });
      if (!cartela || cartela.telegramUserId !== userId) throw new BadRequestException('Cartela not found');

      const gameRows = await tx.$queryRaw<Array<{ id: string; status: string; called_numbers: number[]; winner_ids: string[]; claim_window_start: Date | null; total_pot: Prisma.Decimal; winning_patterns: string[] | null }>>`
        SELECT id, status, called_numbers, winner_ids, claim_window_start, total_pot, winning_patterns FROM games WHERE id = ${cartela.gameId} FOR UPDATE
      `;
      const game = gameRows[0];
      if (!game || game.status !== 'playing') throw new BadRequestException('Game is not currently playing');

      if (game.winner_ids.includes(cartelaId)) {
        return { alreadyClaimed: true };
      }

      if (cartela.isDisqualified) {
        throw new ForbiddenException({ disqualified: true, message: 'This cartela was disqualified for a false claim' });
      }

      if (game.claim_window_start && Date.now() - game.claim_window_start.getTime() >= CLAIM_WINDOW_MS) {
        throw new BadRequestException('CLAIM_WINDOW_CLOSED');
      }

      const called = new Set<number>(game.called_numbers);
      // Only this game's configured patterns win; a claim on any other pattern is a false claim.
      const allowed = game.winning_patterns?.length ? new Set(game.winning_patterns) : undefined;
      const pattern = checkWin(cartela.cardNumbers as unknown as BingoCard, cartela.markedCells as unknown as boolean[][], called, allowed);

      if (!pattern) {
        await tx.gameCartela.update({ where: { id: cartelaId }, data: { isDisqualified: true } });
        this.logger.warn(`False BINGO claim disqualified: cartela=${cartelaId} game=${game.id}`);
        return { disqualified: true, isWinner: false };
      }

      await tx.gameCartela.update({ where: { id: cartelaId }, data: { winningPattern: pattern as unknown as Prisma.InputJsonValue } });

      const newWinnerIds = [...game.winner_ids, cartelaId];
      await tx.game.update({
        where: { id: game.id },
        data: {
          winnerIds: newWinnerIds,
          claimWindowStart: game.claim_window_start ?? new Date(),
        },
      });

      return { isWinner: true, pattern };
    });
  }

  /**
   * Automatic post-draw win check is intentionally NOT ported as a hard
   * requirement — see PRODUCTION_MIGRATION_REPORT.md "Known gaps". Claim-based
   * detection above is authoritative and complete; auto-detection in the
   * previous system was a UX convenience (it fired a client-visible modal a
   * few hundred ms earlier), not a correctness or security requirement.
   */
  async checkAutoWinAfterDraw(_gameId: string): Promise<void> {
    return;
  }

  /** Called by the claim-window-expiry cron tick, or by an admin via force-finish. */
  async finalizeGame(gameId: string, adminId?: string): Promise<FinalizeResult> {
    const gameOperator = await this.prisma.game.findUnique({ where: { id: gameId }, select: { operatorId: true } });
    if (!gameOperator) throw new BadRequestException('Game not found');
    const operatorId = gameOperator.operatorId;
    // Read before the transaction: config, not money. A change mid-finalize can't
    // produce an inconsistent split because this one value is used for the whole game.
    const winnerPct = Number((await this.settings.get('WINNER_PERCENTAGE', operatorId)) ?? 80);

    const outcome = await this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx, operatorId);
      const rows = await tx.$queryRaw<Array<{ id: string; status: string; winner_ids: string[]; total_pot: Prisma.Decimal; called_numbers: number[] }>>`
        SELECT id, status, winner_ids, total_pot, called_numbers FROM games WHERE id = ${gameId} FOR UPDATE
      `;
      const game = rows[0];
      if (!game) throw new BadRequestException('Game not found');
      if (game.status === 'finished') return { result: { alreadyFinished: true } as FinalizeResult, notify: [] as Array<{ tgId: bigint; kind: 'win' | 'refund'; amount: number }> };

      const totalPot = Math.round(Number(game.total_pot));

      if (game.winner_ids.length === 0) {
        await tx.game.update({
          where: { id: gameId },
          data: { status: 'finished', finishedAt: new Date(), returnToLobbyAt: new Date(Date.now() + 8000) },
        });
        return { result: { winners: 0 } as FinalizeResult, notify: [] };
      }

      const winnerPool = Math.floor((totalPot * winnerPct) / 100);
      const perWinner = Math.floor(winnerPool / game.winner_ids.length);
      // Audit finding GAME-2 (Critical): `houseShare = totalPot - winnerPool`
      // alone absorbs the FIRST rounding remainder correctly, but
      // `perWinner = floor(winnerPool / n)` for n > 1 winners drops a SECOND
      // remainder (winnerPool - perWinner*n) that was never assigned anywhere
      // — not to a winner, not to the house, no ledger entry. Every uneven
      // multi-winner split silently lost up to (n-1) minor currency units
      // from the total pot with no trace. Folding that remainder into the
      // house share (rather than distributing it across winners) means
      // houseShare + sum(perWinner*n) === totalPot is now an *invariant*,
      // always exactly true, not just true when the division happens to be even.
      const distributedToWinners = perWinner * game.winner_ids.length;
      const houseShare = totalPot - distributedToWinners;

      const winnerCartelas = await tx.gameCartela.findMany({ where: { id: { in: game.winner_ids } } });
      const payouts: Record<string, number> = {};

      for (const wc of winnerCartelas) {
        await tx.telegramUser.update({ where: { id: wc.telegramUserId }, data: { wonBalance: { increment: perWinner } } });
        await tx.walletLedgerEntry.create({
          data: {
            telegramUserId: wc.telegramUserId,
            operatorId,
            entryType: 'WINNING_CREDIT',
            direction: 'credit',
            amount: perWinner,
            relatedEntityType: 'game',
            relatedEntityId: gameId,
            note: `BINGO winner — ${game.winner_ids.length > 1 ? 'split ' : ''}payout`,
          },
        });
        payouts[wc.id] = perWinner;
      }

      await tx.walletLedgerEntry.create({
        data: {
          telegramUserId: null,
          // No player on this row, so the operator can't be inferred later — it must be stamped here.
          operatorId,
          entryType: 'HOUSE_REVENUE',
          direction: 'credit',
          amount: houseShare,
          relatedEntityType: 'game',
          relatedEntityId: gameId,
          note: 'House share',
        },
      });

      await tx.game.update({
        where: { id: gameId },
        data: {
          status: 'finished',
          finishedAt: new Date(),
          returnToLobbyAt: new Date(Date.now() + 8000),
          winnerPrizeEach: perWinner,
          // Reflects what was ACTUALLY distributed to winners (perWinner * n),
          // not the pre-rounding theoretical winnerPool — see the rounding-fix
          // comment above. These two now always sum to exactly totalPot.
          winnerPrizeAmount: distributedToWinners,
          houseShareAmount: houseShare,
          winnerPayouts: payouts as unknown as Prisma.InputJsonValue,
        },
      });

      const notify: Array<{ tgId: bigint; kind: 'win'; amount: number }> = [];
      for (const wc of winnerCartelas) {
        const user = await tx.telegramUser.findUnique({ where: { id: wc.telegramUserId }, select: { telegramUserId: true } });
        if (user) notify.push({ tgId: user.telegramUserId, kind: 'win', amount: perWinner });
      }

      return { result: { winners: winnerCartelas.length, perWinner, houseShare, adminForced: Boolean(adminId) } as FinalizeResult, notify };
    });

    // Notify only after the payout/refund has committed.
    for (const n of outcome.notify) {
      const message = n.kind === 'win' ? `🏆 BINGO! You won ${n.amount} ETB.` : `Game ended with no winner. Your ${n.amount} ETB entry was refunded to your balance.`;
      void this.telegram.sendMessage(operatorId, Number(n.tgId), message);
    }
    return outcome.result;
  }
}

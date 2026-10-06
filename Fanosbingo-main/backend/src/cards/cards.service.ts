import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, RoomType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { generateBingoCard, initialMarkedCells } from './bingo-card-generator';
import { setTenantOnTx } from '../common/tenant/rls';

const RESERVATION_EXPIRY_MINUTES = 10;
const LEGACY_ROOM_TYPES = new Set<string>(['etb5', 'etb10']);

/**
 * Cartela purchase — the highest-concurrency-risk write path in the app.
 * Mirrors the guarantees of the previous `eds_select_cartela` SQL function:
 *   1. Row-lock the game (must be `waiting` and before selectionClosedAt).
 *   2. Row-lock the player's wallet before reading balance.
 *   3. Global 4-cartela limit is counted ACROSS BOTH ROOMS for this game.
 *   4. The (gameId, roomType, cartelaNumber) unique constraint is the final
 *      backstop against two players buying the same cartela — we let Postgres
 *      reject the race rather than trusting a pre-check alone.
 */
@Injectable()
export class CardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  async selectCartela(params: { gameId: string; room: string; cartelaNumber: number; userId: string; operatorId: string }) {
    const { gameId, room: roomCode, cartelaNumber, userId, operatorId } = params;
    const config = await this.settings.getGameConfig(operatorId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await setTenantOnTx(tx, operatorId);
        const game = await tx.$queryRaw<Array<{ id: string; operator_id: string; status: string; selection_closed_at: Date | null }>>`
          SELECT id, operator_id, status, selection_closed_at FROM games WHERE id = ${gameId} FOR UPDATE
        `;
        const g = game[0];
        // A game belonging to another operator is reported as not found — never confirm it exists.
        if (!g || g.operator_id !== operatorId) throw new BadRequestException('Game not found');
        if (g.status !== 'waiting') throw new ConflictException('GAME_NOT_WAITING');
        if (g.selection_closed_at && g.selection_closed_at.getTime() < Date.now()) {
          throw new ConflictException('SELECTION_CLOSED');
        }

        // Read the room inside the game lock so the price charged is the price in force right now.
        const room = await tx.operatorRoom.findUnique({ where: { operatorId_code: { operatorId, code: roomCode } } });
        if (!room || !room.isActive) throw new BadRequestException('Room not available');
        if (cartelaNumber < 1 || cartelaNumber > room.capacity) {
          throw new BadRequestException(`Cartela number must be between 1 and ${room.capacity} for room ${room.code}`);
        }
        const slot = await tx.cartelaSlot.findUnique({ where: { roomId_cartelaNumber: { roomId: room.id, cartelaNumber } } });
        if (slot && !slot.isActive) throw new ConflictException('CARTELA_UNAVAILABLE');
        const price = Number(room.price);

        const currentCount = await tx.gameCartela.count({ where: { gameId, telegramUserId: userId } });
        if (currentCount >= config.maxCartelasPerPlayer) {
          throw new ForbiddenException(`Maximum ${config.maxCartelasPerPlayer} cartelas per player`);
        }
        if (room.maxPerPlayer !== null) {
          const inRoom = await tx.gameCartela.count({ where: { gameId, telegramUserId: userId, roomId: room.id } });
          if (inRoom >= room.maxPerPlayer) throw new ForbiddenException(`Maximum ${room.maxPerPlayer} cartelas per player in this room`);
        }

        const lockedUser = await this.wallet.lockUserForUpdate(tx, userId);
        if (lockedUser.operator_id !== operatorId) throw new ForbiddenException('Account does not belong to this operator');
        const totalAvailable =
          Number(lockedUser.deposited_balance) + Number(lockedUser.won_balance) + Number(lockedUser.bonus_balance);
        if (totalAvailable < price) throw new ForbiddenException('INSUFFICIENT_BALANCE');

        // Debit order: deposited -> won -> bonus. Whatever portion comes from
        // bonus counts toward that bonus grant's wagering requirement (spec §24).
        let remaining = price;
        const fromDeposited = Math.min(remaining, Number(lockedUser.deposited_balance));
        remaining -= fromDeposited;
        const fromWon = Math.min(remaining, Number(lockedUser.won_balance));
        remaining -= fromWon;
        const fromBonus = remaining; // whatever's left must come from bonus, guaranteed covered by the totalAvailable check above

        await tx.telegramUser.update({
          where: { id: userId },
          data: {
            depositedBalance: { decrement: fromDeposited },
            wonBalance: { decrement: fromWon },
            bonusBalance: { decrement: fromBonus },
          },
        });

        await this.wallet.writeEntry(tx, {
          telegramUserId: userId,
          operatorId,
          entryType: 'GAME_ENTRY',
          direction: 'debit',
          amount: price,
          relatedEntityType: 'game',
          relatedEntityId: gameId,
          note: `${room.code.toUpperCase()} cartela #${cartelaNumber}`,
        });

        if (fromBonus > 0) {
          await this.applyBonusWagering(tx, userId, fromBonus);
        }

        const card = generateBingoCard();

        const cartela = await tx.gameCartela.create({
          data: {
            gameId,
            telegramUserId: userId,
            operatorId,
            roomId: room.id,
            roomType: LEGACY_ROOM_TYPES.has(room.code) ? (room.code as RoomType) : null,
            cartelaNumber,
            entryPrice: price,
            cardNumbers: card as unknown as Prisma.InputJsonValue,
            markedCells: initialMarkedCells() as unknown as Prisma.InputJsonValue,
            reservationExpiresAt: new Date(Date.now() + RESERVATION_EXPIRY_MINUTES * 60 * 1000),
            confirmedAt: new Date(), // single-step purchase flow — see PRODUCTION_MIGRATION_REPORT.md "Conflict resolutions" #2
          },
        });

        await tx.game.update({ where: { id: gameId }, data: { totalPot: { increment: price } } });

        return {
          playerId: cartela.id,
          room: room.code,
          cartelaNumber,
          price,
          card,
          cartelas: { total: currentCount + 1 },
          max: config.maxCartelasPerPlayer,
        };
      });
    } catch (e: unknown) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('CARD_TAKEN');
      }
      throw e;
    }
  }

  private async applyBonusWagering(tx: Prisma.TransactionClient, userId: string, amount: number) {
    const grants = await tx.bonusGrant.findMany({
      where: { telegramUserId: userId, status: 'active' },
      orderBy: { createdAt: 'asc' },
    });
    let remaining = amount;
    for (const grant of grants) {
      if (remaining <= 0) break;
      const need = Number(grant.wageringRequired) - Number(grant.wageringProgress);
      if (need <= 0) continue;
      const applied = Math.min(need, remaining);
      remaining -= applied;
      const newProgress = Number(grant.wageringProgress) + applied;
      await tx.bonusGrant.update({
        where: { id: grant.id },
        data: {
          wageringProgress: newProgress,
          status: newProgress >= Number(grant.wageringRequired) ? 'wagered_out' : 'active',
        },
      });
    }
  }

  /**
   * Audit finding SEC-8 (Low): ownership used to be checked once (findUnique
   * by id + compare in application code) and then trusted for the delete a
   * few lines later — correct today only because both statements run inside
   * one transaction with no way for ownership to change in between, but the
   * same fragile shape as DepositsService.cancel. The `findFirst` below now
   * filters by `telegramUserId` directly, and the final `deleteMany` re-
   * asserts it again rather than trusting the earlier read.
   */
  async releaseCartela(cartelaId: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx);
      const cartela = await tx.gameCartela.findFirst({ where: { id: cartelaId, telegramUserId: userId } });
      if (!cartela) throw new BadRequestException('Cartela not found');

      const game = await tx.game.findUnique({ where: { id: cartela.gameId } });
      if (!game || game.status !== 'waiting') {
        throw new ConflictException('Cannot release a cartela after the game has started');
      }

      const deleteResult = await tx.gameCartela.deleteMany({ where: { id: cartelaId, telegramUserId: userId } });
      if (deleteResult.count === 0) throw new BadRequestException('Cartela not found');
      await tx.game.update({ where: { id: cartela.gameId }, data: { totalPot: { decrement: cartela.entryPrice } } });

      const remaining = await tx.gameCartela.count({ where: { gameId: cartela.gameId, telegramUserId: userId } });
      return { cartelas: { total: remaining } };
    });
  }

  /** `scope` = the admin's operator (null = platform admin, any operator). */
  async regenerateCartela(cartelaId: string, adminId: string, reason: string, scope: string | null) {
    const cartela = await this.prisma.gameCartela.findFirst({ where: { id: cartelaId, ...(scope ? { operatorId: scope } : {}) } });
    if (!cartela) throw new BadRequestException('Cartela not found');

    const game = await this.prisma.game.findUnique({ where: { id: cartela.gameId } });
    if (!game || game.status !== 'waiting') {
      throw new ForbiddenException('Cannot regenerate a cartela once the game has started (spec §9: never modify sold/active cards)');
    }

    const newCard = generateBingoCard();
    const updated = await this.prisma.gameCartela.update({
      where: { id: cartelaId },
      data: { cardNumbers: newCard as unknown as Prisma.InputJsonValue, markedCells: initialMarkedCells() as unknown as Prisma.InputJsonValue },
    });

    await this.audit.log({
      actorType: 'admin',
      adminId,
      operatorId: cartela.operatorId,
      action: 'CARD_REGENERATED',
      entityType: 'game_cartela',
      entityId: cartelaId,
      previousState: { cardNumbers: cartela.cardNumbers },
      newState: { cardNumbers: newCard },
      reason,
    });

    return updated;
  }
}

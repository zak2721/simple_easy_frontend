import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { DEFAULT_OPERATOR_ID } from '../common/operator.constants';
import { LimitsService } from './limits.service';
import { setTenantOnTx } from '../common/tenant/rls';

type Tx = Prisma.TransactionClient;

/** The default operator's etb5/etb10 rooms are mirrored into the legacy settings keys the existing admin screen shows. */
const LEGACY_KEYS: Record<string, { price: string; capacity: string }> = {
  etb5: { price: 'ETB5_ROOM_PRICE', capacity: 'ETB5_ROOM_CAPACITY' },
  etb10: { price: 'ETB10_ROOM_PRICE', capacity: 'ETB10_ROOM_CAPACITY' },
};

export interface NewRoom {
  code: string;
  name: string;
  price: number;
  capacity: number;
  maxPerPlayer?: number | null;
}

/**
 * Rooms and cartela inventory. A room's `price` and `capacity` are read by
 * CardsService inside the purchase lock, so every change here takes effect
 * from the next purchase. Two invariants protect players:
 *   - capacity can't drop below a cartela number already sold in the live game
 *   - a cartela number sold in the live game can't be deactivated
 */
@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly limits: LimitsService,
  ) {}

  async getRoom(operatorId: string, roomId: string) {
    const room = await this.prisma.operatorRoom.findFirst({ where: { id: roomId, operatorId } });
    if (!room) throw new NotFoundException('Room not found');
    return room;
  }

  /** Rooms with live-game and all-time inventory figures (spec: sold / available / reserved / winning / revenue). */
  async inventory(operatorId: string) {
    const [rooms, liveGame, inactive, allTime, winners] = await Promise.all([
      this.prisma.operatorRoom.findMany({ where: { operatorId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
      this.prisma.game.findFirst({ where: { operatorId, status: { in: ['waiting', 'playing'] } }, select: { id: true, status: true } }),
      this.prisma.cartelaSlot.findMany({ where: { operatorId, isActive: false }, select: { roomId: true, cartelaNumber: true, deactivatedReason: true } }),
      this.prisma.gameCartela.groupBy({ by: ['roomId'], where: { operatorId }, _count: { _all: true }, _sum: { entryPrice: true } }),
      this.prisma.gameCartela.groupBy({ by: ['roomId'], where: { operatorId, winningPattern: { not: Prisma.AnyNull } }, _count: { _all: true } }),
    ]);
    const live = liveGame
      ? await this.prisma.gameCartela.groupBy({
          by: ['roomId'],
          where: { gameId: liveGame.id },
          _count: { _all: true },
        })
      : [];

    return {
      liveGame,
      rooms: rooms.map((r) => {
        const off = inactive.filter((s) => s.roomId === r.id && s.cartelaNumber <= r.capacity);
        const soldNow = live.find((x) => x.roomId === r.id)?._count._all ?? 0;
        const hist = allTime.find((x) => x.roomId === r.id);
        return {
          id: r.id,
          code: r.code,
          name: r.name,
          price: Number(r.price),
          capacity: r.capacity,
          maxPerPlayer: r.maxPerPlayer,
          isActive: r.isActive,
          sortOrder: r.sortOrder,
          inactiveNumbers: off.map((s) => ({ number: s.cartelaNumber, reason: s.deactivatedReason })),
          liveGame: liveGame ? { sold: soldNow, available: r.capacity - off.length - soldNow } : null,
          allTime: {
            sold: hist?._count._all ?? 0,
            revenue: Number(hist?._sum.entryPrice ?? 0),
            winning: winners.find((x) => x.roomId === r.id)?._count._all ?? 0,
          },
        };
      }),
    };
  }

  private async assertPriceWithinLimits(operatorId: string, price: number) {
    const l = await this.limits.get(operatorId);
    if (price < l.MIN_CARTELA_PRICE || price > l.MAX_CARTELA_PRICE) {
      throw new BadRequestException(`Cartela price must be between ${l.MIN_CARTELA_PRICE} and ${l.MAX_CARTELA_PRICE} ETB for this operator`);
    }
  }

  /** Total capacity across the operator's rooms after a change to one room (or a new one). */
  private async assertCapacityWithinLimits(tx: Tx, operatorId: string, change: { roomId?: string; capacity: number }) {
    const l = await this.limits.get(operatorId);
    const rooms = await tx.operatorRoom.findMany({ where: { operatorId }, select: { id: true, capacity: true } });
    const total = rooms.reduce((sum, r) => sum + (r.id === change.roomId ? 0 : r.capacity), 0) + change.capacity;
    if (total > l.MAX_TOTAL_CARTELAS) {
      throw new BadRequestException(`That would make ${total} cartelas in total; this operator's limit is ${l.MAX_TOTAL_CARTELAS}`);
    }
  }

  async createRoom(actingAdminId: string, operatorId: string, room: NewRoom) {
    await this.assertPriceWithinLimits(operatorId, room.price);
    const l = await this.limits.get(operatorId);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await setTenantOnTx(tx, operatorId);
        const count = await tx.operatorRoom.count({ where: { operatorId } });
        if (count >= l.MAX_ROOMS) throw new BadRequestException(`This operator can have at most ${l.MAX_ROOMS} rooms`);
        await this.assertCapacityWithinLimits(tx, operatorId, { capacity: room.capacity });
        const row = await tx.operatorRoom.create({
          data: {
            operatorId,
            code: room.code,
            name: room.name,
            price: room.price,
            capacity: room.capacity,
            maxPerPlayer: room.maxPerPlayer ?? null,
            sortOrder: count,
          },
        });
        await this.settings.ensureSlots(tx, row.id, operatorId, room.capacity);
        return row;
      });
      await this.audit.log({
        actorType: 'admin',
        adminId: actingAdminId,
        operatorId,
        action: 'ROOM_CREATED',
        entityType: 'operator_room',
        entityId: created.id,
        newState: room,
      });
      return created;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException(`A room with code "${room.code}" already exists`);
      throw e;
    }
  }

  /** Name / price / per-player cap / active flag. Price applies from the next purchase; sold cartelas keep the price they were bought at. */
  async updateRoom(actingAdminId: string, operatorId: string, roomId: string, patch: { name?: string; price?: number; maxPerPlayer?: number | null; isActive?: boolean }) {
    const before = await this.getRoom(operatorId, roomId);
    if (patch.price !== undefined) await this.assertPriceWithinLimits(operatorId, patch.price);
    if (patch.isActive === false && before.isActive) {
      const othersActive = await this.prisma.operatorRoom.count({ where: { operatorId, isActive: true, NOT: { id: roomId } } });
      if (othersActive === 0) throw new BadRequestException('At least one room must stay active');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx, operatorId);
      const row = await tx.operatorRoom.update({
        where: { id: roomId },
        data: {
          name: patch.name,
          price: patch.price,
          maxPerPlayer: patch.maxPerPlayer === undefined ? undefined : patch.maxPerPlayer,
          isActive: patch.isActive,
        },
      });
      if (patch.price !== undefined) await this.mirrorLegacy(tx, operatorId, row.code, 'price', patch.price);
      return row;
    });

    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId,
      action: 'ROOM_UPDATED',
      entityType: 'operator_room',
      entityId: roomId,
      previousState: { name: before.name, price: Number(before.price), maxPerPlayer: before.maxPerPlayer, isActive: before.isActive },
      newState: { name: updated.name, price: Number(updated.price), maxPerPlayer: updated.maxPerPlayer, isActive: updated.isActive },
    });
    return { before, after: updated };
  }

  /** Increase adds slots; decrease is refused if a number above the new capacity is sold in the live game. */
  async setCapacity(actingAdminId: string, operatorId: string, roomId: string, capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000) throw new BadRequestException('Capacity must be a whole number between 1 and 10000');
    const before = await this.getRoom(operatorId, roomId);

    await this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx, operatorId);
      await this.assertCapacityWithinLimits(tx, operatorId, { roomId, capacity });
      if (capacity < before.capacity) {
        const soldAbove = await tx.gameCartela.findFirst({
          where: { roomId, cartelaNumber: { gt: capacity }, game: { status: { in: ['waiting', 'playing'] } } },
          select: { cartelaNumber: true },
          orderBy: { cartelaNumber: 'desc' },
        });
        if (soldAbove) {
          throw new ConflictException(`Cartela #${soldAbove.cartelaNumber} is sold in the live game — capacity can't go below that until the game ends`);
        }
      }
      await tx.operatorRoom.update({ where: { id: roomId }, data: { capacity } });
      if (capacity > before.capacity) await this.settings.ensureSlots(tx, roomId, operatorId, capacity);
      await this.mirrorLegacy(tx, operatorId, before.code, 'capacity', capacity);
    });

    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId,
      action: capacity > before.capacity ? 'ROOM_CAPACITY_INCREASED' : 'ROOM_CAPACITY_DECREASED',
      entityType: 'operator_room',
      entityId: roomId,
      previousState: { capacity: before.capacity },
      newState: { capacity },
    });
    return { roomId, capacity, previousCapacity: before.capacity };
  }

  async setSlotActive(actingAdminId: string, operatorId: string, roomId: string, cartelaNumber: number, isActive: boolean, reason?: string) {
    const room = await this.getRoom(operatorId, roomId);
    if (cartelaNumber < 1 || cartelaNumber > room.capacity) throw new BadRequestException(`Cartela number must be between 1 and ${room.capacity}`);
    if (!isActive) {
      const soldLive = await this.prisma.gameCartela.findFirst({
        where: { roomId, cartelaNumber, game: { status: { in: ['waiting', 'playing'] } } },
        select: { id: true },
      });
      if (soldLive) throw new ConflictException(`Cartela #${cartelaNumber} is sold in the live game — it can be deactivated after the game ends`);
    }
    await this.prisma.cartelaSlot.upsert({
      where: { roomId_cartelaNumber: { roomId, cartelaNumber } },
      create: { operatorId, roomId, cartelaNumber, isActive, deactivatedReason: isActive ? null : (reason ?? null) },
      update: { isActive, deactivatedReason: isActive ? null : (reason ?? null) },
    });
    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId,
      action: isActive ? 'CARTELA_ACTIVATED' : 'CARTELA_DEACTIVATED',
      entityType: 'cartela_slot',
      entityId: `${roomId}:${cartelaNumber}`,
      newState: { room: room.code, cartelaNumber, isActive },
      reason,
    });
    return { roomId, cartelaNumber, isActive };
  }

  /**
   * Super Admin "reassign inventory": moves `amount` cartelas of capacity from
   * one room to another (possibly across operators), as one transaction.
   */
  async reassign(actingAdminId: string, fromRoomId: string, toRoomId: string, amount: number, reason: string) {
    if (fromRoomId === toRoomId) throw new BadRequestException('Choose two different rooms');
    if (!Number.isInteger(amount) || amount < 1) throw new BadRequestException('Amount must be a positive whole number');
    const [from, to] = await Promise.all([
      this.prisma.operatorRoom.findUnique({ where: { id: fromRoomId } }),
      this.prisma.operatorRoom.findUnique({ where: { id: toRoomId } }),
    ]);
    if (!from || !to) throw new NotFoundException('Room not found');
    if (from.capacity - amount < 1) throw new BadRequestException(`Room ${from.code} has only ${from.capacity} cartelas`);

    // Two steps, each re-validating its own invariants (live-game sales, limits).
    await this.setCapacity(actingAdminId, from.operatorId, from.id, from.capacity - amount);
    try {
      await this.setCapacity(actingAdminId, to.operatorId, to.id, to.capacity + amount);
    } catch (e) {
      await this.setCapacity(actingAdminId, from.operatorId, from.id, from.capacity); // put it back
      throw e;
    }
    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      action: 'INVENTORY_REASSIGNED',
      entityType: 'operator_room',
      entityId: `${from.id}->${to.id}`,
      newState: { from: { room: from.code, operatorId: from.operatorId }, to: { room: to.code, operatorId: to.operatorId }, amount },
      reason,
    });
    return { from: { roomId: from.id, capacity: from.capacity - amount }, to: { roomId: to.id, capacity: to.capacity + amount } };
  }

  private async mirrorLegacy(tx: Tx, operatorId: string, code: string, field: 'price' | 'capacity', value: number) {
    const keys = LEGACY_KEYS[code];
    if (operatorId !== DEFAULT_OPERATOR_ID || !keys) return;
    const id = keys[field];
    await tx.setting.upsert({ where: { id }, create: { id, value: String(value) }, update: { value: String(value) } });
  }
}

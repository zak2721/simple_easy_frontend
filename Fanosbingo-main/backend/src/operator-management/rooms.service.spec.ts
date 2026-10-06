import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { LIMIT_DEFAULTS } from './limits.service';

describe('RoomsService invariants', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let limits: { get: ReturnType<typeof vi.fn> };
  let service: RoomsService;
  const room = { id: 'room-1', operatorId: 'op-1', code: 'main', name: 'Main', price: 20, capacity: 100, maxPerPlayer: null, isActive: true };

  beforeEach(() => {
    const tx = {
      operatorRoom: { findMany: vi.fn().mockResolvedValue([{ id: 'room-1', capacity: 100 }]), update: vi.fn() },
      gameCartela: { findFirst: vi.fn().mockResolvedValue(null) },
      setting: { upsert: vi.fn() },
      $executeRaw: vi.fn(),
    };
    prisma = {
      $transaction: vi.fn(async (cb) => cb(tx)),
      _tx: tx,
      operatorRoom: { findFirst: vi.fn().mockResolvedValue(room), count: vi.fn().mockResolvedValue(1), update: vi.fn() },
      gameCartela: { findFirst: vi.fn().mockResolvedValue(null) },
      cartelaSlot: { upsert: vi.fn() },
    };
    limits = { get: vi.fn().mockResolvedValue({ ...LIMIT_DEFAULTS }) };
    const settings = { ensureSlots: vi.fn() };
    service = new RoomsService(prisma, { log: vi.fn() } as never, settings as never, limits as never);
  });

  it("capacity can't drop below a cartela number sold in the live game", async () => {
    prisma._tx.gameCartela.findFirst.mockResolvedValue({ cartelaNumber: 87 });
    await expect(service.setCapacity('a', 'op-1', 'room-1', 50)).rejects.toThrow(ConflictException);
    expect(prisma._tx.operatorRoom.update).not.toHaveBeenCalled();
  });

  it('capacity decrease with no live sales above the new capacity applies', async () => {
    await service.setCapacity('a', 'op-1', 'room-1', 50);
    expect(prisma._tx.operatorRoom.update).toHaveBeenCalledWith({ where: { id: 'room-1' }, data: { capacity: 50 } });
  });

  it("the operator's MAX_TOTAL_CARTELAS limit caps increases", async () => {
    limits.get.mockResolvedValue({ ...LIMIT_DEFAULTS, MAX_TOTAL_CARTELAS: 120 });
    await expect(service.setCapacity('a', 'op-1', 'room-1', 150)).rejects.toThrow('limit is 120');
  });

  it('price must stay within the operator\'s MIN/MAX cartela price', async () => {
    limits.get.mockResolvedValue({ ...LIMIT_DEFAULTS, MIN_CARTELA_PRICE: 5, MAX_CARTELA_PRICE: 50 });
    await expect(service.updateRoom('a', 'op-1', 'room-1', { price: 100 })).rejects.toThrow(BadRequestException);
    await expect(service.updateRoom('a', 'op-1', 'room-1', { price: 2 })).rejects.toThrow(BadRequestException);
  });

  it('the last active room cannot be switched off', async () => {
    prisma.operatorRoom.count.mockResolvedValue(0);
    await expect(service.updateRoom('a', 'op-1', 'room-1', { isActive: false })).rejects.toThrow('At least one room');
  });

  it("a cartela number sold in the live game can't be deactivated", async () => {
    prisma.gameCartela.findFirst.mockResolvedValue({ id: 'c1' });
    await expect(service.setSlotActive('a', 'op-1', 'room-1', 7, false, 'damaged')).rejects.toThrow(ConflictException);
    expect(prisma.cartelaSlot.upsert).not.toHaveBeenCalled();
  });

  it('a room of another operator is not found', async () => {
    prisma.operatorRoom.findFirst.mockResolvedValue(null);
    await expect(service.setCapacity('a', 'op-2', 'room-1', 10)).rejects.toThrow('Room not found');
    expect(prisma.operatorRoom.findFirst).toHaveBeenCalledWith({ where: { id: 'room-1', operatorId: 'op-2' } });
  });
});

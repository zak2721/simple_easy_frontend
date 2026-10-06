import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DEFAULT_OPERATOR_ID } from '../common/operator.constants';
import { validatePatternList } from '../cards/bingo-card-generator';
import { setTenantOnTx } from '../common/tenant/rls';

export interface RoomConfig {
  id: string;
  code: string;
  name: string;
  price: number;
  capacity: number;
  maxPerPlayer: number | null;
}

export interface GameConfig {
  name: string;
  currency: string;
  /** Active rooms, in display order. */
  rooms: RoomConfig[];
  /** Legacy fields derived from the rooms coded etb5/etb10 (0 when absent) — kept so existing clients keep working. */
  etb5Price: number;
  etb5Capacity: number;
  etb10Price: number;
  etb10Capacity: number;
  standardTotalCartelas: number;
  maxCartelasPerPlayer: number;
  winnerPercentage: number;
  housePercentage: number;
  reservationExpiryMinutes: number;
  purchaseWindowSeconds: number;
  minDepositEtb: number;
  minWithdrawalEtb: number;
}

const DEFAULTS: Record<string, string> = {
  YENA_BINGO_NAME: 'የኛ bingo',
  ETB5_ROOM_PRICE: '5',
  ETB5_ROOM_CAPACITY: '400',
  ETB10_ROOM_PRICE: '10',
  ETB10_ROOM_CAPACITY: '200',
  MAX_STANDARD_CARTELAS: '600',
  MAX_CARTELAS_PER_PLAYER: '4',
  WINNER_PERCENTAGE: '80',
  HOUSE_PERCENTAGE: '20',
  RESERVATION_EXPIRY_MINUTES: '10',
  PURCHASE_WINDOW_SECONDS: '60',
  DEPOSIT_MIN_ETB: '200',
  WITHDRAWAL_MIN_ETB: '50',
  TELEBIRR_ACCOUNT_NAME: '',
  TELEBIRR_ACCOUNT_NUMBER: '',
  TELEBIRR_INSTRUCTIONS: '',
  GAME_URL: '',
  SIGNUP_BONUS_ETB: '30',
  WELCOME_BONUS_ENABLED: 'true',
  SIGNUP_BONUS_WAGERING_MULTIPLIER: '1',
  /** 0 = never expires (preserves pre-existing behavior). See BonusService.expireStaleBonuses. */
  BONUS_EXPIRY_DAYS: '0',
  USER_INSTRUCTIONS: '',
  CONTACT_TELEGRAM: '',
  CONTACT_PHONE: '',
  CONTACT_WHATSAPP: '',
  CONTACT_EMAIL: '',
  CONTACT_SUPPORT_HOURS: '',
  REFERRAL_ENABLED: 'true',
  REFERRAL_BONUS_REFERRER_ETB: '10',
  REFERRAL_BONUS_NEW_USER_ETB: '5',
  REFERRAL_MAX_PER_USER: '20',
  /** Winning patterns for continuous-mode games (scheduled games set their own). */
  WINNING_PATTERNS: 'row,column,diagonal,corners',
  /**
   * Sybil/bonus-farming defense: how many SIGNUP/REFERRAL_* bonus grants may
   * pay out per day across every account sharing a signup IP or device id
   * (see BonusService.exceedsFingerprintCap). 0 disables the check entirely.
   * Deliberately a count of PAYOUTS, not a birr amount — stays meaningful
   * across operators with very different bonus sizes/currencies.
   */
  MAX_BONUS_GRANTS_PER_FINGERPRINT_PER_DAY: '3',
};

/** Legacy per-room settings keys, kept in sync with the default operator's operator_rooms rows. */
const LEGACY_ROOM_KEYS: Record<string, { code: string; field: 'price' | 'capacity' }> = {
  ETB5_ROOM_PRICE: { code: 'etb5', field: 'price' },
  ETB5_ROOM_CAPACITY: { code: 'etb5', field: 'capacity' },
  ETB10_ROOM_PRICE: { code: 'etb10', field: 'price' },
  ETB10_ROOM_CAPACITY: { code: 'etb10', field: 'capacity' },
};

/**
 * Runtime config, per operator.
 *
 * Lookup order:
 *  - default operator: operator_settings -> settings (the pre-multi-operator
 *    table, unchanged) -> DEFAULTS
 *  - any other operator: operator_settings -> DEFAULTS
 *
 * Other operators deliberately never fall back to the `settings` table: it
 * holds the default operator's Telebirr account, contact details and bonus
 * rules, and a new operator's players must never be shown those.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(key: string, operatorId: string): Promise<string | null> {
    const own = await this.prisma.operatorSetting.findUnique({ where: { operatorId_key: { operatorId, key } } });
    if (own) return own.value;
    if (operatorId === DEFAULT_OPERATOR_ID) {
      const row = await this.prisma.setting.findUnique({ where: { id: key } });
      if (row) return row.value;
    }
    return DEFAULTS[key] ?? null;
  }

  async getAll(operatorId: string): Promise<Record<string, string>> {
    const map: Record<string, string> = { ...DEFAULTS };
    if (operatorId === DEFAULT_OPERATOR_ID) {
      for (const row of await this.prisma.setting.findMany()) map[row.id] = row.value;
    }
    for (const row of await this.prisma.operatorSetting.findMany({ where: { operatorId } })) map[row.key] = row.value;
    return map;
  }

  async set(key: string, rawValue: string, adminId: string, operatorId: string): Promise<void> {
    let value = rawValue;
    if (key === 'WINNING_PATTERNS') {
      try {
        value = validatePatternList(rawValue.split(',')).join(',');
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
    }
    const previous = await this.get(key, operatorId);
    const legacyRoom = LEGACY_ROOM_KEYS[key];

    await this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx, operatorId);
      if (operatorId === DEFAULT_OPERATOR_ID) {
        await tx.setting.upsert({ where: { id: key }, create: { id: key, value }, update: { value } });
      } else {
        await tx.operatorSetting.upsert({
          where: { operatorId_key: { operatorId, key } },
          create: { operatorId, key, value, updatedByAdminId: adminId },
          update: { value, updatedByAdminId: adminId },
        });
      }
      if (legacyRoom) await this.syncLegacyRoom(tx, operatorId, legacyRoom.code, legacyRoom.field, value);
    });

    await this.audit.log({
      actorType: 'admin',
      adminId,
      operatorId,
      action: 'SETTINGS_UPDATED',
      entityType: 'setting',
      entityId: key,
      previousState: { value: previous },
      newState: { value },
    });
  }

  /** operator_rooms is the source of truth for price/capacity; the old ETB5_/ETB10_ settings keys write through to it. */
  private async syncLegacyRoom(tx: Prisma.TransactionClient, operatorId: string, code: string, field: 'price' | 'capacity', raw: string) {
    const num = Number(raw);
    if (field === 'price' && !(num > 0)) throw new BadRequestException('Room price must be greater than 0');
    if (field === 'capacity' && !(Number.isInteger(num) && num >= 1 && num <= 10000)) {
      throw new BadRequestException('Room capacity must be a whole number between 1 and 10000');
    }
    const room = await tx.operatorRoom.findUnique({ where: { operatorId_code: { operatorId, code } } });
    if (!room) return;
    await tx.operatorRoom.update({ where: { id: room.id }, data: { [field]: num } });
    if (field === 'capacity' && num > room.capacity) await this.ensureSlots(tx, room.id, operatorId, num);
  }

  /** Creates any missing cartela_slots rows 1..capacity. Slots above capacity are simply ignored by purchase validation. */
  async ensureSlots(tx: Prisma.TransactionClient, roomId: string, operatorId: string, capacity: number) {
    await tx.$executeRaw`
      INSERT INTO cartela_slots (id, operator_id, room_id, cartela_number)
      SELECT gen_random_uuid()::text, ${operatorId}, ${roomId}, n
      FROM generate_series(1, ${capacity}::int) AS n
      ON CONFLICT (room_id, cartela_number) DO NOTHING
    `;
  }

  async getRooms(operatorId: string): Promise<RoomConfig[]> {
    const rooms = await this.prisma.operatorRoom.findMany({
      where: { operatorId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rooms.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      price: Number(r.price),
      capacity: r.capacity,
      maxPerPlayer: r.maxPerPlayer,
    }));
  }

  async getGameConfig(operatorId: string): Promise<GameConfig> {
    const [s, rooms] = await Promise.all([this.getAll(operatorId), this.getRooms(operatorId)]);
    const etb5 = rooms.find((r) => r.code === 'etb5');
    const etb10 = rooms.find((r) => r.code === 'etb10');
    return {
      name: s.YENA_BINGO_NAME,
      currency: 'ETB',
      rooms,
      etb5Price: etb5?.price ?? 0,
      etb5Capacity: etb5?.capacity ?? 0,
      etb10Price: etb10?.price ?? 0,
      etb10Capacity: etb10?.capacity ?? 0,
      standardTotalCartelas: rooms.reduce((sum, r) => sum + r.capacity, 0),
      maxCartelasPerPlayer: Number(s.MAX_CARTELAS_PER_PLAYER),
      winnerPercentage: Number(s.WINNER_PERCENTAGE),
      housePercentage: Number(s.HOUSE_PERCENTAGE),
      reservationExpiryMinutes: Number(s.RESERVATION_EXPIRY_MINUTES),
      purchaseWindowSeconds: Number(s.PURCHASE_WINDOW_SECONDS),
      minDepositEtb: Number(s.DEPOSIT_MIN_ETB),
      minWithdrawalEtb: Number(s.WITHDRAWAL_MIN_ETB),
    };
  }

  async getTelebirrAccount(operatorId: string) {
    const s = await this.getAll(operatorId);
    return {
      account_name: s.TELEBIRR_ACCOUNT_NAME,
      account_number: s.TELEBIRR_ACCOUNT_NUMBER,
      instructions: s.TELEBIRR_INSTRUCTIONS,
      min_etb: Number(s.DEPOSIT_MIN_ETB),
      max_etb: 50000,
      configured: Boolean(s.TELEBIRR_ACCOUNT_NAME && s.TELEBIRR_ACCOUNT_NUMBER),
    };
  }

  async getContactInfo(operatorId: string) {
    const s = await this.getAll(operatorId);
    return {
      telegram: s.CONTACT_TELEGRAM,
      phone: s.CONTACT_PHONE,
      whatsapp: s.CONTACT_WHATSAPP,
      email: s.CONTACT_EMAIL,
      support_hours: s.CONTACT_SUPPORT_HOURS,
      configured: Boolean(s.CONTACT_TELEGRAM || s.CONTACT_PHONE || s.CONTACT_WHATSAPP || s.CONTACT_EMAIL),
    };
  }
}

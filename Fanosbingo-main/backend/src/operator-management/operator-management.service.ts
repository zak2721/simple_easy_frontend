import { BadRequestException, ConflictException, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { OperatorsService } from '../operators/operators.service';
import { SettingsService } from '../settings/settings.service';
import { TelegramService } from '../telegram/telegram.service';
import { PasswordService } from '../auth/password.service';
import { DEFAULT_OPERATOR_ID } from '../common/operator.constants';
import { encryptSecret } from '../common/crypto/secret-box';
import { NotificationsService } from '../notifications/notifications.service';
import type { ConfigureBotDto, CreateOperatorDto } from './dto/operator-management.dto';
import { setTenantOnTx, tenantSetConfigOp } from '../common/tenant/rls';

function isUniqueViolation(e: unknown): e is Prisma.PrismaClientKnownRequestError {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

/**
 * Platform-side operator lifecycle (Super Admin / platform admins holding
 * MANAGE_OPERATORS), plus bot configuration, which the operator's own owner
 * can also do. Operators are never hard-deleted: every money row references
 * them with ON DELETE RESTRICT. "Delete" is status = disabled.
 */
@Injectable()
export class OperatorManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly operators: OperatorsService,
    private readonly settings: SettingsService,
    private readonly telegram: TelegramService,
    private readonly passwords: PasswordService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  /** 12-character alphanumeric temporary password generated with a CSPRNG. Never stored; returned once in the create() response. */
  private generateTemporaryPassword(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(12);
    return Array.from(bytes)
      .map((b) => chars[b % chars.length])
      .join('');
  }

  async list() {
    const ops = await this.prisma.operator.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        rooms: { orderBy: { sortOrder: 'asc' }, select: { code: true, name: true, price: true, capacity: true, isActive: true } },
        subscriptionPlan: { select: { key: true, name: true } },
        _count: { select: { players: true, admins: true } },
      },
    });
    const owners = await this.prisma.adminUser.findMany({
      where: { role: 'OPERATOR_OWNER' },
      select: { id: true, username: true, fullName: true, status: true, operatorId: true },
    });
    return ops.map((op) => this.serialize(op, owners.find((o) => o.operatorId === op.id) ?? null));
  }

  private serialize(
    op: Prisma.OperatorGetPayload<{
      include: {
        rooms: { select: { code: true; name: true; price: true; capacity: true; isActive: true } };
        subscriptionPlan: { select: { key: true; name: true } };
        _count: { select: { players: true; admins: true } };
      };
    }>,
    owner: { id: string; username: string; fullName: string; status: string } | null,
  ) {
    return {
      id: op.id,
      slug: op.slug,
      name: op.name,
      status: op.status,
      suspendedReason: op.suspendedReason,
      isDefault: op.id === DEFAULT_OPERATOR_ID,
      appUrl: this.operators.appUrl(op),
      bot: { username: op.botUsername, configured: Boolean(op.botTokenEncrypted) || op.id === DEFAULT_OPERATOR_ID },
      owner,
      rooms: op.rooms.map((r) => ({ ...r, price: Number(r.price) })),
      players: op._count.players,
      adminAccounts: op._count.admins,
      subscription: {
        planKey: (op as any).subscriptionPlan?.key ?? null,
        planName: (op as any).subscriptionPlan?.name ?? null,
        status: op.subscriptionStatus,
        expiresAt: op.subscriptionExpiresAt,
      },
      businessPhone: op.businessPhone,
      businessEmail: op.businessEmail,
      createdAt: op.createdAt,
    };
  }

  /** Operator + branding + rooms + cartela slots + owner account, all or nothing. */
  async create(actingAdminId: string, dto: CreateOperatorDto) {
    const codes = dto.rooms.map((r) => r.code);
    if (new Set(codes).size !== codes.length) throw new BadRequestException('Room codes must be unique');

    // Generate a temporary password when the caller omits one (Phase 8b).
    const temporaryPassword = dto.owner.password == null ? this.generateTemporaryPassword() : null;
    const plainPassword = temporaryPassword ?? dto.owner.password!;
    const passwordHash = await this.passwords.hash(plainPassword);

    let created;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        // Resolve subscriptionPlanId — fall back to the "legacy" plan if omitted.
        const planId = dto.subscriptionPlanId ?? '00000000-0000-0000-0000-000000000010';

        const operator = await tx.operator.create({
          data: {
            slug: dto.slug,
            name: dto.name,
            status: 'active',
            createdByAdminId: actingAdminId,
            businessPhone: dto.businessPhone ?? null,
            businessEmail: dto.businessEmail ?? null,
            subscriptionPlanId: planId,
            subscriptionStatus: 'active',
            subscriptionStartedAt: new Date(),
          },
        });
        // Only known once the row above exists — every subsequent statement in
        // this transaction (branding/rooms/settings/owner) creates rows scoped
        // to this brand-new operator, so this scopes the rest of the transaction.
        await setTenantOnTx(tx, operator.id);
        await tx.operatorBranding.create({ data: { operatorId: operator.id, displayName: dto.name } });
        for (const [i, room] of dto.rooms.entries()) {
          const row = await tx.operatorRoom.create({
            data: {
              operatorId: operator.id,
              code: room.code,
              name: room.name,
              price: room.price,
              capacity: room.capacity,
              maxPerPlayer: room.maxPerPlayer ?? null,
              sortOrder: i,
            },
          });
          await this.settings.ensureSlots(tx, row.id, operator.id, room.capacity);
        }
        // The operator's display name is also its YENA_BINGO_NAME setting (read by config/lobby).
        await tx.operatorSetting.create({ data: { operatorId: operator.id, key: 'YENA_BINGO_NAME', value: dto.name, updatedByAdminId: actingAdminId } });
        const owner = await tx.adminUser.create({
          data: {
            username: dto.owner.username,
            passwordHash,
            passwordChangedAt: new Date(),
            fullName: dto.owner.fullName,
            role: 'OPERATOR_OWNER',
            operatorId: operator.id,
            createdByAdminId: actingAdminId,
            // Force a password change on first login when we generated the password.
            mustChangePassword: temporaryPassword !== null,
          },
        });
        await tx.operator.update({ where: { id: operator.id }, data: { ownerAdminId: owner.id } });
        return { operator, owner };
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        const target = String((e.meta as { target?: unknown } | undefined)?.target ?? '');
        throw new ConflictException(target.includes('slug') ? 'That operator slug is already taken' : 'That username is already taken');
      }
      throw e;
    }

    this.operators.invalidate();
    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId: created.operator.id,
      action: 'OPERATOR_CREATED',
      entityType: 'operator',
      entityId: created.operator.id,
      newState: { slug: dto.slug, name: dto.name, owner: dto.owner.username, rooms: dto.rooms },
    });
    const baseUrl = (this.config.get<string>('YENA_BINGO_APP_URL') ?? '').replace(/\/$/, '');
    const adminUrl = baseUrl ? `${baseUrl}/admin` : '/admin';

    return {
      id: created.operator.id,
      slug: created.operator.slug,
      appUrl: this.operators.appUrl(created.operator),
      adminUrl,
      owner: { id: created.owner.id, username: created.owner.username },
      ...(temporaryPassword !== null && { temporaryPassword }),
      mustChangePassword: temporaryPassword !== null,
      nextStep: 'The owner signs in to the admin panel and connects their Telegram bot (PUT /operator/bot) before players can join.',
    };
  }

  private async getOrThrow(operatorId: string) {
    const op = await this.prisma.operator.findUnique({ where: { id: operatorId } });
    if (!op) throw new NotFoundException('Operator not found');
    return op;
  }

  /**
   * Suspend / disable / reactivate. A non-active operator's players are
   * rejected on their next request (JwtPlayerStrategy), its bot goes silent,
   * its engine loop stops, and its admins' sessions are revoked immediately.
   */
  async setStatus(actingAdminId: string, operatorId: string, status: 'active' | 'suspended' | 'disabled', reason: string) {
    if (operatorId === DEFAULT_OPERATOR_ID && status !== 'active') {
      throw new ForbiddenException('The default operator (yena) cannot be suspended or disabled');
    }
    const before = await this.getOrThrow(operatorId);

    await this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx, operatorId);
      await tx.operator.update({
        where: { id: operatorId },
        data: status === 'active' ? { status, suspendedReason: null, suspendedAt: null } : { status, suspendedReason: reason, suspendedAt: new Date() },
      });
      if (status !== 'active') {
        const now = new Date();
        const adminIds = (await tx.adminUser.findMany({ where: { operatorId }, select: { id: true } })).map((a) => a.id);
        await tx.adminSession.updateMany({ where: { adminId: { in: adminIds }, revokedAt: null }, data: { revokedAt: now } });
        await tx.adminRefreshToken.updateMany({ where: { adminId: { in: adminIds }, revokedAt: null }, data: { revokedAt: now } });
      }
    });
    this.operators.invalidate(operatorId);

    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId,
      action: status === 'active' ? 'OPERATOR_REACTIVATED' : status === 'suspended' ? 'OPERATOR_SUSPENDED' : 'OPERATOR_DISABLED',
      entityType: 'operator',
      entityId: operatorId,
      previousState: { status: before.status },
      newState: { status },
      reason,
    });
    return { id: operatorId, status };
  }

  /**
   * continuous = the engine creates the next game automatically;
   * scheduled = the operator creates each game. Switching doesn't touch a game
   * already live: it finishes normally, and the new mode applies after it.
   */
  async setGameMode(actingAdminId: string, operatorId: string, gameMode: 'continuous' | 'scheduled') {
    const before = await this.getOrThrow(operatorId);
    if (before.gameMode === gameMode) return { id: operatorId, gameMode };
    if (gameMode === 'continuous') {
      const scheduled = await this.prisma.game.count({ where: { operatorId, status: 'scheduled' } });
      if (scheduled > 0) throw new BadRequestException(`Cancel the ${scheduled} scheduled game(s) first — continuous mode would never open their sales`);
    }
    await this.prisma.operator.update({ where: { id: operatorId }, data: { gameMode } });
    this.operators.invalidate(operatorId);
    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId,
      action: 'OPERATOR_GAME_MODE_CHANGED',
      entityType: 'operator',
      entityId: operatorId,
      previousState: { gameMode: before.gameMode },
      newState: { gameMode },
    });
    await this.notifications.notifyOperator(operatorId, {
      type: 'GAME_MODE_CHANGED',
      title: gameMode === 'scheduled' ? 'Games are now scheduled by you' : 'Games now run continuously',
      body: gameMode === 'scheduled' ? 'Create games from Games. No game starts automatically any more.' : 'A new game starts automatically after each one ends.',
    });
    return { id: operatorId, gameMode };
  }

  async resetOwnerPassword(actingAdminId: string, operatorId: string, newPassword: string) {
    const owner = await this.prisma.adminUser.findFirst({ where: { operatorId, role: 'OPERATOR_OWNER' } });
    if (!owner) throw new NotFoundException('This operator has no owner account');
    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction([
      tenantSetConfigOp(this.prisma, operatorId),
      this.prisma.adminUser.update({
        where: { id: owner.id },
        data: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null },
      }),
      this.prisma.adminSession.updateMany({ where: { adminId: owner.id, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.prisma.adminRefreshToken.updateMany({ where: { adminId: owner.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId,
      action: 'OPERATOR_OWNER_PASSWORD_RESET',
      entityType: 'admin',
      entityId: owner.id,
    });
    return { success: true };
  }

  /** The new owner must already be an active staff member of the same operator; the old owner becomes staff. */
  async transferOwnership(actingAdminId: string, operatorId: string, newOwnerAdminId: string, reason: string) {
    const [currentOwner, candidate] = await Promise.all([
      this.prisma.adminUser.findFirst({ where: { operatorId, role: 'OPERATOR_OWNER' } }),
      this.prisma.adminUser.findUnique({ where: { id: newOwnerAdminId } }),
    ]);
    if (!candidate || candidate.operatorId !== operatorId || candidate.role !== 'OPERATOR_STAFF') {
      throw new BadRequestException('The new owner must be a staff account of this operator');
    }
    if (candidate.status !== 'active') throw new BadRequestException('The new owner account must be active');

    await this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx, operatorId);
      // Demote first: uniq_operator_owner allows only one owner at any moment.
      if (currentOwner) await tx.adminUser.update({ where: { id: currentOwner.id }, data: { role: 'OPERATOR_STAFF' } });
      await tx.adminPermission.deleteMany({ where: { adminId: candidate.id } }); // owners hold every operator permission implicitly
      await tx.adminUser.update({ where: { id: candidate.id }, data: { role: 'OPERATOR_OWNER' } });
      await tx.operator.update({ where: { id: operatorId }, data: { ownerAdminId: candidate.id } });
    });
    this.operators.invalidate(operatorId);

    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId,
      action: 'OPERATOR_OWNERSHIP_TRANSFERRED',
      entityType: 'operator',
      entityId: operatorId,
      previousState: { ownerAdminId: currentOwner?.id ?? null },
      newState: { ownerAdminId: candidate.id },
      reason,
    });
    return { operatorId, ownerAdminId: candidate.id, previousOwnerNowStaff: currentOwner?.id ?? null };
  }

  async getBot(operatorId: string) {
    const op = await this.getOrThrow(operatorId);
    return {
      botUsername: op.botUsername,
      configured: Boolean(op.botTokenEncrypted),
      miniAppUrl: this.operators.appUrl(op),
    };
  }

  /**
   * Connects the operator's own @BotFather bot: verifies the token with
   * Telegram (getMe), stores it encrypted, generates a fresh webhook secret,
   * registers the webhook, and points the bot's menu button at the operator's
   * Mini App. The token is never logged, audited or returned.
   */
  async configureBot(actingAdminId: string, operatorId: string, dto: ConfigureBotDto) {
    if (operatorId === DEFAULT_OPERATOR_ID) {
      throw new BadRequestException('The default operator uses the platform bot from the server environment (TELEGRAM_BOT_TOKEN)');
    }
    const op = await this.getOrThrow(operatorId);
    const key = this.config.get<string>('PLATFORM_ENCRYPTION_KEY');
    if (!key) throw new InternalServerErrorException('PLATFORM_ENCRYPTION_KEY is not configured on the server — ask the platform owner');

    const me = await this.telegram.getMe(dto.botToken);
    if (!me) throw new BadRequestException('Telegram rejected this bot token — copy it again from @BotFather');

    const clash = await this.prisma.operator.findFirst({ where: { botUsername: me.username, NOT: { id: operatorId } }, select: { slug: true } });
    if (clash) throw new ConflictException('This bot is already connected to another operator');

    await this.prisma.operator.update({
      where: { id: operatorId },
      data: {
        botUsername: me.username,
        botTokenEncrypted: encryptSecret(dto.botToken, key),
        webhookSecret: crypto.randomBytes(32).toString('hex'),
      },
    });
    this.operators.invalidate(operatorId);

    const publicApiUrl = dto.publicApiUrl ?? `${(this.config.get<string>('YENA_BINGO_APP_URL') ?? '').replace(/\/$/, '')}/api`;
    let webhook: { ok: boolean; description?: string; webhookUrl?: string };
    try {
      webhook = await this.telegram.setupWebhook(operatorId, publicApiUrl);
      await this.telegram.setMenuButton(operatorId, op.name, this.operators.appUrl(op));
    } catch (e) {
      webhook = { ok: false, description: e instanceof Error ? e.message : String(e) };
    }

    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId,
      action: 'OPERATOR_BOT_CONFIGURED',
      entityType: 'operator',
      entityId: operatorId,
      previousState: { botUsername: op.botUsername },
      newState: { botUsername: me.username, webhookOk: webhook.ok },
    });
    await this.notifications.notifyPlatform({
      type: 'OPERATOR_BOT_CONFIGURED',
      severity: webhook.ok ? 'info' : 'warning',
      title: `Telegram bot connected: @${me.username}`,
      body: webhook.ok ? undefined : `Webhook registration failed: ${webhook.description ?? 'unknown error'}`,
      operatorId,
      relatedEntityType: 'operator',
      relatedEntityId: operatorId,
    });
    return { botUsername: me.username, miniAppUrl: this.operators.appUrl(op), webhook };
  }
}

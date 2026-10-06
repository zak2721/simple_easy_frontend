import { BadRequestException, ForbiddenException, Injectable, InternalServerErrorException, Logger, UnauthorizedException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { encryptSecret, decryptSecret } from '../common/crypto/secret-box';
import { generateTotpSecret, totpAuthUrl, verifyTotp } from '../common/crypto/totp';
import { generateRecoveryCodes, normalizeRecoveryCode } from '../common/crypto/recovery-codes';
import { TelegramService } from '../telegram/telegram.service';
import { WalletService } from '../wallet/wallet.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { ReferralsService } from '../referrals/referrals.service';
import { BonusService } from '../bonus/bonus.service';
import { generateReferralCode } from '../referrals/referral-code.util';
import { ThemeService } from '../theme/theme.service';
import { OperatorsService } from '../operators/operators.service';
import { hashToken } from './strategies/jwt-admin.strategy';
import { PasswordService } from './password.service';
import { LoginHistoryService, type LoginAttempt } from './login-history.service';
import { NotificationsService } from '../notifications/notifications.service';
import { setTenantOnTx } from '../common/tenant/rls';
import type { RequestAdmin } from '../common/decorators/current-user.decorator';
import type { TelegramLoginDto, AdminBootstrapDto, AdminLoginDto } from './dto/auth.dto';

function constantTimeStringEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal-length dummy buffers so the early
    // return doesn't leak length via timing on top of the (already public) HTTP body size.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

const PLAYER_ACCESS_TTL = '15m';
const PLAYER_REFRESH_TTL_DAYS = 30;
const ADMIN_ACCESS_TTL_SECONDS = 15 * 60;
const ADMIN_SESSION_TTL_HOURS = 12;
const ADMIN_REFRESH_IDLE_MINUTES = 60;
/** Deliberately short and not renewable via refresh — re-request impersonation to continue past this. */
const IMPERSONATION_SESSION_TTL_MINUTES = 30;

/** Far-future lock = locked until an administrator unlocks the account. */
const PERMANENT_LOCK = new Date('9999-12-31T00:00:00Z');

/** Lockout ladder: 5 failures -> 15 min, 10 -> 1 h, 20+ -> until an administrator unlocks it. */
export function lockUntilFor(failures: number, now = Date.now()): Date | null {
  if (failures >= 20) return PERMANENT_LOCK;
  if (failures >= 10) return new Date(now + 60 * 60 * 1000);
  if (failures >= 5) return new Date(now + 15 * 60 * 1000);
  return null;
}

export interface AdminRequestContext {
  ip?: string;
  userAgent?: string;
  deviceId?: string;
}

export interface AdminLoginResult {
  status: 'ok';
  token: string;
  accessTokenExpiresIn: number;
  /** Delivered to the browser only as an httpOnly cookie by AuthController — never in the JSON body. */
  refreshToken: string;
  refreshExpiresAt: Date;
  admin: { username: string; fullName: string; role: string; operatorId: string | null };
}

/** Password verified, but this account has TOTP enabled — sign in again via /auth/admin/2fa/login with a code. */
export interface AdminTwoFactorChallenge {
  status: 'twofa_required';
  challengeToken: string;
}

/** No refresh token on purpose — see IMPERSONATION_SESSION_TTL_MINUTES. */
export interface ImpersonationResult {
  status: 'ok';
  token: string;
  accessTokenExpiresIn: number;
  impersonating: true;
  admin: { username: string; fullName: string; role: string; operatorId: string | null };
}

const TWOFA_CHALLENGE_TTL = '5m';
const TOTP_ISSUER = 'YENA Bingo';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly wallet: WalletService,
    private readonly settings: SettingsService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly referrals: ReferralsService,
    private readonly bonus: BonusService,
    private readonly theme: ThemeService,
    private readonly operators: OperatorsService,
    private readonly passwords: PasswordService,
    private readonly loginHistory: LoginHistoryService,
    private readonly notifications: NotificationsService,
  ) {}

  // -------------------------------------------------------------------
  // Player (Telegram) auth
  // -------------------------------------------------------------------

  async telegramLogin(dto: TelegramLoginDto, ctx?: AdminRequestContext) {
    // The operator is fixed by the URL the Mini App was opened from, and
    // initData must be signed by THAT operator's bot: a signature valid for
    // another operator's bot must not log anyone in here.
    const operator = await this.operators.resolveForPlayer(dto.operatorSlug);
    const operatorId = operator.id;
    let tgUser = dto.initData ? this.telegram.verifyInitData(dto.initData, this.operators.botToken(operator)) : null;

    if (!tgUser) {
      const devId = this.telegram.resolveDevUser(dto.devTelegramUserId);
      if (devId) {
        tgUser = { id: devId, first_name: 'Dev', username: `dev_${devId}` };
      }
    }

    if (!tgUser) throw new UnauthorizedException('Invalid or expired Telegram session');

    // A referral-code collision inside the transaction aborts that Postgres
    // transaction outright (any error does, not just this one) — so a fresh
    // code can't be retried from inside the same $transaction callback.
    // Instead the whole (fast, single-row) transaction is retried with a new
    // code. At 32^6 combinations a collision is already astronomically
    // unlikely; a genuine telegramUserId race (two concurrent first logins
    // for the same brand-new user) self-heals on retry too, since the second
    // attempt's findUnique now finds the row the first attempt just committed.
    const MAX_ATTEMPTS = 10;
    let result: { user: Awaited<ReturnType<typeof this.prisma.telegramUser.findUniqueOrThrow>>; isNew: boolean } | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        result = await this.prisma.$transaction(async (tx) => {
          await setTenantOnTx(tx, operatorId);
          const existing = await tx.telegramUser.findUnique({
            where: { operatorId_telegramUserId: { operatorId, telegramUserId: BigInt(tgUser!.id) } },
          });
          if (existing) return { user: existing, isNew: false };

          const created = await tx.telegramUser.create({
            data: {
              operatorId,
              telegramUserId: BigInt(tgUser!.id),
              username: tgUser!.username,
              firstName: tgUser!.first_name,
              lastName: tgUser!.last_name,
              languageCode: tgUser!.language_code ?? 'am',
              referralCode: generateReferralCode(),
              // Sybil/bonus-farming defense fingerprint — captured once,
              // here, at the only moment a new account is actually created.
              // See BonusService.exceedsFingerprintCap.
              signupIp: ctx?.ip ?? null,
              signupDeviceId: ctx?.deviceId ?? null,
            },
          });
          return { user: created, isNew: true };
        });
        break;
      } catch (e: unknown) {
        const isUniqueViolation = e instanceof Object && 'code' in e && (e as { code: string }).code === 'P2002';
        if (!isUniqueViolation || attempt === MAX_ATTEMPTS - 1) throw e;
      }
    }
    const { user, isNew } = result!;

    if (user.status !== 'active') {
      throw new ForbiddenException(user.status === 'banned' ? 'This account has been banned' : 'This account has been suspended');
    }

    if (isNew) {
      await this.grantSignupBonus(user.id, operatorId);
      await this.referrals.recordReferral(user.id, operatorId, dto.referralCode);
    }
    await this.loginHistory.record({ principalType: 'player', principalId: user.id, operatorId, success: true, ipAddress: ctx?.ip, userAgent: ctx?.userAgent });

    return this.issuePlayerTokens(user.id, user.telegramUserId.toString());
  }

  /**
   * Grants the one-time signup bonus (spec §26/§27), admin-configurable via
   * WELCOME_BONUS_ENABLED / SIGNUP_BONUS_ETB / SIGNUP_BONUS_WAGERING_MULTIPLIER
   * (see AdminBonusSettingsController). Duplicate-abuse defence is the
   * BonusGrant.(telegramUserId, reason) unique constraint, enforced inside
   * BonusService.grant — a race here (two concurrent first logins) is a
   * silent no-op rather than a 500.
   */
  private async grantSignupBonus(telegramUserId: string, operatorId: string): Promise<void> {
    const [enabled, amountRaw, multiplierRaw] = await Promise.all([
      this.settings.get('WELCOME_BONUS_ENABLED', operatorId),
      this.settings.get('SIGNUP_BONUS_ETB', operatorId),
      this.settings.get('SIGNUP_BONUS_WAGERING_MULTIPLIER', operatorId),
    ]);
    if ((enabled ?? 'true') === 'false') return;

    const amount = Number(amountRaw ?? 0);
    if (!amount || amount <= 0) return;

    const wageringMultiplier = Number(multiplierRaw ?? 1) || 1;

    await this.bonus.grant({
      telegramUserId,
      operatorId,
      reason: 'SIGNUP',
      amount,
      wageringMultiplier,
      actorType: 'system',
      auditAction: 'BONUS_GRANTED',
      relatedEntityType: 'bonus_grant',
      note: 'Signup bonus',
    });
  }

  /** `rotation` = continuing an existing refresh-token family (refresh); omitted = new login, new family. */
  private async issuePlayerTokens(userId: string, telegramUserId: string, rotation?: { familyId: string; previousId: string }) {
    const user = await this.prisma.telegramUser.findUniqueOrThrow({ where: { id: userId } });
    const operator = await this.operators.get(user.operatorId);
    this.operators.assertActive(operator); // also stops token refresh for a suspended operator

    const accessToken = this.jwt.sign(
      { sub: userId, tgid: telegramUserId, type: 'player_access' },
      { expiresIn: PLAYER_ACCESS_TTL },
    );

    const rawRefresh = crypto.randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + PLAYER_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
    const newId = crypto.randomUUID();
    await this.prisma.playerRefreshToken.create({
      data: { id: newId, telegramUserId: userId, tokenHash: hashToken(rawRefresh), expiresAt, familyId: rotation?.familyId ?? newId },
    });
    if (rotation) {
      await this.prisma.playerRefreshToken.update({ where: { id: rotation.previousId }, data: { replacedById: newId } });
    }

    const [wallet, config, contact, effectiveTheme] = await Promise.all([
      this.wallet.getWallet(userId),
      this.settings.getGameConfig(user.operatorId),
      this.settings.getContactInfo(user.operatorId),
      this.theme.getEffectiveTheme(userId),
    ]);
    const botUsername = this.operators.botUsername(operator);

    return {
      accessToken,
      refreshToken: rawRefresh,
      refreshExpiresAt: expiresAt,
      operator: { id: operator.id, slug: operator.slug, name: operator.name },
      user: {
        id: user.id,
        telegram_user_id: Number(user.telegramUserId),
        username: user.username,
        first_name: user.firstName,
        language_code: user.languageCode,
      },
      wallet,
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
        bot_username: botUsername,
        rooms: config.rooms.map((r) => ({ code: r.code, name: r.name, price: r.price, capacity: r.capacity, max_per_player: r.maxPerPlayer })),
      },
      contact,
      theme: {
        effective: effectiveTheme,
        selectedThemeId: user.selectedThemeId,
      },
    };
  }

  /**
   * Rotates a player refresh token. Tokens form a family (rotation chain):
   * presenting one that was already rotated means a copy leaked, so the
   * whole family is revoked and the player must sign in again (for a Mini App
   * player that re-login is silent — Telegram re-signs initData).
   */
  async refreshPlayerToken(rawRefresh: string | undefined) {
    if (!rawRefresh) throw new UnauthorizedException('Refresh token invalid or expired');
    const tokenHash = hashToken(rawRefresh);
    const record = await this.prisma.playerRefreshToken.findFirst({ where: { tokenHash } });
    if (!record) throw new UnauthorizedException('Refresh token invalid or expired');

    const familyId = record.familyId ?? record.id;
    if (record.revokedAt) {
      await this.prisma.playerRefreshToken.updateMany({
        where: { OR: [{ familyId }, { id: familyId }], revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(`Player refresh-token reuse detected — family ${familyId} revoked`);
      await this.loginHistory.record({ principalType: 'player', principalId: record.telegramUserId, success: false, failureReason: 'refresh_token_reuse' });
      throw new UnauthorizedException('Refresh token invalid or expired');
    }
    if (record.expiresAt < new Date()) throw new UnauthorizedException('Refresh token invalid or expired');

    // Claim the token atomically: of two concurrent refreshes with the same token, exactly one wins.
    const claimed = await this.prisma.playerRefreshToken.updateMany({
      where: { id: record.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count === 0) throw new UnauthorizedException('Refresh token invalid or expired');

    const user = await this.prisma.telegramUser.findUniqueOrThrow({ where: { id: record.telegramUserId } });
    return this.issuePlayerTokens(user.id, user.telegramUserId.toString(), { familyId, previousId: record.id });
  }

  async logoutPlayer(rawRefresh: string | undefined) {
    if (!rawRefresh) return { success: true };
    const tokenHash = hashToken(rawRefresh);
    await this.prisma.playerRefreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { success: true };
  }

  // -------------------------------------------------------------------
  // Admin auth
  // -------------------------------------------------------------------

  /**
   * Audit finding SEC-6 (Medium): concurrent bootstrap calls could create two
   * SUPER_ADMIN rows. Fixed two ways (defense-in-depth):
   *   1. `pg_advisory_xact_lock` serializes concurrent bootstrap attempts.
   *   2. A partial unique index (`uniq_single_super_admin`, migration
   *      20260920180113) makes a second SUPER_ADMIN row impossible.
   */
  async adminBootstrap(dto: AdminBootstrapDto, ctx: AdminRequestContext) {
    const expectedKey = this.config.get<string>('ADMIN_KEY') ?? '';
    if (!expectedKey || !constantTimeStringEquals(dto.adminKey, expectedKey)) {
      throw new UnauthorizedException('Invalid admin key');
    }

    const passwordHash = await this.passwords.hash(dto.password);
    const BOOTSTRAP_LOCK_KEY = 727310n; // arbitrary, fixed — this lock is only ever taken here

    const admin = await this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx, null);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`;

      const existingCount = await tx.adminUser.count();
      if (existingCount > 0) {
        throw new ForbiddenException('Owner account already exists — bootstrap is a one-time action');
      }

      return tx.adminUser.create({
        data: {
          username: dto.username,
          passwordHash,
          passwordChangedAt: new Date(),
          fullName: dto.fullName,
          role: 'SUPER_ADMIN',
        },
      });
    });

    await this.audit.log({
      actorType: 'system',
      action: 'ADMIN_CREATED',
      entityType: 'admin_user',
      entityId: admin.id,
      newState: { username: admin.username, role: 'SUPER_ADMIN' },
      reason: 'Owner bootstrap',
      ipAddress: ctx.ip,
    });

    return this.adminLogin({ username: dto.username, password: dto.password }, ctx);
  }

  /**
   * Admin login with account lockout and a full login history.
   *
   * Timing: an unknown username still runs one password verification (against
   * a dummy hash) so response time doesn't reveal which usernames exist.
   * Lockout: a locked account never reaches password verification, so
   * guessing can't continue during the lock.
   */
  async adminLogin(dto: AdminLoginDto, ctx: AdminRequestContext): Promise<AdminLoginResult | AdminTwoFactorChallenge> {
    const base = { principalType: 'admin' as const, attemptedUsername: dto.username, ipAddress: ctx.ip, userAgent: ctx.userAgent, deviceId: ctx.deviceId };
    const admin = await this.prisma.adminUser.findUnique({ where: { username: dto.username }, include: { operator: { select: { status: true } } } });

    if (!admin) {
      await this.passwords.verify(await this.dummyHash(), dto.password);
      await this.loginHistory.record({ ...base, success: false, failureReason: 'unknown_username' });
      await this.logFailedLogin(dto.username, 'unknown_username', ctx.ip);
      throw new UnauthorizedException('Invalid credentials');
    }
    const who = { ...base, principalId: admin.id, operatorId: admin.operatorId };

    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      await this.loginHistory.record({ ...who, success: false, failureReason: 'locked' });
      throw new ForbiddenException(
        admin.lockedUntil.getTime() >= PERMANENT_LOCK.getTime()
          ? 'This account is locked after repeated failed logins. Ask an administrator to unlock it.'
          : `Too many failed logins. Try again after ${admin.lockedUntil.toISOString()}.`,
      );
    }

    if (!(await this.passwords.verify(admin.passwordHash, dto.password))) {
      await this.recordFailedLoginAndMaybeLock(admin, 'wrong_password', ctx, who);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (admin.status !== 'active') {
      await this.loginHistory.record({ ...who, success: false, failureReason: 'inactive_account' });
      await this.logFailedLogin(dto.username, 'inactive_account', ctx.ip, admin.id);
      throw new ForbiddenException('Admin account is not active');
    }
    if (admin.operator && admin.operator.status !== 'active') {
      await this.loginHistory.record({ ...who, success: false, failureReason: 'operator_inactive' });
      throw new ForbiddenException('This operator is suspended');
    }

    // Password is correct: clear the failure streak and upgrade a legacy bcrypt hash to argon2id,
    // independent of whether a second factor is still needed below.
    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        ...(this.passwords.needsRehash(admin.passwordHash) ? { passwordHash: await this.passwords.hash(dto.password) } : {}),
      },
    });

    return this.completeAdminLogin(admin, ctx, who);
  }

  /**
   * Finishes a login that either never needed a second factor, or just
   * passed one — creates the session, issues tokens, and records the
   * success. Not called until the account is fully authenticated.
   */
  private async completeAdminLogin(
    admin: { id: string; username: string; fullName: string; role: string; operatorId: string | null },
    ctx: AdminRequestContext,
    who: { principalType: 'admin'; attemptedUsername: string; ipAddress?: string; userAgent?: string; deviceId?: string; principalId: string; operatorId: string | null },
  ): Promise<AdminLoginResult> {
    await this.prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });

    const session = await this.prisma.adminSession.create({
      data: {
        adminId: admin.id,
        tokenHash: '',
        expiresAt: new Date(Date.now() + ADMIN_SESSION_TTL_HOURS * 60 * 60 * 1000),
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
        deviceId: ctx.deviceId,
      },
    });
    const accessToken = this.signAdminAccess(admin.id, session.id);
    await this.prisma.adminSession.update({ where: { id: session.id }, data: { tokenHash: hashToken(accessToken) } });
    const refresh = await this.issueAdminRefresh(admin.id, session.id, session.expiresAt);

    await this.loginHistory.record({ ...who, success: true });
    await this.audit.log({
      actorType: 'admin',
      adminId: admin.id,
      operatorId: admin.operatorId,
      action: 'ADMIN_LOGIN',
      entityType: 'admin_user',
      entityId: admin.id,
      ipAddress: ctx.ip,
      actorRole: admin.role,
    });

    return {
      status: 'ok',
      token: accessToken,
      accessTokenExpiresIn: ADMIN_ACCESS_TTL_SECONDS,
      refreshToken: refresh.raw,
      refreshExpiresAt: refresh.expiresAt,
      admin: { username: admin.username, fullName: admin.fullName, role: admin.role, operatorId: admin.operatorId },
    };
  }

  /** Shared by a wrong password and a wrong TOTP code — both count toward the same lockout ladder. */
  private async recordFailedLoginAndMaybeLock(
    admin: { id: string; username: string; operatorId: string | null; failedLoginCount: number },
    reason: string,
    ctx: AdminRequestContext,
    who: Omit<LoginAttempt, 'success' | 'failureReason'>,
  ): Promise<void> {
    const failures = admin.failedLoginCount + 1;
    const lockedUntil = lockUntilFor(failures);
    await this.prisma.adminUser.update({ where: { id: admin.id }, data: { failedLoginCount: failures, lockedUntil } });
    await this.loginHistory.record({ ...who, success: false, failureReason: reason });
    await this.logFailedLogin(admin.username, reason, ctx.ip, admin.id);
    if (lockedUntil) {
      this.logger.warn(`Admin ${admin.username} locked until ${lockedUntil.toISOString()} after ${failures} failed logins`);
      await this.audit.log({
        actorType: 'system',
        adminId: admin.id,
        operatorId: admin.operatorId,
        action: 'ADMIN_ACCOUNT_LOCKED',
        entityType: 'admin_user',
        entityId: admin.id,
        newState: { failedLoginCount: failures, lockedUntil },
        ipAddress: ctx.ip,
      });
      const alert = {
        type: 'ADMIN_ACCOUNT_LOCKED',
        severity: 'warning' as const,
        title: `Admin account locked: ${admin.username}`,
        body: `${failures} failed logins in a row (last from ${ctx.ip ?? 'unknown IP'})`,
        relatedEntityType: 'admin',
        relatedEntityId: admin.id,
      };
      await this.notifications.notifyPlatform({ ...alert, operatorId: admin.operatorId });
      if (admin.operatorId) await this.notifications.notifyOperator(admin.operatorId, alert);
    }
  }

  /** Step 2 of a 2FA login: exchanges the short-lived challenge from adminLogin() for a real session. */
  async completeAdminTwoFactorLogin(challengeToken: string, code: string, ctx: AdminRequestContext): Promise<AdminLoginResult> {
    let payload: { sub: string; type: string };
    try {
      payload = this.jwt.verify(challengeToken);
    } catch {
      throw new UnauthorizedException('This sign-in attempt expired — start again');
    }
    if (payload.type !== 'admin_2fa_challenge') throw new UnauthorizedException('Invalid challenge');

    const admin = await this.prisma.adminUser.findUnique({ where: { id: payload.sub }, include: { operator: { select: { status: true } } } });
    if (!admin || !admin.totpEnabled || !admin.totpSecretEncrypted) throw new UnauthorizedException('Invalid challenge');

    const who = { principalType: 'admin' as const, attemptedUsername: admin.username, principalId: admin.id, operatorId: admin.operatorId, ipAddress: ctx.ip, userAgent: ctx.userAgent, deviceId: ctx.deviceId };

    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      await this.loginHistory.record({ ...who, success: false, failureReason: 'locked' });
      throw new ForbiddenException('This account is now locked — start again');
    }
    if (admin.status !== 'active') throw new ForbiddenException('Admin account is not active');
    if (admin.operator && admin.operator.status !== 'active') throw new ForbiddenException('This operator is suspended');

    const secret = decryptSecret(admin.totpSecretEncrypted, this.encryptionKey());
    const counter = verifyTotp(secret, code, Date.now(), admin.totpLastUsedCounter);
    if (counter == null) {
      await this.recordFailedLoginAndMaybeLock(admin, 'bad_totp_code', ctx, who);
      throw new UnauthorizedException('Invalid code');
    }
    await this.prisma.adminUser.update({ where: { id: admin.id }, data: { totpLastUsedCounter: counter } });

    return this.completeAdminLogin(admin, ctx, who);
  }

  /** Step 2 alternative: exchanges the same 2FA challenge for a session using a one-time recovery code instead of a TOTP code — for a lost/inaccessible authenticator app. */
  async completeAdminRecoveryLogin(challengeToken: string, recoveryCode: string, ctx: AdminRequestContext): Promise<AdminLoginResult> {
    let payload: { sub: string; type: string };
    try {
      payload = this.jwt.verify(challengeToken);
    } catch {
      throw new UnauthorizedException('This sign-in attempt expired — start again');
    }
    if (payload.type !== 'admin_2fa_challenge') throw new UnauthorizedException('Invalid challenge');

    const admin = await this.prisma.adminUser.findUnique({ where: { id: payload.sub }, include: { operator: { select: { status: true } } } });
    if (!admin || !admin.totpEnabled) throw new UnauthorizedException('Invalid challenge');

    const who = { principalType: 'admin' as const, attemptedUsername: admin.username, principalId: admin.id, operatorId: admin.operatorId, ipAddress: ctx.ip, userAgent: ctx.userAgent, deviceId: ctx.deviceId };

    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      await this.loginHistory.record({ ...who, success: false, failureReason: 'locked' });
      throw new ForbiddenException('This account is now locked — start again');
    }
    if (admin.status !== 'active') throw new ForbiddenException('Admin account is not active');
    if (admin.operator && admin.operator.status !== 'active') throw new ForbiddenException('This operator is suspended');

    // Atomic claim: only succeeds if the code exists AND is still unused — an
    // already-used or forged code can never be consumed twice, even under a
    // concurrent double-submit (same idempotent-update pattern as deposits/
    // withdrawals/approvals elsewhere in this codebase).
    const codeHash = hashToken(normalizeRecoveryCode(recoveryCode));
    const claim = await this.prisma.adminRecoveryCode.updateMany({
      where: { adminId: admin.id, codeHash, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claim.count === 0) {
      await this.recordFailedLoginAndMaybeLock(admin, 'bad_recovery_code', ctx, who);
      throw new UnauthorizedException('Invalid or already-used recovery code');
    }

    const remaining = await this.prisma.adminRecoveryCode.count({ where: { adminId: admin.id, usedAt: null } });
    await this.audit.log({
      actorType: 'admin',
      adminId: admin.id,
      operatorId: admin.operatorId,
      action: 'ADMIN_RECOVERY_CODE_USED',
      entityType: 'admin_user',
      entityId: admin.id,
      newState: { remaining },
      ipAddress: ctx.ip,
    });
    if (remaining <= 2) {
      const alert = {
        type: 'RECOVERY_CODES_LOW',
        severity: 'warning' as const,
        title: `${admin.username} is running low on 2FA recovery codes`,
        body: `${remaining} unused recovery code(s) left after a login. Generate a new set from security settings.`,
        relatedEntityType: 'admin',
        relatedEntityId: admin.id,
      };
      await this.notifications.notifyPlatform({ ...alert, operatorId: admin.operatorId });
      if (admin.operatorId) await this.notifications.notifyOperator(admin.operatorId, alert);
    }

    return this.completeAdminLogin(admin, ctx, who);
  }

  private encryptionKey(): string {
    const key = this.config.get<string>('PLATFORM_ENCRYPTION_KEY');
    if (!key) throw new InternalServerErrorException('PLATFORM_ENCRYPTION_KEY is not configured on the server — ask the platform owner');
    return key;
  }

  /** Starts (or restarts) 2FA enrollment: a new secret, not yet active until confirmTotp() proves possession. */
  async setupTotp(adminId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    const secret = generateTotpSecret();
    await this.prisma.adminUser.update({ where: { id: adminId }, data: { totpSecretEncrypted: encryptSecret(secret, this.encryptionKey()) } });
    return { secret, otpauthUrl: totpAuthUrl(secret, admin.username, TOTP_ISSUER) };
  }

  /** Proves possession of the authenticator app and turns 2FA on. Issues a fresh set of recovery codes, shown to the admin exactly once — only their hash is ever stored (see issueRecoveryCodes). */
  async confirmTotp(adminId: string, code: string): Promise<{ success: true; recoveryCodes: string[] }> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    if (!admin.totpSecretEncrypted) throw new BadRequestException('Start setup first (POST /auth/admin/2fa/setup)');
    const secret = decryptSecret(admin.totpSecretEncrypted, this.encryptionKey());
    const counter = verifyTotp(secret, code, Date.now(), admin.totpLastUsedCounter);
    if (counter == null) throw new BadRequestException('That code is incorrect or expired — try the current one from your app');
    await this.prisma.adminUser.update({ where: { id: adminId }, data: { totpEnabled: true, totpVerifiedAt: new Date(), totpLastUsedCounter: counter } });
    await this.audit.log({ actorType: 'admin', adminId, action: 'ADMIN_2FA_ENABLED', entityType: 'admin_user', entityId: adminId });
    const recoveryCodes = await this.issueRecoveryCodes(adminId);
    return { success: true, recoveryCodes };
  }

  /** Self-service disable — requires the current password as a higher bar for removing a security control. Recovery codes from this enrollment are meaningless without 2FA, so they're cleared too. */
  async disableTotp(adminId: string, password: string): Promise<{ success: true }> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    if (!(await this.passwords.verify(admin.passwordHash, password))) throw new UnauthorizedException('Incorrect password');
    await this.prisma.adminUser.update({ where: { id: adminId }, data: { totpEnabled: false, totpSecretEncrypted: null, totpVerifiedAt: null, totpLastUsedCounter: null } });
    await this.prisma.adminRecoveryCode.deleteMany({ where: { adminId } });
    await this.audit.log({ actorType: 'admin', adminId, action: 'ADMIN_2FA_DISABLED', entityType: 'admin_user', entityId: adminId });
    return { success: true };
  }

  /** Self-service: invalidates every unused code from the current batch and issues a new one — for a lost/exhausted set. Requires the current password, matching disableTotp's bar for a security-control change. */
  async regenerateRecoveryCodes(adminId: string, password: string): Promise<{ recoveryCodes: string[] }> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    if (!admin.totpEnabled) throw new BadRequestException('2FA is not enabled on this account');
    if (!(await this.passwords.verify(admin.passwordHash, password))) throw new UnauthorizedException('Incorrect password');
    const recoveryCodes = await this.issueRecoveryCodes(adminId);
    await this.audit.log({ actorType: 'admin', adminId, action: 'ADMIN_RECOVERY_CODES_REGENERATED', entityType: 'admin_user', entityId: adminId, newState: { count: recoveryCodes.length } });
    return { recoveryCodes };
  }

  /** Replaces the admin's whole recovery-code batch. Deleting first (rather than leaving old rows) means a batch from a previous enrollment/regeneration can never be replayed after a new one is issued. */
  private async issueRecoveryCodes(adminId: string): Promise<string[]> {
    const codes = generateRecoveryCodes();
    await this.prisma.adminRecoveryCode.deleteMany({ where: { adminId } });
    await this.prisma.adminRecoveryCode.createMany({
      data: codes.map((code) => ({ adminId, codeHash: hashToken(normalizeRecoveryCode(code)) })),
    });
    return codes;
  }

  /** Self-service opt-in/out for pushing warning/critical notifications to this admin's own Telegram chat, on top of the in-app feed. */
  async setTelegramAlertChat(adminId: string, chatId: string | null | undefined): Promise<{ success: true }> {
    const value = chatId?.trim() || null;
    await this.prisma.adminUser.update({ where: { id: adminId }, data: { telegramAlertChatId: value } });
    await this.audit.log({ actorType: 'admin', adminId, action: value ? 'ADMIN_TELEGRAM_ALERTS_ENABLED' : 'ADMIN_TELEGRAM_ALERTS_DISABLED', entityType: 'admin_user', entityId: adminId });
    return { success: true };
  }

  /**
   * Rotates the admin refresh token (httpOnly cookie) and issues a new access
   * token for the same session. A token that was already rotated means a copy
   * leaked: the whole session is revoked.
   */
  async refreshAdminSession(rawRefresh: string | undefined, ctx: AdminRequestContext) {
    if (!rawRefresh) throw new UnauthorizedException('Session expired');
    const record = await this.prisma.adminRefreshToken.findFirst({
      where: { tokenHash: hashToken(rawRefresh) },
      include: { session: true, admin: { include: { operator: { select: { status: true } } } } },
    });
    if (!record) throw new UnauthorizedException('Session expired');

    if (record.revokedAt) {
      await this.revokeAdminSession(record.sessionId);
      this.logger.warn(`Admin refresh-token reuse detected — session ${record.sessionId} of ${record.admin.username} revoked`);
      await this.loginHistory.record({
        principalType: 'admin',
        principalId: record.adminId,
        operatorId: record.admin.operatorId,
        attemptedUsername: record.admin.username,
        success: false,
        failureReason: 'refresh_token_reuse',
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
        deviceId: ctx.deviceId,
      });
      await this.audit.log({
        actorType: 'system',
        adminId: record.adminId,
        operatorId: record.admin.operatorId,
        action: 'ADMIN_REFRESH_TOKEN_REUSE',
        entityType: 'admin_session',
        entityId: record.sessionId,
        ipAddress: ctx.ip,
      });
      await this.notifications.notifyPlatform({
        type: 'SUSPICIOUS_ACTIVITY',
        severity: 'critical',
        title: `Possible stolen admin session: ${record.admin.username}`,
        body: `An already-used refresh token was presented (from ${ctx.ip ?? 'unknown IP'}); the session was revoked.`,
        operatorId: record.admin.operatorId,
        relatedEntityType: 'admin',
        relatedEntityId: record.adminId,
      });
      throw new UnauthorizedException('Session expired');
    }

    const now = new Date();
    const { session, admin } = record;
    if (record.expiresAt < now || session.revokedAt || session.expiresAt < now) throw new UnauthorizedException('Session expired');
    if (admin.status !== 'active' || (admin.lockedUntil && admin.lockedUntil > now)) throw new UnauthorizedException('Session expired');
    if (admin.operator && admin.operator.status !== 'active') throw new UnauthorizedException('This operator is suspended');

    const claimed = await this.prisma.adminRefreshToken.updateMany({ where: { id: record.id, revokedAt: null }, data: { revokedAt: now } });
    if (claimed.count === 0) throw new UnauthorizedException('Session expired');

    const refresh = await this.issueAdminRefresh(admin.id, session.id, session.expiresAt);
    await this.prisma.adminRefreshToken.update({ where: { id: record.id }, data: { replacedById: refresh.id } });
    const accessToken = this.signAdminAccess(admin.id, session.id);

    return {
      token: accessToken,
      accessTokenExpiresIn: ADMIN_ACCESS_TTL_SECONDS,
      refreshToken: refresh.raw,
      refreshExpiresAt: refresh.expiresAt,
    };
  }

  private signAdminAccess(adminId: string, sessionId: string): string {
    return this.jwt.sign({ sub: adminId, sid: sessionId, type: 'admin_access' }, { expiresIn: ADMIN_ACCESS_TTL_SECONDS });
  }

  /** Idle timeout: a refresh token lives ADMIN_REFRESH_IDLE_MINUTES, never past the session's absolute expiry. */
  private async issueAdminRefresh(adminId: string, sessionId: string, sessionExpiresAt: Date) {
    const raw = crypto.randomBytes(48).toString('hex');
    const expiresAt = new Date(Math.min(Date.now() + ADMIN_REFRESH_IDLE_MINUTES * 60 * 1000, sessionExpiresAt.getTime()));
    const row = await this.prisma.adminRefreshToken.create({
      data: { adminId, sessionId, tokenHash: hashToken(raw), expiresAt },
    });
    return { id: row.id, raw, expiresAt };
  }

  private async revokeAdminSession(sessionId: string) {
    const now = new Date();
    await this.prisma.adminSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } });
    await this.prisma.adminRefreshToken.updateMany({ where: { sessionId, revokedAt: null }, data: { revokedAt: now } });
  }

  private dummyHashPromise: Promise<string> | null = null;
  private dummyHash(): Promise<string> {
    this.dummyHashPromise ??= this.passwords.hash(crypto.randomBytes(16).toString('hex'));
    return this.dummyHashPromise;
  }

  private async logFailedLogin(attemptedUsername: string, reason: string, ip?: string, adminId?: string): Promise<void> {
    await this.audit.log({
      actorType: 'system',
      adminId,
      action: 'ADMIN_LOGIN_FAILED',
      entityType: 'admin_user',
      entityId: adminId,
      newState: { attempted_username: attemptedUsername, reason },
      ipAddress: ip,
    });
  }

  async adminLogout(sessionId: string, adminId: string, operatorId: string | null) {
    await this.revokeAdminSession(sessionId);
    await this.audit.log({ actorType: 'admin', adminId, operatorId, action: 'ADMIN_LOGOUT', entityType: 'admin_user', entityId: adminId });
    return { success: true };
  }

  /**
   * Super Admin "view as": issues a session for the target account, tagged
   * with the real actor. Deliberately no refresh token — this session just
   * expires on its own short TTL rather than rotating forever, so a
   * forgotten open impersonation tab doesn't stay valid indefinitely.
   */
  async startImpersonation(actingSuperAdminId: string, targetAdminId: string, reason: string | undefined, ctx: AdminRequestContext): Promise<ImpersonationResult> {
    if (actingSuperAdminId === targetAdminId) throw new ForbiddenException('You are already signed in as yourself');
    const target = await this.prisma.adminUser.findUnique({ where: { id: targetAdminId } });
    if (!target) throw new BadRequestException('Admin not found');
    if (target.role === 'SUPER_ADMIN') throw new ForbiddenException('The Super Admin account cannot be impersonated');
    if (target.status !== 'active') throw new ForbiddenException('This account is not active');

    const expiresAt = new Date(Date.now() + IMPERSONATION_SESSION_TTL_MINUTES * 60 * 1000);
    const session = await this.prisma.adminSession.create({
      data: {
        adminId: target.id,
        tokenHash: '',
        expiresAt,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
        deviceId: ctx.deviceId,
        impersonatedByAdminId: actingSuperAdminId,
        impersonationReason: reason?.trim() || null,
      },
    });
    const accessToken = this.signAdminAccess(target.id, session.id);
    await this.prisma.adminSession.update({ where: { id: session.id }, data: { tokenHash: hashToken(accessToken) } });

    await this.audit.log({
      actorType: 'admin',
      adminId: actingSuperAdminId,
      operatorId: target.operatorId,
      action: 'IMPERSONATION_STARTED',
      entityType: 'admin_user',
      entityId: target.id,
      newState: { targetUsername: target.username, reason: reason ?? null, expiresAt },
      ipAddress: ctx.ip,
      // adminId above is already the real actor (this call runs on the Super
      // Admin's own, not-yet-impersonating session) — an explicit null keeps
      // this row's actor/target pair exactly as written, rather than
      // inheriting whatever the ambient request context happens to carry.
      impersonatedByAdminId: null,
    });
    const alert = {
      type: 'IMPERSONATION_STARTED',
      severity: 'warning' as const,
      title: `A Super Admin is now viewing as ${target.username}`,
      body: reason ? `Reason: ${reason}` : undefined,
      relatedEntityType: 'admin',
      relatedEntityId: target.id,
    };
    await this.notifications.notifyPlatform({ ...alert, operatorId: target.operatorId });
    if (target.operatorId) await this.notifications.notifyOperator(target.operatorId, alert);

    return {
      status: 'ok',
      token: accessToken,
      accessTokenExpiresIn: Math.min(ADMIN_ACCESS_TTL_SECONDS, IMPERSONATION_SESSION_TTL_MINUTES * 60),
      impersonating: true,
      admin: { username: target.username, fullName: target.fullName, role: target.role, operatorId: target.operatorId },
    };
  }

  /** Ends the current impersonation session — called by the impersonated session on itself, not by the original Super Admin session. */
  async endImpersonation(admin: RequestAdmin, ctx: AdminRequestContext): Promise<{ success: true }> {
    if (!admin.impersonatedByAdminId) throw new BadRequestException('This session is not an impersonation');
    await this.revokeAdminSession(admin.sessionId);
    await this.audit.log({
      actorType: 'admin',
      adminId: admin.impersonatedByAdminId,
      operatorId: admin.operatorId,
      action: 'IMPERSONATION_ENDED',
      entityType: 'admin_user',
      entityId: admin.adminId,
      ipAddress: ctx.ip,
      // adminId above is already the real actor, deliberately — see the same
      // note on IMPERSONATION_STARTED.
      impersonatedByAdminId: null,
    });
    const alert = {
      type: 'IMPERSONATION_ENDED',
      severity: 'info' as const,
      title: `Impersonation of ${admin.username} ended`,
      relatedEntityType: 'admin',
      relatedEntityId: admin.adminId,
    };
    await this.notifications.notifyPlatform({ ...alert, operatorId: admin.operatorId });
    if (admin.operatorId) await this.notifications.notifyOperator(admin.operatorId, alert);
    return { success: true };
  }

  /**
   * Audit finding DB-2 (Medium): PlayerRefreshToken rows were never purged —
   * every login/refresh/logout leaves a permanent row (revoked or not),
   * meaning the table only grows. Combined with the missing tokenHash index
   * (fixed in the same migration this comment references), lookups got
   * slower over time with no ceiling. Runs daily; deletes rows that are
   * long-expired OR were revoked well in the past — keeping recently-revoked
   * rows briefly is deliberate (useful for a "was this token ever valid"
   * investigation shortly after an incident).
   */
  /**
   * Phase 8b — first-login password change for operator owners who received a
   * generated temporary password. Requires the admin to present their CURRENT
   * (temporary) password to prevent a session-hijacking window; clears
   * mustChangePassword on success and invalidates the old password hash by
   * updating it in the same write. The JwtAdminStrategy short-circuit only
   * applies while the flag is true — after this call the admin may use any
   * route normally.
   *
   * NOTE: this method is called via a SEPARATE controller route that bypasses
   * the must_change_password guard (see auth.controller.ts). Every other admin
   * route rejects the session until this completes.
   */
  async changeAdminPassword(adminId: string, sessionId: string, currentPassword: string, newPassword: string): Promise<{ success: true }> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new UnauthorizedException('Admin not found');
    const valid = await this.passwords.verify(admin.passwordHash, currentPassword);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');
    if (currentPassword === newPassword) throw new BadRequestException('New password must differ from the current password');

    const hash = await this.passwords.hash(newPassword);
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { passwordHash: hash, mustChangePassword: false, passwordChangedAt: new Date() },
    });
    // Invalidate all sessions so the admin logs in fresh with the new password.
    await this.prisma.adminSession.updateMany({ where: { adminId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.prisma.adminRefreshToken.updateMany({ where: { adminId, revokedAt: null }, data: { revokedAt: new Date() } });

    await this.audit.log({
      actorType: 'admin',
      adminId,
      operatorId: admin.operatorId,
      action: 'ADMIN_PASSWORD_CHANGED',
      entityType: 'admin',
      entityId: adminId,
    });
    return { success: true };
  }

  @Cron('0 3 * * *') // once daily at 03:00 — this is bulk hygiene, not time-sensitive
  async cleanupExpiredRefreshTokens(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days past expiry/revocation
    try {
      const result = await this.prisma.playerRefreshToken.deleteMany({
        where: {
          OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
        },
      });
      if (result.count > 0) this.logger.log(`cleanupExpiredRefreshTokens: removed ${result.count} stale row(s)`);
    } catch (e) {
      this.logger.error('cleanupExpiredRefreshTokens failed', e instanceof Error ? e.stack : String(e));
    }
  }
}

import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Ip, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response, CookieOptions } from 'express';
import { AuthService, type AdminRequestContext, type AdminLoginResult } from './auth.service';
import {
  TelegramLoginDto,
  AdminBootstrapDto,
  AdminLoginDto,
  AdminTwoFactorLoginDto,
  ConfirmTotpDto,
  DisableTotpDto,
  SetTelegramAlertDto,
  AdminRecoveryLoginDto,
  RegenerateRecoveryCodesDto,
  ChangeAdminPasswordDto,
} from './dto/auth.dto';
import { Public } from '../common/decorators/public.decorator';
import { JwtAdminGuard } from '../common/guards/jwt-admin.guard';
import { CurrentAdmin, RequestAdmin } from '../common/decorators/current-user.decorator';

/**
 * The module-level default (120 req/min, see app.module.ts) is far too
 * permissive for credential-guessing surfaces specifically. Password login and
 * the one-time owner bootstrap key are brute-forceable (a human-chosen secret
 * checked against user input) and get a tight, dedicated limit — on top of the
 * per-account lockout in AuthService.adminLogin.
 */
const AUTH_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

/**
 * telegramLogin's payload is Telegram's own HMAC-signed initData, not a
 * human-guessable secret; it fires on every normal app open, so it gets a
 * looser limit than password login.
 */
const PLAYER_LOGIN_THROTTLE = { default: { limit: 30, ttl: 60_000 } };

/** Audit finding SEC-7 (Medium): a refresh-token brute-force/replay surface deserves a tighter limit than the global default. */
const REFRESH_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

/**
 * The admin refresh token lives only in this httpOnly cookie: page JavaScript
 * (and therefore an XSS payload) can never read it. Path-scoped to the admin
 * auth routes, so it isn't sent with any other request.
 */
const ADMIN_REFRESH_COOKIE = 'yena_admin_rt';
const ADMIN_REFRESH_COOKIE_PATH = '/api/auth/admin';

function refreshCookieOptions(expiresAt?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: ADMIN_REFRESH_COOKIE_PATH,
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

/**
 * Same httpOnly-cookie pattern as the admin refresh token, extended to
 * players (Production Readiness Audit — High: the player refresh token was
 * the one credential still in localStorage, readable by any future XSS, on
 * the side of the app that actually moves money). Scoped to `/api/auth`
 * (not just `/api/auth/refresh`) so it's also sent to `/api/auth/logout`.
 */
const PLAYER_REFRESH_COOKIE = 'yena_player_rt';
const PLAYER_REFRESH_COOKIE_PATH = '/api/auth';

function playerRefreshCookieOptions(expiresAt?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: PLAYER_REFRESH_COOKIE_PATH,
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

function requestContext(req: Request, ip: string, deviceId?: string): AdminRequestContext {
  return {
    ip,
    userAgent: req.headers['user-agent'],
    deviceId: deviceId && /^[A-Za-z0-9-]{8,64}$/.test(deviceId) ? deviceId : undefined,
  };
}

/** True once a login result has cleared any second factor and is ready to become a real session. */
function isCompleteLogin(result: AdminLoginResult | { status: 'twofa_required'; challengeToken: string }): result is AdminLoginResult {
  return result.status === 'ok';
}

/** An impersonation session cannot change the impersonated account's own security settings. */
function assertNotImpersonating(admin: RequestAdmin): void {
  if (admin.impersonatedByAdminId) throw new ForbiddenException("Can't change security settings for an account while viewing as it");
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle(PLAYER_LOGIN_THROTTLE)
  @Post('telegram')
  async telegramLogin(
    @Body() dto: TelegramLoginDto,
    @Ip() ip: string,
    @Req() req: Request,
    @Headers('x-device-id') deviceId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { refreshToken, refreshExpiresAt, ...body } = await this.auth.telegramLogin(dto, requestContext(req, ip, deviceId));
    res.cookie(PLAYER_REFRESH_COOKIE, refreshToken, playerRefreshCookieOptions(refreshExpiresAt));
    return body;
  }

  @Public()
  @Throttle(REFRESH_THROTTLE)
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = (req.cookies as Record<string, string> | undefined)?.[PLAYER_REFRESH_COOKIE];
    try {
      const { refreshToken, refreshExpiresAt, ...body } = await this.auth.refreshPlayerToken(raw);
      res.cookie(PLAYER_REFRESH_COOKIE, refreshToken, playerRefreshCookieOptions(refreshExpiresAt));
      return body;
    } catch (e) {
      res.clearCookie(PLAYER_REFRESH_COOKIE, playerRefreshCookieOptions());
      throw e;
    }
  }

  @Public()
  @Throttle(REFRESH_THROTTLE)
  @Post('logout')
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = (req.cookies as Record<string, string> | undefined)?.[PLAYER_REFRESH_COOKIE];
    res.clearCookie(PLAYER_REFRESH_COOKIE, playerRefreshCookieOptions());
    return this.auth.logoutPlayer(raw);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('admin/bootstrap')
  async adminBootstrap(
    @Body() dto: AdminBootstrapDto,
    @Ip() ip: string,
    @Req() req: Request,
    @Headers('x-device-id') deviceId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    // A freshly-bootstrapped account never has 2FA enabled yet, so this is always a complete login.
    const result = await this.auth.adminBootstrap(dto, requestContext(req, ip, deviceId));
    const { refreshToken, refreshExpiresAt, ...body } = result as AdminLoginResult;
    res.cookie(ADMIN_REFRESH_COOKIE, refreshToken, refreshCookieOptions(refreshExpiresAt));
    return body;
  }

  /** Password step. If the account has 2FA enabled this returns { status: 'twofa_required', challengeToken } instead of a session — call admin/2fa/login next. */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('admin/login')
  async adminLogin(
    @Body() dto: AdminLoginDto,
    @Ip() ip: string,
    @Req() req: Request,
    @Headers('x-device-id') deviceId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.adminLogin(dto, requestContext(req, ip, deviceId));
    if (!isCompleteLogin(result)) return result;
    const { refreshToken, refreshExpiresAt, ...body } = result;
    res.cookie(ADMIN_REFRESH_COOKIE, refreshToken, refreshCookieOptions(refreshExpiresAt));
    return body;
  }

  /** 2FA step: exchanges the challengeToken from admin/login plus a current authenticator code for a real session. */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('admin/2fa/login')
  async adminTwoFactorLogin(
    @Body() dto: AdminTwoFactorLoginDto,
    @Ip() ip: string,
    @Req() req: Request,
    @Headers('x-device-id') deviceId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { refreshToken, refreshExpiresAt, ...body } = await this.auth.completeAdminTwoFactorLogin(dto.challengeToken, dto.code, requestContext(req, ip, deviceId));
    res.cookie(ADMIN_REFRESH_COOKIE, refreshToken, refreshCookieOptions(refreshExpiresAt));
    return body;
  }

  /** 2FA step alternative: exchanges the challengeToken from admin/login plus a one-time recovery code, for when the authenticator app is lost/inaccessible. */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('admin/2fa/recovery')
  async adminRecoveryLogin(
    @Body() dto: AdminRecoveryLoginDto,
    @Ip() ip: string,
    @Req() req: Request,
    @Headers('x-device-id') deviceId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { refreshToken, refreshExpiresAt, ...body } = await this.auth.completeAdminRecoveryLogin(dto.challengeToken, dto.recoveryCode, requestContext(req, ip, deviceId));
    res.cookie(ADMIN_REFRESH_COOKIE, refreshToken, refreshCookieOptions(refreshExpiresAt));
    return body;
  }

  /** Starts (or restarts) enrollment — returns a secret + otpauth:// URI to add to an authenticator app. Not active until confirmed. */
  @UseGuards(JwtAdminGuard)
  @Post('admin/2fa/setup')
  adminTwoFactorSetup(@CurrentAdmin() admin: RequestAdmin) {
    assertNotImpersonating(admin);
    return this.auth.setupTotp(admin.adminId);
  }

  /** Proves possession of the authenticator app with a live code and turns 2FA on. */
  @UseGuards(JwtAdminGuard)
  @Post('admin/2fa/confirm')
  adminTwoFactorConfirm(@CurrentAdmin() admin: RequestAdmin, @Body() dto: ConfirmTotpDto) {
    assertNotImpersonating(admin);
    return this.auth.confirmTotp(admin.adminId, dto.code);
  }

  /** Self-service disable — requires the current password. */
  @UseGuards(JwtAdminGuard)
  @Post('admin/2fa/disable')
  adminTwoFactorDisable(@CurrentAdmin() admin: RequestAdmin, @Body() dto: DisableTotpDto) {
    assertNotImpersonating(admin);
    if (!admin.totpEnabled) throw new BadRequestException('2FA is not enabled on this account');
    return this.auth.disableTotp(admin.adminId, dto.password);
  }

  /** Self-service: invalidates the current recovery-code batch and issues a new one — requires the current password. */
  @UseGuards(JwtAdminGuard)
  @Post('admin/2fa/recovery-codes/regenerate')
  regenerateRecoveryCodes(@CurrentAdmin() admin: RequestAdmin, @Body() dto: RegenerateRecoveryCodesDto) {
    assertNotImpersonating(admin);
    return this.auth.regenerateRecoveryCodes(admin.adminId, dto.password);
  }

  /** Self-service opt-in/out: warning/critical notifications get pushed to this chat too, on top of the in-app feed. Works while impersonating (not a security-control change). */
  @UseGuards(JwtAdminGuard)
  @Post('admin/telegram-alerts')
  setTelegramAlerts(@CurrentAdmin() admin: RequestAdmin, @Body() dto: SetTelegramAlertDto) {
    return this.auth.setTelegramAlertChat(admin.adminId, dto.chatId);
  }

  /** Ends the current "view as" session — call this on the impersonation session itself, then restore the original Super Admin session client-side. */
  @UseGuards(JwtAdminGuard)
  @Post('admin/impersonation/exit')
  exitImpersonation(@CurrentAdmin() admin: RequestAdmin, @Ip() ip: string, @Req() req: Request, @Headers('x-device-id') deviceId: string | undefined) {
    return this.auth.endImpersonation(admin, requestContext(req, ip, deviceId));
  }

  /** Rotates the refresh cookie and returns a new 15-minute access token. */
  @Public()
  @Throttle(REFRESH_THROTTLE)
  @Post('admin/refresh')
  async adminRefresh(
    @Ip() ip: string,
    @Req() req: Request,
    @Headers('x-device-id') deviceId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const raw = (req.cookies as Record<string, string> | undefined)?.[ADMIN_REFRESH_COOKIE];
    try {
      const { refreshToken, refreshExpiresAt, ...body } = await this.auth.refreshAdminSession(raw, requestContext(req, ip, deviceId));
      res.cookie(ADMIN_REFRESH_COOKIE, refreshToken, refreshCookieOptions(refreshExpiresAt));
      return body;
    } catch (e) {
      res.clearCookie(ADMIN_REFRESH_COOKIE, refreshCookieOptions());
      throw e;
    }
  }

  /**
   * Phase 8b — first-login password change for operator owners with a generated
   * temporary password. This endpoint is intentionally NOT behind JwtAdminGuard
   * (which rejects sessions flagged must_change_password). Instead it uses the
   * @Public() decorator and resolves the admin manually from the Bearer token +
   * current password verification inside AuthService.changeAdminPassword, making
   * the current-password check the authentication factor.
   *
   * After success all existing sessions are revoked; the admin logs in fresh.
   */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('admin/change-password')
  async changeAdminPassword(@Body() dto: ChangeAdminPasswordDto, @Req() req: Request) {
    const authHeader = (req.headers as Record<string, string | undefined>).authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) throw new BadRequestException('Bearer token required');
    // Decode without verification here only to extract adminId/sessionId;
    // password verification (current vs stored hash) is the auth factor.
    let payload: { sub?: string; sid?: string } = {};
    try {
      payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { sub?: string; sid?: string };
    } catch {
      throw new BadRequestException('Invalid token');
    }
    if (!payload.sub) throw new BadRequestException('Invalid token payload');
    return this.auth.changeAdminPassword(payload.sub, payload.sid ?? '', dto.currentPassword, dto.newPassword);
  }

  @UseGuards(JwtAdminGuard)
  @Post('admin/logout')
  async adminLogout(@CurrentAdmin() admin: RequestAdmin, @Res({ passthrough: true }) res: Response) {
    res.clearCookie(ADMIN_REFRESH_COOKIE, refreshCookieOptions());
    return this.auth.adminLogout(admin.sessionId, admin.adminId, admin.operatorId);
  }

  @UseGuards(JwtAdminGuard)
  @Get('admin/me')
  adminMe(@CurrentAdmin() admin: RequestAdmin) {
    return {
      admin: {
        username: admin.username,
        fullName: admin.fullName,
        roles: admin.roles,
        permissions: admin.permissions,
        operatorId: admin.operatorId,
        totpEnabled: admin.totpEnabled,
        impersonating: admin.impersonatedByAdminId !== null,
        telegramAlertChatId: admin.telegramAlertChatId,
      },
    };
  }
}

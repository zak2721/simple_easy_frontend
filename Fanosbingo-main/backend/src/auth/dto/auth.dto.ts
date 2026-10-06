import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { OPERATOR_SLUG_PATTERN } from '../../common/operator.constants';

export class TelegramLoginDto {
  @IsOptional()
  @IsString()
  initData?: string;

  /** DEV ONLY fallback — only honoured server-side when ALLOW_UNVERIFIED_TELEGRAM=true. */
  @IsOptional()
  devTelegramUserId?: number;

  /**
   * The inviter's referral code, captured from the Mini App's `?start_param`
   * (Telegram deep link) or `?ref=` URL param (see ReferralsService). Accepts
   * either a short alphanumeric code (new scheme) or a raw numeric
   * telegramUserId (legacy scheme, kept forever for backward compatibility
   * with links already shared) — ReferralsService.recordReferral resolves
   * either shape.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{1,20}$/)
  referralCode?: string;

  /** Operator the player is entering through (from the Mini App URL /o/<slug>). Omitted = the default operator. */
  @IsOptional()
  @IsString()
  @Matches(OPERATOR_SLUG_PATTERN)
  operatorSlug?: string;
}

export class AdminLoginDto {
  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class AdminTwoFactorLoginDto {
  @IsString()
  @IsNotEmpty()
  challengeToken!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}

export class ConfirmTotpDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}

export class DisableTotpDto {
  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class AdminRecoveryLoginDto {
  @IsString()
  @IsNotEmpty()
  challengeToken!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/, { message: 'recoveryCode must be an 8-character recovery code' })
  recoveryCode!: string;
}

export class RegenerateRecoveryCodesDto {
  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class SetTelegramAlertDto {
  /** The chat id @userinfobot (or similar) reports for a DM, or a group/channel id. Null clears it — back to in-app only. */
  @IsOptional()
  @IsString()
  @Matches(/^-?\d{1,20}$/, { message: 'chatId must be a numeric Telegram chat id' })
  chatId?: string | null;
}

export class AdminBootstrapDto {
  @IsString()
  @MinLength(3)
  username!: string;

  @IsString()
  @MinLength(10)
  password!: string;

  @IsString()
  @IsNotEmpty()
  fullName!: string;

  @IsString()
  @IsNotEmpty()
  adminKey!: string;
}

export class SetLanguageDto {
  @IsIn(['am', 'en', 'om', 'ti'])
  languageCode!: string;
}

/** Phase 8b — first-login forced password change for operator owners given a generated temporary password. */
export class ChangeAdminPasswordDto {
  @IsString()
  @MinLength(10)
  currentPassword!: string;

  @IsString()
  @MinLength(10)
  newPassword!: string;
}


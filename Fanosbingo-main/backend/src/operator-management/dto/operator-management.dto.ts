import { Type } from 'class-transformer';
import {
  IsBoolean,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OPERATOR_SLUG_PATTERN } from '../../common/operator.constants';

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,40}$/;

export class NewAccountDto {
  @IsString()
  @Matches(USERNAME_PATTERN, { message: 'username: 3-40 letters, digits, _ . -' })
  username!: string;

  /** Omit to have the platform generate a temporary password (shown once in the response). */
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(200)
  password?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  fullName!: string;
}

export class NewRoomDto {
  @IsString()
  @Matches(/^[a-z0-9_-]{1,32}$/)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100000)
  price!: number;

  @IsInt()
  @Min(1)
  @Max(10000)
  capacity!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxPerPlayer?: number;
}

export class CreateOperatorDto {
  @IsString()
  @Matches(OPERATOR_SLUG_PATTERN, { message: 'slug: lowercase letters, digits and dashes (e.g. "abebe-bingo")' })
  slug!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  businessPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  businessEmail?: string;

  /** Subscription plan to assign at creation. Defaults to the "legacy" plan when omitted. */
  @IsOptional()
  @IsString()
  subscriptionPlanId?: string;

  @ValidateNested()
  @Type(() => NewAccountDto)
  owner!: NewAccountDto;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => NewRoomDto)
  rooms!: NewRoomDto[];
}

export class SetOperatorStatusDto {
  @IsIn(['active', 'suspended', 'disabled'])
  status!: 'active' | 'suspended' | 'disabled';

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class SetGameModeDto {
  @IsIn(['continuous', 'scheduled'])
  gameMode!: 'continuous' | 'scheduled';
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(10)
  @MaxLength(200)
  newPassword!: string;
}

export class TransferOwnershipDto {
  @IsString()
  @IsNotEmpty()
  newOwnerAdminId!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class ConfigureBotDto {
  /** The token @BotFather issued. Stored encrypted; never returned by any API. */
  @IsString()
  @Matches(/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/, { message: 'That does not look like a @BotFather token' })
  botToken!: string;

  /** Public base URL of this API (e.g. https://yena-bingo.com/api). Defaults to YENA_BINGO_APP_URL + "/api". */
  @IsOptional()
  @IsString()
  @Matches(/^https:\/\/[^\s]+$/, { message: 'publicApiUrl must be an https URL' })
  publicApiUrl?: string;
}

export class CreateStaffDto extends NewAccountDto {
  @IsArray()
  @IsString({ each: true })
  permissions!: string[];
}

export class SetStaffStatusDto {
  @IsIn(['active', 'suspended', 'disabled'])
  status!: 'active' | 'suspended' | 'disabled';
}

export class SetStaffPermissionsDto {
  @IsArray()
  @IsString({ each: true })
  permissions!: string[];
}

export class UpdateRoomDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100000)
  price?: number;

  /** null = no per-room cap (the operator-wide MAX_CARTELAS_PER_PLAYER still applies). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxPerPlayer?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SetCapacityDto {
  @IsInt()
  @Min(1)
  @Max(10000)
  capacity!: number;
}

export class SetSlotDto {
  @IsBoolean()
  isActive!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class ReassignInventoryDto {
  @IsString()
  @IsNotEmpty()
  fromRoomId!: string;

  @IsString()
  @IsNotEmpty()
  toRoomId!: string;

  @IsInt()
  @Min(1)
  @Max(10000)
  amount!: number;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class UpdateBrandingDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string;

  /** null = back to the platform default theme. */
  @IsOptional()
  @IsString()
  themeId?: string | null;

  /** From POST .../branding/upload; null removes the logo. */
  @IsOptional()
  @IsString()
  logoUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  welcomeMessage?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  bannerUrls?: string[];
}

export class UploadAssetDto {
  @IsString()
  @IsNotEmpty()
  fileBase64!: string;
}

export class ApproveDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RejectDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note!: string;
}

export class SetLimitsDto {
  @IsOptional() @IsInt() @Min(1) @Max(100) MAX_ROOMS?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100000) MAX_TOTAL_CARTELAS?: number;
  @IsOptional() @IsNumber() @Min(0.01) MIN_CARTELA_PRICE?: number;
  @IsOptional() @IsNumber() @Min(0.01) MAX_CARTELA_PRICE?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000) MAX_STAFF?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100000) MAX_GAMES_PER_DAY?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10000000) MAX_ACTIVE_PLAYERS?: number;
}

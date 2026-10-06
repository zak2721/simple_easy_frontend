import { IsDateString, IsIn, IsNumber, IsOptional, IsPositive, IsString, IsUrl, MinLength } from 'class-validator';

export class ReviewDepositDto {
  @IsIn(['approve', 'reject'])
  decision!: 'approve' | 'reject';

  @IsOptional()
  @IsString()
  rejectionReason?: string;

  @IsOptional()
  @IsString()
  adminNote?: string;
}

export class ReviewWithdrawalDto {
  @IsIn(['approve', 'reject', 'mark_paid'])
  decision!: 'approve' | 'reject' | 'mark_paid';

  /** Optional — the admin's own proof they sent the Telebirr payment, attached when marking a withdrawal paid. */
  @IsOptional()
  @IsString()
  proofBase64?: string;

  @IsOptional()
  @IsString()
  rejectionReason?: string;

  @IsOptional()
  @IsString()
  adminNote?: string;
}

export class UpdateSettingDto {
  @IsString()
  value!: string;
}

export class AdjustWalletDto {
  @IsIn(['deposited', 'won', 'bonus'])
  bucket!: 'deposited' | 'won' | 'bonus';

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsIn(['credit', 'debit'])
  direction!: 'credit' | 'debit';

  @IsString()
  @MinLength(3)
  reason!: string;
}

export class UpdateHousePercentageDto {
  @IsNumber()
  @IsPositive()
  housePercentage!: number;

  @IsString()
  @MinLength(3)
  reason!: string;
}

export class FinancialReportQueryDto {
  @IsIn(['daily', 'weekly', 'monthly', 'yearly', 'alltime'])
  period!: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'alltime';

  @IsOptional()
  @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';

  /** Platform admins: narrow to one operator. Omitted = all operators plus a per-operator breakdown. */
  @IsOptional()
  @IsString()
  operatorId?: string;

  /** Custom date range, overriding the fixed period bucket (period is still echoed back for display). */
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

/**
 * Audit finding SEC-5 (Medium): this endpoint used to be `@Body('publicApiUrl')
 * publicApiUrl: string` — a raw field extraction that bypasses the global
 * ValidationPipe entirely (no DTO class = nothing for Nest to validate
 * against). A real DTO with @IsUrl({ protocols: ['https'] }) closes that gap
 * and rejects non-HTTPS targets outright, since Telegram itself requires an
 * HTTPS webhook URL anyway.
 */
export class SetupWebhookDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  publicApiUrl!: string;
}

/** Audit finding ADMIN-1 (Critical): player suspend/ban — see PlayerStatus in schema.prisma. */
export class SetPlayerStatusDto {
  @IsIn(['active', 'suspended', 'banned'])
  status!: 'active' | 'suspended' | 'banned';

  @IsString()
  @MinLength(3)
  reason!: string;
}

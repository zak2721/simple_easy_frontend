import { IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, Matches, MaxLength } from 'class-validator';

export class SubmitDepositDto {
  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsString()
  @IsNotEmpty()
  receiptBase64!: string;

  /**
   * Finding DEP-1 (High): nothing previously captured the actual Telebirr
   * transaction reference, so two separate claims for the SAME physical
   * payment (a screenshot resubmitted, or a player claiming one payment
   * twice) had no shared key an admin or the database could catch — only
   * an alert admin manually cross-referencing screenshots would notice.
   * Telebirr SMS receipts always include a reference/transaction ID; requiring
   * it here plus a partial-unique DB index on approved deposits (see schema.prisma)
   * makes a duplicate APPROVAL fail at the database level, not just rely on admin vigilance.
   */
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9-]{6,40}$/, { message: 'telebirrReference must be the transaction reference from your Telebirr SMS/receipt' })
  telebirrReference!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

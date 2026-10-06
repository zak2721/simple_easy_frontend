import { IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

export class RequestWithdrawalDto {
  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsString()
  @IsNotEmpty()
  telebirrAccount!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

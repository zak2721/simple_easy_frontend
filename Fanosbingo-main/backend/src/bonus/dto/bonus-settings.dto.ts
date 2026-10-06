import { IsBoolean, IsNumber, Min } from 'class-validator';

export class UpdateBonusSettingsDto {
  @IsBoolean()
  enabled!: boolean;

  @IsNumber()
  @Min(0)
  amountEtb!: number;

  @IsNumber()
  @Min(0)
  wageringMultiplier!: number;
}

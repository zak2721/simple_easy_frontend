import { IsInt, IsNotEmpty, IsString, Matches, Max, Min } from 'class-validator';

export class SelectCartelaDto {
  @IsString()
  @IsNotEmpty()
  gameId!: string;

  /** Room code within the player's operator (e.g. "etb5", "etb10", "vip100"). */
  @IsString()
  @Matches(/^[a-z0-9_-]{1,32}$/)
  room!: string;

  @IsInt()
  @Min(1)
  @Max(10000)
  cartelaNumber!: number;
}

export class ReleaseCartelaDto {
  @IsString()
  @IsNotEmpty()
  playerId!: string;
}

export class RegenerateCartelaDto {
  @IsString()
  @IsNotEmpty()
  cartelaId!: string;

  @IsString()
  @IsNotEmpty()
  reason!: string;
}

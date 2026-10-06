import { IsBoolean, IsDateString, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export class CreateThemeDto {
  @IsString() @MaxLength(100)
  name!: string;

  @IsString() @Matches(/^[a-z0-9-]+$/) @MaxLength(100)
  slug!: string;

  @IsString() @Matches(HEX) primaryColor!: string;
  @IsString() @Matches(HEX) secondaryColor!: string;
  @IsString() @Matches(HEX) backgroundColor!: string;
  @IsString() @Matches(HEX) textColor!: string;
  @IsString() @Matches(HEX) surfaceColor!: string;
  @IsString() @Matches(HEX) surfaceAltColor!: string;
  @IsString() @Matches(HEX) mutedTextColor!: string;
  @IsString() @Matches(HEX) accentColor!: string;

  @IsOptional() @IsString() @Matches(HEX)
  buttonBackgroundColor?: string;

  @IsOptional() @IsString() @Matches(HEX)
  buttonTextColor?: string;

  @IsOptional() @IsString() @MaxLength(500)
  logoUrl?: string;

  @IsOptional() @IsString() @MaxLength(500)
  bannerUrl?: string;

  @IsOptional() @IsDateString()
  scheduledStartAt?: string;

  @IsOptional() @IsDateString()
  scheduledEndAt?: string;
}

export class UpdateThemeDto {
  @IsOptional() @IsString() @MaxLength(100)
  name?: string;

  @IsOptional() @IsString() @Matches(HEX) primaryColor?: string;
  @IsOptional() @IsString() @Matches(HEX) secondaryColor?: string;
  @IsOptional() @IsString() @Matches(HEX) backgroundColor?: string;
  @IsOptional() @IsString() @Matches(HEX) textColor?: string;
  @IsOptional() @IsString() @Matches(HEX) surfaceColor?: string;
  @IsOptional() @IsString() @Matches(HEX) surfaceAltColor?: string;
  @IsOptional() @IsString() @Matches(HEX) mutedTextColor?: string;
  @IsOptional() @IsString() @Matches(HEX) accentColor?: string;

  @IsOptional() @IsString() @Matches(HEX)
  buttonBackgroundColor?: string;

  @IsOptional() @IsString() @Matches(HEX)
  buttonTextColor?: string;

  @IsOptional() @IsString() @MaxLength(500)
  logoUrl?: string;

  @IsOptional() @IsString() @MaxLength(500)
  bannerUrl?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  @IsOptional() @IsDateString()
  scheduledStartAt?: string | null;

  @IsOptional() @IsDateString()
  scheduledEndAt?: string | null;
}

export class SetUserThemeDto {
  @IsOptional() @IsUUID()
  themeId?: string | null;
}

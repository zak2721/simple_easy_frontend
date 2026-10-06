import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateGameRuleDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  title!: string;

  @IsString() @IsNotEmpty() @MaxLength(5000)
  body!: string;

  @IsOptional() @IsString() @MaxLength(100)
  category?: string;
}

export class UpdateGameRuleDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200)
  title?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(5000)
  body?: string;

  @IsOptional() @IsString() @MaxLength(100)
  category?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class ReorderGameRuleDto {
  @IsIn(['up', 'down'])
  direction!: 'up' | 'down';
}

import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';

/**
 * Audit finding BOT-3 (Medium): the webhook body was typed as a bare
 * TypeScript `interface`, which Nest's ValidationPipe silently skips
 * (interfaces are erased at compile time — the emitted parameter metatype is
 * `Object`). Converting to real `class`es with class-validator decorators
 * makes this endpoint covered by the same global whitelist/forbidNonWhitelisted
 * contract as every other route, instead of being an undocumented exception.
 */
export class TgChatDto {
  @IsInt()
  id!: number;
}

export class TgFromDto {
  @IsInt()
  id!: number;

  @IsOptional() @IsString()
  first_name?: string;

  @IsOptional() @IsString()
  username?: string;

  @IsOptional() @IsString()
  language_code?: string;
}

export class TgMessageDto {
  @ValidateNested() @Type(() => TgChatDto)
  chat!: TgChatDto;

  @IsOptional() @IsString()
  text?: string;

  @IsOptional() @ValidateNested() @Type(() => TgFromDto)
  from?: TgFromDto;
}

export class TelegramUpdateDto {
  @IsOptional() @ValidateNested() @Type(() => TgMessageDto)
  message?: TgMessageDto;
}

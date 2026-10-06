import { IsEmail, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

export class UpdateContactDto {
  @IsOptional() @IsString() @MaxLength(200)
  telegram?: string;

  @IsOptional() @IsString() @MaxLength(50)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(50)
  whatsapp?: string;

  // Blank clears the field (matches every CONTACT_* setting's '' default) —
  // only validated as an email shape when non-empty.
  @IsOptional() @ValidateIf((o) => !!o.email) @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(500)
  supportHours?: string;
}

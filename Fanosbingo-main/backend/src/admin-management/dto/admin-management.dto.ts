import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PERMISSIONS, type PermissionKey } from '../../common/rbac.constants';

export class CreateAdminDto {
  @IsString()
  @MinLength(3)
  username!: string;

  @IsString()
  @MinLength(10)
  password!: string;

  @IsString()
  @MinLength(1)
  fullName!: string;

  @IsArray()
  @IsIn(PERMISSIONS, { each: true })
  permissions: PermissionKey[] = [];
}

export class UpdateAdminDto {
  @IsString()
  @MinLength(1)
  fullName!: string;
}

export class SetAdminStatusDto {
  @IsIn(['active', 'suspended', 'disabled'])
  status!: 'active' | 'suspended' | 'disabled';
}

export class SetPermissionsDto {
  @IsArray()
  @IsIn(PERMISSIONS, { each: true })
  permissions!: PermissionKey[];
}

export class TogglePermissionDto {
  @IsBoolean()
  enabled!: boolean;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(10)
  newPassword!: string;
}

export class ImpersonateDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

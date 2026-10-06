import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAdminGuard } from '../common/guards/jwt-admin.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentAdmin, RequestAdmin } from '../common/decorators/current-user.decorator';
import { readScope } from '../common/tenant/operator-scope';
import { LoginHistoryService } from '../auth/login-history.service';
import { OperatorManagementService } from './operator-management.service';
import { StaffService } from './staff.service';
import {
  ConfigureBotDto,
  CreateOperatorDto,
  CreateStaffDto,
  ResetPasswordDto,
  SetOperatorStatusDto,
  SetGameModeDto,
  SetStaffPermissionsDto,
  SetStaffStatusDto,
  TransferOwnershipDto,
} from './dto/operator-management.dto';

/** Operator lifecycle — platform admins only (Super Admin, or a platform ADMIN granted MANAGE_OPERATORS). */
@Controller('platform/operators')
@UseGuards(JwtAdminGuard, PlatformAdminGuard, PermissionsGuard)
@Permissions('MANAGE_OPERATORS')
export class PlatformOperatorsController {
  constructor(
    private readonly operators: OperatorManagementService,
    private readonly staff: StaffService,
  ) {}

  @Get()
  list() {
    return this.operators.list();
  }

  @Post()
  create(@CurrentAdmin() admin: RequestAdmin, @Body() dto: CreateOperatorDto) {
    return this.operators.create(admin.adminId, dto);
  }

  @Post(':id/status')
  setStatus(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: SetOperatorStatusDto) {
    return this.operators.setStatus(admin.adminId, id, dto.status, dto.reason);
  }

  @Post(':id/game-mode')
  setGameMode(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: SetGameModeDto) {
    return this.operators.setGameMode(admin.adminId, id, dto.gameMode);
  }

  @Post(':id/reset-owner-password')
  resetOwnerPassword(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: ResetPasswordDto) {
    return this.operators.resetOwnerPassword(admin.adminId, id, dto.newPassword);
  }

  @Post(':id/transfer-ownership')
  transferOwnership(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: TransferOwnershipDto) {
    return this.operators.transferOwnership(admin.adminId, id, dto.newOwnerAdminId, dto.reason);
  }

  @Get(':id/bot')
  getBot(@Param('id') id: string) {
    return this.operators.getBot(id);
  }

  @Put(':id/bot')
  configureBot(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: ConfigureBotDto) {
    return this.operators.configureBot(admin.adminId, id, dto);
  }

  @Get(':id/staff')
  listStaff(@Param('id') id: string) {
    return this.staff.list(id);
  }

  @Post(':id/staff')
  createStaff(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: CreateStaffDto) {
    return this.staff.create(admin, id, dto);
  }
}

function requireOperatorAccount(admin: RequestAdmin): string {
  if (!admin.operatorId) throw new ForbiddenException('This area is for operator accounts — platform admins use /platform/operators');
  return admin.operatorId;
}

function requireOwner(admin: RequestAdmin): string {
  const operatorId = requireOperatorAccount(admin);
  if (!admin.roles.includes('OPERATOR_OWNER')) throw new ForbiddenException('Only the operator owner can do this');
  return operatorId;
}

/** The operator's own account area. Everything is pinned to the caller's own operator. */
@Controller('operator')
@UseGuards(JwtAdminGuard, PermissionsGuard)
export class OperatorSelfController {
  constructor(
    private readonly operators: OperatorManagementService,
    private readonly staff: StaffService,
  ) {}

  @Get('bot')
  getBot(@CurrentAdmin() admin: RequestAdmin) {
    return this.operators.getBot(requireOwner(admin));
  }

  @Put('bot')
  configureBot(@CurrentAdmin() admin: RequestAdmin, @Body() dto: ConfigureBotDto) {
    return this.operators.configureBot(admin.adminId, requireOwner(admin), dto);
  }

  @Get('staff')
  @Permissions('MANAGE_STAFF')
  listStaff(@CurrentAdmin() admin: RequestAdmin) {
    return this.staff.list(requireOperatorAccount(admin));
  }

  @Post('staff')
  @Permissions('MANAGE_STAFF')
  createStaff(@CurrentAdmin() admin: RequestAdmin, @Body() dto: CreateStaffDto) {
    return this.staff.create(admin, requireOperatorAccount(admin), dto);
  }

  @Put('staff/:id/permissions')
  @Permissions('MANAGE_STAFF')
  setPermissions(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: SetStaffPermissionsDto) {
    return this.staff.setPermissions(admin, requireOperatorAccount(admin), id, dto.permissions);
  }

  @Post('staff/:id/status')
  @Permissions('MANAGE_STAFF')
  setStatus(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: SetStaffStatusDto) {
    return this.staff.setStatus(admin, requireOperatorAccount(admin), id, dto.status);
  }

  @Post('staff/:id/reset-password')
  @Permissions('MANAGE_STAFF')
  resetPassword(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: ResetPasswordDto) {
    return this.staff.resetPassword(admin, requireOperatorAccount(admin), id, dto.newPassword);
  }

  @Delete('staff/:id')
  @Permissions('MANAGE_STAFF')
  remove(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string) {
    return this.staff.remove(admin, requireOperatorAccount(admin), id);
  }
}

/** Login trail: platform admins see every operator (or ?operatorId=); operator accounts see their own operator. */
@Controller('admin/login-history')
@UseGuards(JwtAdminGuard, PermissionsGuard)
export class LoginHistoryController {
  constructor(private readonly history: LoginHistoryService) {}

  @Get()
  @Permissions('VIEW_LOGIN_HISTORY')
  list(
    @CurrentAdmin() admin: RequestAdmin,
    @Query('operatorId') operatorId?: string,
    @Query('principalId') principalId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.history.list({ scope: readScope(admin, operatorId), principalId, limit: limit ? Number(limit) : undefined });
  }
}

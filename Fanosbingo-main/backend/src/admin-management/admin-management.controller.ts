import { Body, Controller, Delete, Get, Headers, Ip, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAdminGuard } from '../common/guards/jwt-admin.guard';
import { SuperAdminGuard } from '../common/guards/super-admin.guard';
import { CurrentAdmin, RequestAdmin } from '../common/decorators/current-user.decorator';
import { AuthService } from '../auth/auth.service';
import { AdminManagementService } from './admin-management.service';
import {
  CreateAdminDto,
  UpdateAdminDto,
  SetAdminStatusDto,
  SetPermissionsDto,
  TogglePermissionDto,
  ResetPasswordDto,
  ImpersonateDto,
} from './dto/admin-management.dto';

/**
 * Every route here is Super-Admin-exclusive (SuperAdminGuard), not
 * permission-gated — matches the spec exactly: admin management is not a
 * capability that can be delegated via permissions, because permissions
 * themselves are only ever assigned by the Super Admin.
 */
@Controller('admin-management')
@UseGuards(JwtAdminGuard, SuperAdminGuard)
export class AdminManagementController {
  constructor(
    private readonly service: AdminManagementService,
    private readonly auth: AuthService,
  ) {}

  /** "View as": starts a short-lived session for the target account, tagged with this Super Admin as the real actor. */
  @Post('admins/:id/impersonate')
  impersonate(
    @CurrentAdmin() admin: RequestAdmin,
    @Param('id') id: string,
    @Body() dto: ImpersonateDto,
    @Ip() ip: string,
    @Req() req: Request,
    @Headers('x-device-id') deviceId: string | undefined,
  ) {
    return this.auth.startImpersonation(admin.adminId, id, dto.reason, { ip, userAgent: req.headers['user-agent'], deviceId });
  }

  @Get('admins')
  list() {
    return this.service.list();
  }

  @Get('admins/:id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post('admins')
  create(@CurrentAdmin() admin: RequestAdmin, @Body() dto: CreateAdminDto) {
    return this.service.create(admin.adminId, dto);
  }

  @Put('admins/:id')
  update(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: UpdateAdminDto) {
    return this.service.update(admin.adminId, id, dto);
  }

  @Post('admins/:id/status')
  setStatus(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: SetAdminStatusDto) {
    return this.service.setStatus(admin.adminId, id, dto.status);
  }

  @Delete('admins/:id')
  delete(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string) {
    return this.service.delete(admin.adminId, id);
  }

  @Post('admins/:id/reset-password')
  resetPassword(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: ResetPasswordDto) {
    return this.service.resetPassword(admin.adminId, id, dto.newPassword);
  }

  @Post('admins/:id/unlock')
  unlock(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string) {
    return this.service.unlock(admin.adminId, id);
  }

  /** Recovery path when an admin loses their authenticator app/device — no password needed, this is a Super Admin override. */
  @Post('admins/:id/2fa/disable')
  disableTotp(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string) {
    return this.service.disableTotpFor(admin.adminId, id);
  }

  @Post('admins/:id/permissions')
  setPermissions(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: SetPermissionsDto) {
    return this.service.setPermissions(admin.adminId, id, dto.permissions);
  }

  @Post('admins/:id/permissions/:key/toggle')
  togglePermission(
    @CurrentAdmin() admin: RequestAdmin,
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() dto: TogglePermissionDto,
  ) {
    return this.service.togglePermission(admin.adminId, id, key as never, dto.enabled);
  }

  @Get('admins/:id/sessions')
  sessions(@Param('id') id: string) {
    return this.service.listSessions(id);
  }

  @Post('sessions/:sessionId/revoke')
  revokeSession(@CurrentAdmin() admin: RequestAdmin, @Param('sessionId') sessionId: string) {
    return this.service.revokeSession(admin.adminId, sessionId);
  }

  @Get('admins/:id/activity')
  activity(@Param('id') id: string) {
    return this.service.adminActivity(id);
  }

  @Get('permissions')
  permissionCatalog() {
    return this.service.permissionCatalog();
  }

  @Get('sessions/active')
  listAllActiveSessions() {
    return this.service.listAllActiveSessions();
  }
}

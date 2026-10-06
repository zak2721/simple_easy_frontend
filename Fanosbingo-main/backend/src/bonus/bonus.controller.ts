import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { writeTarget } from '../common/tenant/operator-scope';
import { JwtAdminGuard } from '../common/guards/jwt-admin.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentAdmin, RequestAdmin } from '../common/decorators/current-user.decorator';
import { SettingsService } from '../settings/settings.service';
import { UpdateBonusSettingsDto } from './dto/bonus-settings.dto';

/** Admin config surface for the welcome/signup bonus — backed by the same Setting rows AuthService.grantSignupBonus reads. */
@Controller('admin/bonus-settings')
@UseGuards(JwtAdminGuard, PermissionsGuard)
export class AdminBonusSettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @Permissions('MANAGE_BONUS_SETTINGS')
  get(@CurrentAdmin() admin: RequestAdmin, @Query('operatorId') operatorId?: string) {
    return this.read(writeTarget(admin, operatorId));
  }

  private async read(target: string) {
    const [enabled, amountEtb, wageringMultiplier] = await Promise.all([
      this.settings.get('WELCOME_BONUS_ENABLED', target),
      this.settings.get('SIGNUP_BONUS_ETB', target),
      this.settings.get('SIGNUP_BONUS_WAGERING_MULTIPLIER', target),
    ]);
    return {
      enabled: (enabled ?? 'true') !== 'false',
      amountEtb: Number(amountEtb ?? 0),
      wageringMultiplier: Number(wageringMultiplier ?? 1),
    };
  }

  @Put()
  @Permissions('MANAGE_BONUS_SETTINGS')
  async update(@CurrentAdmin() admin: RequestAdmin, @Body() dto: UpdateBonusSettingsDto, @Query('operatorId') operatorId?: string) {
    const target = writeTarget(admin, operatorId);
    await this.settings.set('WELCOME_BONUS_ENABLED', String(dto.enabled), admin.adminId, target);
    await this.settings.set('SIGNUP_BONUS_ETB', String(dto.amountEtb), admin.adminId, target);
    await this.settings.set('SIGNUP_BONUS_WAGERING_MULTIPLIER', String(dto.wageringMultiplier), admin.adminId, target);
    return this.read(target);
  }
}

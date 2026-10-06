import { Body, Controller, Get, NotFoundException, Put, Query, UseGuards } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { JwtAdminGuard } from '../common/guards/jwt-admin.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentAdmin, RequestAdmin } from '../common/decorators/current-user.decorator';
import { SettingsService } from '../settings/settings.service';
import { OperatorsService } from '../operators/operators.service';
import { OPERATOR_SLUG_PATTERN } from '../common/operator.constants';
import { writeTarget } from '../common/tenant/operator-scope';
import { UpdateContactDto } from './dto/contact-center.dto';

/**
 * Read-only, unauthenticated — contact info is non-sensitive and this lets
 * ContactScreen.tsx refresh it mid-session (e.g. an admin edits it while the
 * player has the app open) without a full session/login refresh.
 * `?operator=<slug>` selects the operator; omitted = the default operator.
 */
@Controller('contact')
export class ContactController {
  constructor(
    private readonly settings: SettingsService,
    private readonly operators: OperatorsService,
  ) {}

  @Public()
  @Get()
  async get(@Query('operator') slug?: string) {
    if (slug !== undefined && !OPERATOR_SLUG_PATTERN.test(slug)) throw new NotFoundException('Operator not found');
    const operator = await this.operators.resolveForPlayer(slug);
    return this.settings.getContactInfo(operator.id);
  }
}

/** Admin-managed contact info — a typed, validated surface over the same CONTACT_* settings the generic settings endpoint already exposes. */
@Controller('admin/contact')
@UseGuards(JwtAdminGuard, PermissionsGuard)
export class AdminContactCenterController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @Permissions('VIEW_CONTACT_CENTER')
  get(@CurrentAdmin() admin: RequestAdmin, @Query('operatorId') operatorId?: string) {
    return this.settings.getContactInfo(writeTarget(admin, operatorId));
  }

  @Put()
  @Permissions('MANAGE_CONTACT_CENTER')
  async update(@CurrentAdmin() admin: RequestAdmin, @Body() dto: UpdateContactDto, @Query('operatorId') operatorId?: string) {
    const target = writeTarget(admin, operatorId);
    if (dto.telegram !== undefined) await this.settings.set('CONTACT_TELEGRAM', dto.telegram, admin.adminId, target);
    if (dto.phone !== undefined) await this.settings.set('CONTACT_PHONE', dto.phone, admin.adminId, target);
    if (dto.whatsapp !== undefined) await this.settings.set('CONTACT_WHATSAPP', dto.whatsapp, admin.adminId, target);
    if (dto.email !== undefined) await this.settings.set('CONTACT_EMAIL', dto.email, admin.adminId, target);
    if (dto.supportHours !== undefined) await this.settings.set('CONTACT_SUPPORT_HOURS', dto.supportHours, admin.adminId, target);
    return this.settings.getContactInfo(target);
  }
}

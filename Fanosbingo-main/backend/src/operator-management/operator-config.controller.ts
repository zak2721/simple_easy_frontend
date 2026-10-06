import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, ParseIntPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { JwtAdminGuard } from '../common/guards/jwt-admin.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentAdmin, RequestAdmin } from '../common/decorators/current-user.decorator';
import { OPERATOR_SLUG_PATTERN } from '../common/operator.constants';
import { NotificationsService } from '../notifications/notifications.service';
import { RoomsService } from './rooms.service';
import { BrandingService } from './branding.service';
import { ApprovalsService } from './approvals.service';
import { LimitsService } from './limits.service';
import {
  ApproveDto,
  NewRoomDto,
  ReassignInventoryDto,
  RejectDto,
  SetCapacityDto,
  SetLimitsDto,
  SetSlotDto,
  UpdateBrandingDto,
  UpdateRoomDto,
  UploadAssetDto,
} from './dto/operator-management.dto';

function operatorOf(admin: RequestAdmin): string {
  if (!admin.operatorId) throw new ForbiddenException('This area is for operator accounts — platform admins use /platform/operators/:id/...');
  return admin.operatorId;
}

/**
 * The operator's own rooms, inventory, branding and approval requests.
 * Changes the spec reserves for Super Admin approval are turned into
 * approval requests here (the response says `pendingApproval: true`);
 * everything else applies immediately and, where the spec asks, notifies
 * the Super Admin.
 */
@Controller('operator')
@UseGuards(JwtAdminGuard, PermissionsGuard)
export class OperatorConfigController {
  constructor(
    private readonly rooms: RoomsService,
    private readonly branding: BrandingService,
    private readonly approvals: ApprovalsService,
    private readonly limits: LimitsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ----- Rooms & inventory -----

  @Get('rooms')
  @Permissions('MANAGE_ROOMS')
  async inventory(@CurrentAdmin() admin: RequestAdmin) {
    const operatorId = operatorOf(admin);
    const [inventory, limits] = await Promise.all([this.rooms.inventory(operatorId), this.limits.get(operatorId)]);
    return { ...inventory, limits };
  }

  /** A new room adds cartelas, so it needs approval. */
  @Post('rooms')
  @Permissions('MANAGE_ROOMS')
  createRoom(@CurrentAdmin() admin: RequestAdmin, @Body() dto: NewRoomDto) {
    return this.approvals.submit(admin.adminId, operatorOf(admin), 'ROOM_CREATE', dto.code, { ...dto });
  }

  /** Price / name / per-player cap / on-off apply now; a price change notifies the Super Admin. */
  @Patch('rooms/:id')
  @Permissions('MANAGE_ROOMS')
  async updateRoom(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: UpdateRoomDto) {
    const operatorId = operatorOf(admin);
    const { before, after } = await this.rooms.updateRoom(admin.adminId, operatorId, id, dto);
    if (dto.price !== undefined && Number(before.price) !== Number(after.price)) {
      await this.notifications.notifyPlatform({
        type: 'PRICING_CHANGED',
        title: `Cartela price changed: ${after.code}`,
        body: `${Number(before.price)} -> ${Number(after.price)} ETB (applies from the next purchase)`,
        operatorId,
        relatedEntityType: 'operator_room',
        relatedEntityId: id,
      });
    }
    return after;
  }

  /** Decrease applies now; an increase needs approval. */
  @Post('rooms/:id/capacity')
  @Permissions('MANAGE_ROOMS')
  async setCapacity(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: SetCapacityDto) {
    const operatorId = operatorOf(admin);
    const room = await this.rooms.getRoom(operatorId, id);
    if (dto.capacity > room.capacity) {
      return this.approvals.submit(admin.adminId, operatorId, 'ROOM_CAPACITY_INCREASE', id, { capacity: dto.capacity });
    }
    const result = await this.rooms.setCapacity(admin.adminId, operatorId, id, dto.capacity);
    await this.notifications.notifyPlatform({
      type: 'INVENTORY_DECREASED',
      title: `Cartela quantity reduced: ${room.code}`,
      body: `${room.capacity} -> ${dto.capacity}`,
      operatorId,
      relatedEntityType: 'operator_room',
      relatedEntityId: id,
    });
    return result;
  }

  @Patch('rooms/:id/slots/:number')
  @Permissions('MANAGE_ROOMS')
  setSlot(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Param('number', ParseIntPipe) number: number, @Body() dto: SetSlotDto) {
    return this.rooms.setSlotActive(admin.adminId, operatorOf(admin), id, number, dto.isActive, dto.reason);
  }

  // ----- Branding -----

  @Get('branding')
  @Permissions('MANAGE_BRANDING')
  async getBranding(@CurrentAdmin() admin: RequestAdmin) {
    const operatorId = operatorOf(admin);
    const [branding, pending] = await Promise.all([
      this.branding.get(operatorId),
      this.approvals.list({ operatorId, status: 'pending' }),
    ]);
    return { ...branding, pendingChanges: pending.filter((p) => p.type.startsWith('BRANDING_')) };
  }

  /** Name / logo / theme go to approval (one request each); welcome message and banners apply now. */
  @Put('branding')
  @Permissions('MANAGE_BRANDING')
  async updateBranding(@CurrentAdmin() admin: RequestAdmin, @Body() dto: UpdateBrandingDto) {
    const operatorId = operatorOf(admin);
    const current = await this.branding.snapshot(operatorId);
    const submitted: unknown[] = [];
    if (dto.displayName !== undefined && dto.displayName.trim() !== current.displayName) {
      submitted.push(await this.approvals.submit(admin.adminId, operatorId, 'BRANDING_NAME', '', { displayName: dto.displayName }));
    }
    if (dto.logoUrl !== undefined && dto.logoUrl !== current.logoUrl) {
      submitted.push(await this.approvals.submit(admin.adminId, operatorId, 'BRANDING_LOGO', '', { logoUrl: dto.logoUrl }));
    }
    if (dto.themeId !== undefined && dto.themeId !== current.themeId) {
      submitted.push(await this.approvals.submit(admin.adminId, operatorId, 'BRANDING_THEME', '', { themeId: dto.themeId }));
    }
    const direct = dto.welcomeMessage !== undefined || dto.bannerUrls !== undefined;
    if (direct) {
      await this.branding.updateDirect(admin.adminId, operatorId, { welcomeMessage: dto.welcomeMessage, bannerUrls: dto.bannerUrls });
      await this.notifications.notifyPlatform({
        type: 'BRANDING_CHANGED',
        title: 'Operator updated its welcome message / banners',
        operatorId,
        relatedEntityType: 'operator_branding',
        relatedEntityId: operatorId,
      });
    }
    return { branding: await this.branding.get(operatorId), submittedForApproval: submitted, appliedDirectly: direct };
  }

  @Post('branding/upload')
  @Permissions('MANAGE_BRANDING')
  upload(@CurrentAdmin() admin: RequestAdmin, @Body() dto: UploadAssetDto) {
    return this.branding.uploadAsset(operatorOf(admin), dto.fileBase64);
  }

  // ----- Approvals (own requests) -----

  @Get('approvals')
  listApprovals(@CurrentAdmin() admin: RequestAdmin, @Query('status') status?: string) {
    return this.approvals.list({ operatorId: operatorOf(admin), status });
  }

  @Post('approvals/:id/cancel')
  cancelApproval(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string) {
    return this.approvals.cancel(admin.adminId, operatorOf(admin), id);
  }

  @Get('limits')
  getLimits(@CurrentAdmin() admin: RequestAdmin) {
    return this.limits.get(operatorOf(admin));
  }
}

/** Platform side: review approvals, and change any operator's rooms/branding/limits directly (no approval needed). */
@Controller('platform')
@UseGuards(JwtAdminGuard, PlatformAdminGuard, PermissionsGuard)
export class PlatformConfigController {
  constructor(
    private readonly rooms: RoomsService,
    private readonly branding: BrandingService,
    private readonly approvals: ApprovalsService,
    private readonly limits: LimitsService,
  ) {}

  @Get('approvals')
  @Permissions('APPROVE_OPERATOR_CHANGES')
  listApprovals(@Query('status') status?: string, @Query('operatorId') operatorId?: string) {
    return this.approvals.list({ status: status ?? 'pending', operatorId });
  }

  @Post('approvals/:id/approve')
  @Permissions('APPROVE_OPERATOR_CHANGES')
  approve(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: ApproveDto) {
    return this.approvals.approve(admin.adminId, id, dto.note);
  }

  @Post('approvals/:id/reject')
  @Permissions('APPROVE_OPERATOR_CHANGES')
  reject(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: RejectDto) {
    return this.approvals.reject(admin.adminId, id, dto.note);
  }

  @Get('operators/:id/rooms')
  @Permissions('MANAGE_OPERATORS')
  async inventory(@Param('id') id: string) {
    const [inventory, limits] = await Promise.all([this.rooms.inventory(id), this.limits.get(id)]);
    return { ...inventory, limits };
  }

  @Post('operators/:id/rooms')
  @Permissions('MANAGE_OPERATORS')
  createRoom(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: NewRoomDto) {
    return this.rooms.createRoom(admin.adminId, id, dto);
  }

  @Patch('operators/:id/rooms/:roomId')
  @Permissions('MANAGE_OPERATORS')
  async updateRoom(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Param('roomId') roomId: string, @Body() dto: UpdateRoomDto) {
    return (await this.rooms.updateRoom(admin.adminId, id, roomId, dto)).after;
  }

  @Post('operators/:id/rooms/:roomId/capacity')
  @Permissions('MANAGE_OPERATORS')
  setCapacity(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Param('roomId') roomId: string, @Body() dto: SetCapacityDto) {
    return this.rooms.setCapacity(admin.adminId, id, roomId, dto.capacity);
  }

  @Patch('operators/:id/rooms/:roomId/slots/:number')
  @Permissions('MANAGE_OPERATORS')
  setSlot(
    @CurrentAdmin() admin: RequestAdmin,
    @Param('id') id: string,
    @Param('roomId') roomId: string,
    @Param('number', ParseIntPipe) number: number,
    @Body() dto: SetSlotDto,
  ) {
    return this.rooms.setSlotActive(admin.adminId, id, roomId, number, dto.isActive, dto.reason);
  }

  @Post('inventory/reassign')
  @Permissions('MANAGE_OPERATORS')
  reassign(@CurrentAdmin() admin: RequestAdmin, @Body() dto: ReassignInventoryDto) {
    return this.rooms.reassign(admin.adminId, dto.fromRoomId, dto.toRoomId, dto.amount, dto.reason);
  }

  @Get('operators/:id/branding')
  @Permissions('MANAGE_OPERATORS')
  getBranding(@Param('id') id: string) {
    return this.branding.get(id);
  }

  /** Super Admin override: every field applies immediately. */
  @Put('operators/:id/branding')
  @Permissions('MANAGE_OPERATORS')
  async updateBranding(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: UpdateBrandingDto) {
    if (dto.displayName !== undefined) await this.branding.applyName(admin.adminId, id, dto.displayName);
    if (dto.logoUrl !== undefined) await this.branding.applyLogo(admin.adminId, id, dto.logoUrl);
    if (dto.themeId !== undefined) await this.branding.applyTheme(admin.adminId, id, dto.themeId);
    if (dto.welcomeMessage !== undefined || dto.bannerUrls !== undefined) {
      await this.branding.updateDirect(admin.adminId, id, { welcomeMessage: dto.welcomeMessage, bannerUrls: dto.bannerUrls });
    }
    return this.branding.get(id);
  }

  @Post('operators/:id/branding/upload')
  @Permissions('MANAGE_OPERATORS')
  upload(@Param('id') id: string, @Body() dto: UploadAssetDto) {
    return this.branding.uploadAsset(id, dto.fileBase64);
  }

  @Get('operators/:id/limits')
  @Permissions('MANAGE_OPERATORS')
  getLimits(@Param('id') id: string) {
    return this.limits.get(id);
  }

  @Put('operators/:id/limits')
  @Permissions('MANAGE_OPERATORS')
  setLimits(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: SetLimitsDto) {
    return this.limits.set(admin.adminId, id, { ...dto });
  }
}

/** Unauthenticated: the Mini App's splash branding before login. `?operator=<slug>`; omitted = default operator. */
@Controller('public/branding')
export class PublicBrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Public()
  @Get()
  get(@Query('operator') slug?: string) {
    if (slug !== undefined && !OPERATOR_SLUG_PATTERN.test(slug)) throw new NotFoundException('Operator not found');
    return this.branding.publicBranding(slug);
  }
}

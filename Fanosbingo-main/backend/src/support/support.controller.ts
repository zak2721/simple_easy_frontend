import { Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtPlayerGuard } from '../common/guards/jwt-player.guard';
import { JwtAdminGuard } from '../common/guards/jwt-admin.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser, CurrentAdmin, RequestPlayer, RequestAdmin } from '../common/decorators/current-user.decorator';
import { SupportService } from './support.service';
import { CreateTicketDto, ReplyTicketDto, SetTicketStatusDto, AssignTicketDto } from './dto/support.dto';

/** Player-facing: the Mini App's "Contact support" flow. */
@Controller('support/tickets')
@UseGuards(JwtPlayerGuard)
export class SupportPlayerController {
  constructor(private readonly support: SupportService) {}

  @Get()
  list(@CurrentUser() player: RequestPlayer) {
    return this.support.listForPlayer(player.userId);
  }

  @Post()
  create(@CurrentUser() player: RequestPlayer, @Body() dto: CreateTicketDto) {
    return this.support.create(player.userId, player.operatorId, dto.subject, dto.message);
  }

  @Get(':id')
  get(@CurrentUser() player: RequestPlayer, @Param('id') id: string) {
    return this.support.getForPlayer(player.userId, id);
  }

  @Post(':id/reply')
  reply(@CurrentUser() player: RequestPlayer, @Param('id') id: string, @Body() dto: ReplyTicketDto) {
    return this.support.replyAsPlayer(player.userId, id, dto.body);
  }
}

function operatorOf(admin: RequestAdmin): string {
  if (!admin.operatorId) throw new ForbiddenException('Support tickets belong to one operator — sign in as that operator to handle them');
  return admin.operatorId;
}

/** Operator staff/owner: handle their own operator's tickets. */
@Controller('operator/tickets')
@UseGuards(JwtAdminGuard, PermissionsGuard)
export class SupportAdminController {
  constructor(private readonly support: SupportService) {}

  @Get()
  @Permissions('VIEW_SUPPORT_TICKETS')
  list(@CurrentAdmin() admin: RequestAdmin, @Query('status') status?: string) {
    return this.support.listForAdmin(operatorOf(admin), status);
  }

  @Get(':id')
  @Permissions('VIEW_SUPPORT_TICKETS')
  get(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string) {
    return this.support.getForAdmin(operatorOf(admin), id);
  }

  @Post(':id/reply')
  @Permissions('MANAGE_SUPPORT_TICKETS')
  reply(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: ReplyTicketDto) {
    return this.support.replyAsAdmin(admin.adminId, operatorOf(admin), id, dto.body);
  }

  @Post(':id/status')
  @Permissions('MANAGE_SUPPORT_TICKETS')
  setStatus(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: SetTicketStatusDto) {
    return this.support.setStatus(admin.adminId, operatorOf(admin), id, dto.status);
  }

  @Post(':id/assign')
  @Permissions('MANAGE_SUPPORT_TICKETS')
  assign(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: AssignTicketDto) {
    return this.support.assign(admin.adminId, operatorOf(admin), id, dto.assignedAdminId ?? null);
  }
}

/** Platform view: read any operator's tickets (support oversight), never reply as the operator. */
@Controller('platform/operators/:operatorId/tickets')
@UseGuards(JwtAdminGuard, PermissionsGuard)
export class SupportPlatformController {
  constructor(private readonly support: SupportService) {}

  @Get()
  @Permissions('MANAGE_OPERATORS')
  list(@Param('operatorId') operatorId: string, @Query('status') status?: string) {
    return this.support.listForAdmin(operatorId, status);
  }

  @Get(':id')
  @Permissions('MANAGE_OPERATORS')
  get(@Param('operatorId') operatorId: string, @Param('id') id: string) {
    return this.support.getForAdmin(operatorId, id);
  }
}

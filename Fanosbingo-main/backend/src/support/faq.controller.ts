import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtPlayerGuard } from '../common/guards/jwt-player.guard';
import { JwtAdminGuard } from '../common/guards/jwt-admin.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser, CurrentAdmin, RequestPlayer, RequestAdmin } from '../common/decorators/current-user.decorator';
import { writeTarget } from '../common/tenant/operator-scope';
import { FaqService } from './faq.service';
import { CreateFaqDto, UpdateFaqDto, ReorderFaqDto } from './dto/support.dto';

/** Player-facing: the Mini App's FAQ / Help page. */
@Controller('faq')
@UseGuards(JwtPlayerGuard)
export class FaqPlayerController {
  constructor(private readonly faq: FaqService) {}

  @Get()
  list(@CurrentUser() player: RequestPlayer) {
    return this.faq.listActive(player.operatorId);
  }
}

function operatorOf(admin: RequestAdmin, operatorId?: string): string {
  if (admin.operatorId) return admin.operatorId;
  if (!operatorId) throw new ForbiddenException('?operatorId= is required for a platform admin');
  return operatorId;
}

/** Admin management — the operator's own FAQ; a platform admin can manage any operator's via ?operatorId=. */
@Controller('admin/faq')
@UseGuards(JwtAdminGuard, PermissionsGuard)
export class FaqAdminController {
  constructor(private readonly faq: FaqService) {}

  @Get()
  @Permissions('VIEW_GAME_RULES')
  list(@CurrentAdmin() admin: RequestAdmin, @Query('operatorId') operatorId?: string) {
    return this.faq.listAll(writeTarget(admin, operatorId));
  }

  @Post()
  @Permissions('MANAGE_GAME_RULES')
  create(@CurrentAdmin() admin: RequestAdmin, @Body() dto: CreateFaqDto, @Query('operatorId') operatorId?: string) {
    return this.faq.create(admin.adminId, writeTarget(admin, operatorId), dto);
  }

  @Patch(':id')
  @Permissions('MANAGE_GAME_RULES')
  update(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: UpdateFaqDto, @Query('operatorId') operatorId?: string) {
    return this.faq.update(admin.adminId, writeTarget(admin, operatorId), id, dto);
  }

  @Delete(':id')
  @Permissions('MANAGE_GAME_RULES')
  remove(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Query('operatorId') operatorId?: string) {
    return this.faq.remove(admin.adminId, writeTarget(admin, operatorId), id);
  }

  @Post(':id/reorder')
  @Permissions('MANAGE_GAME_RULES')
  reorder(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: ReorderFaqDto, @Query('operatorId') operatorId?: string) {
    return this.faq.reorder(admin.adminId, writeTarget(admin, operatorId), id, dto.direction);
  }
}

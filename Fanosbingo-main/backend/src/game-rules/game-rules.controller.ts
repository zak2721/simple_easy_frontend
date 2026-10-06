import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { writeTarget } from '../common/tenant/operator-scope';
import { JwtPlayerGuard } from '../common/guards/jwt-player.guard';
import { JwtAdminGuard } from '../common/guards/jwt-admin.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentAdmin, CurrentUser, RequestAdmin, RequestPlayer } from '../common/decorators/current-user.decorator';
import { GameRulesService } from './game-rules.service';
import { CreateGameRuleDto, UpdateGameRuleDto, ReorderGameRuleDto } from './dto/game-rules.dto';

/** Public (player) endpoint — the Mini App's Help page. */
@Controller('game-rules')
@UseGuards(JwtPlayerGuard)
export class GameRulesController {
  constructor(private readonly gameRules: GameRulesService) {}

  @Get()
  list(@CurrentUser() player: RequestPlayer) {
    return this.gameRules.listActive(player.operatorId);
  }
}

/** Admin management — create/edit/delete/reorder. */
@Controller('admin/game-rules')
@UseGuards(JwtAdminGuard, PermissionsGuard)
export class AdminGameRulesController {
  constructor(private readonly gameRules: GameRulesService) {}

  @Get()
  @Permissions('VIEW_GAME_RULES')
  list(@CurrentAdmin() admin: RequestAdmin, @Query('operatorId') operatorId?: string) {
    return this.gameRules.listAll(writeTarget(admin, operatorId));
  }

  @Post()
  @Permissions('MANAGE_GAME_RULES')
  create(@CurrentAdmin() admin: RequestAdmin, @Body() dto: CreateGameRuleDto, @Query('operatorId') operatorId?: string) {
    return this.gameRules.create(dto, admin.adminId, writeTarget(admin, operatorId));
  }

  @Patch(':id')
  @Permissions('MANAGE_GAME_RULES')
  update(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: UpdateGameRuleDto, @Query('operatorId') operatorId?: string) {
    return this.gameRules.update(id, dto, admin.adminId, writeTarget(admin, operatorId));
  }

  @Delete(':id')
  @Permissions('MANAGE_GAME_RULES')
  remove(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Query('operatorId') operatorId?: string) {
    return this.gameRules.remove(id, admin.adminId, writeTarget(admin, operatorId));
  }

  @Post(':id/reorder')
  @Permissions('MANAGE_GAME_RULES')
  reorder(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: ReorderGameRuleDto, @Query('operatorId') operatorId?: string) {
    return this.gameRules.reorder(id, dto.direction, admin.adminId, writeTarget(admin, operatorId));
  }
}

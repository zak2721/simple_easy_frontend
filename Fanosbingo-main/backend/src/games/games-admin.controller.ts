import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { JwtAdminGuard } from '../common/guards/jwt-admin.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentAdmin, RequestAdmin } from '../common/decorators/current-user.decorator';
import { GamesService } from './games.service';

export class ScheduleGameDto {
  @IsDateString()
  startsAt!: string;

  /** How long before the start cartela sales open (default 10). */
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(1440)
  salesOpenMinutes?: number;

  /** Subset of row, column, diagonal, corners, full_house. Default: the operator's WINNING_PATTERNS setting. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  winningPatterns?: string[];
}

export class UpdateGameDto {
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  winningPatterns?: string[];
}

export class CancelGameDto {
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}

function operatorOf(admin: RequestAdmin): string {
  if (!admin.operatorId) throw new ForbiddenException('This area is for operator accounts — platform admins use /platform/operators/:id/games');
  return admin.operatorId;
}

/** The operator's own games: list, schedule, edit, cancel (scheduled mode). */
@Controller('operator/games')
@UseGuards(JwtAdminGuard, PermissionsGuard)
export class OperatorGamesController {
  constructor(private readonly games: GamesService) {}

  @Get()
  @Permissions('VIEW_GAMES')
  list(@CurrentAdmin() admin: RequestAdmin) {
    return this.games.listForAdmin(operatorOf(admin));
  }

  @Post()
  @Permissions('CREATE_GAMES')
  schedule(@CurrentAdmin() admin: RequestAdmin, @Body() dto: ScheduleGameDto) {
    return this.games.scheduleGame(admin.adminId, operatorOf(admin), {
      startsAt: new Date(dto.startsAt),
      salesOpenMinutes: dto.salesOpenMinutes,
      winningPatterns: dto.winningPatterns,
    });
  }

  @Patch(':id')
  @Permissions('UPDATE_GAMES')
  update(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: UpdateGameDto) {
    return this.games.updateGame(admin.adminId, operatorOf(admin), id, {
      startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
      winningPatterns: dto.winningPatterns,
    });
  }

  @Post(':id/cancel')
  @Permissions('UPDATE_GAMES')
  cancel(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: CancelGameDto) {
    return this.games.cancelByAdmin(admin.adminId, operatorOf(admin), id, dto.reason);
  }
}

/** Platform view of (and control over) any operator's games. */
@Controller('platform/operators/:operatorId/games')
@UseGuards(JwtAdminGuard, PlatformAdminGuard, PermissionsGuard)
@Permissions('MANAGE_OPERATORS')
export class PlatformGamesController {
  constructor(private readonly games: GamesService) {}

  @Get()
  list(@Param('operatorId') operatorId: string) {
    return this.games.listForAdmin(operatorId);
  }

  @Post()
  schedule(@CurrentAdmin() admin: RequestAdmin, @Param('operatorId') operatorId: string, @Body() dto: ScheduleGameDto) {
    return this.games.scheduleGame(admin.adminId, operatorId, {
      startsAt: new Date(dto.startsAt),
      salesOpenMinutes: dto.salesOpenMinutes,
      winningPatterns: dto.winningPatterns,
    });
  }

  @Post(':id/cancel')
  cancel(@CurrentAdmin() admin: RequestAdmin, @Param('operatorId') operatorId: string, @Param('id') id: string, @Body() dto: CancelGameDto) {
    return this.games.cancelByAdmin(admin.adminId, operatorId, id, dto.reason);
  }
}

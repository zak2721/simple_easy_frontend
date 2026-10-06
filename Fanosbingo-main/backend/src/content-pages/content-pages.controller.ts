import { Body, Controller, ForbiddenException, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ContentPageType } from '@prisma/client';
import { JwtAdminGuard } from '../common/guards/jwt-admin.guard';
import { JwtPlayerGuard } from '../common/guards/jwt-player.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentAdmin, CurrentUser, RequestAdmin, RequestPlayer } from '../common/decorators/current-user.decorator';
import { writeTarget } from '../common/tenant/operator-scope';
import { ContentPagesService } from './content-pages.service';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

class UpsertContentPageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100_000)
  bodyMarkdown!: string;
}

function parsePageType(raw: string): ContentPageType {
  if (!Object.values(ContentPageType).includes(raw as ContentPageType)) {
    throw new ForbiddenException(`Unknown page type: ${raw}`);
  }
  return raw as ContentPageType;
}

/** Player-facing: read the content page for the current operator (with platform fallback). */
@Controller('content-pages')
@UseGuards(JwtPlayerGuard)
export class ContentPagesPlayerController {
  constructor(private readonly svc: ContentPagesService) {}

  @Get(':pageType')
  get(@CurrentUser() player: RequestPlayer, @Param('pageType') pageType: string) {
    return this.svc.get(player.operatorId, parsePageType(pageType));
  }

  @Get()
  list(@CurrentUser() player: RequestPlayer) {
    return this.svc.listForPlayer(player.operatorId);
  }
}

/** Admin management: operator or platform admin can read/write content pages. */
@Controller('admin/content-pages')
@UseGuards(JwtAdminGuard, PermissionsGuard)
export class ContentPagesAdminController {
  constructor(private readonly svc: ContentPagesService) {}

  @Get(':pageType')
  @Permissions('MANAGE_SETTINGS')
  get(@CurrentAdmin() admin: RequestAdmin, @Param('pageType') pageType: string, @Query('operatorId') operatorId?: string) {
    const opId = admin.operatorId ?? operatorId ?? null;
    return this.svc.get(opId, parsePageType(pageType));
  }

  @Put(':pageType')
  @Permissions('MANAGE_SETTINGS')
  upsert(
    @CurrentAdmin() admin: RequestAdmin,
    @Param('pageType') pageType: string,
    @Body() dto: UpsertContentPageDto,
    @Query('operatorId') operatorId?: string,
  ) {
    const opId = admin.operatorId ? admin.operatorId : (operatorId ?? null);
    const isPlatformAdmin = !admin.operatorId;
    return this.svc.upsert(admin.adminId, opId, parsePageType(pageType), dto, { isPlatformAdmin });
  }
}

/** Platform-level defaults: Super Admin reads/writes platform-wide pages (operatorId null). */
@Controller('platform/content-pages')
@UseGuards(JwtAdminGuard, PermissionsGuard)
export class ContentPagesPlatformController {
  constructor(private readonly svc: ContentPagesService) {}

  @Get(':pageType')
  @Permissions('MANAGE_OPERATORS')
  get(@Param('pageType') pageType: string) {
    return this.svc.get(null, parsePageType(pageType));
  }

  @Put(':pageType')
  @Permissions('MANAGE_OPERATORS')
  upsert(@CurrentAdmin() admin: RequestAdmin, @Param('pageType') pageType: string, @Body() dto: UpsertContentPageDto) {
    return this.svc.upsert(admin.adminId, null, parsePageType(pageType), dto, { isPlatformAdmin: true });
  }
}

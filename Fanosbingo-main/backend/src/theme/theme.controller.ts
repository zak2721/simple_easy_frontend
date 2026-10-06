import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsString } from 'class-validator';
import { JwtPlayerGuard } from '../common/guards/jwt-player.guard';
import { JwtAdminGuard } from '../common/guards/jwt-admin.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentAdmin, RequestAdmin } from '../common/decorators/current-user.decorator';
import { ThemeService } from './theme.service';
import { StorageService } from '../storage/storage.service';
import { CreateThemeDto, UpdateThemeDto } from './dto/theme.dto';

class UploadThemeAssetDto {
  @IsString()
  fileBase64!: string;

  @IsIn(['logo', 'banner'])
  kind!: 'logo' | 'banner';
}

/** Public (player) — the theme picker's list of options. */
@Controller('themes')
@UseGuards(JwtPlayerGuard)
export class ThemeController {
  constructor(private readonly themes: ThemeService) {}

  @Get()
  list() {
    return this.themes.listActive();
  }
}

/** Admin management — create/edit/delete/activate/deactivate/set-default. */
@Controller('admin/themes')
@UseGuards(JwtAdminGuard, PlatformAdminGuard, PermissionsGuard)
export class AdminThemeController {
  constructor(
    private readonly themes: ThemeService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  @Permissions('VIEW_THEMES')
  list() {
    return this.themes.listAllForAdmin();
  }

  /** Uploads a logo/banner image, returning a public URL to pass as logoUrl/bannerUrl on create/update. */
  @Post('upload')
  @Permissions('MANAGE_THEMES')
  async upload(@Body() dto: UploadThemeAssetDto) {
    const { path: relPath } = await this.storage.savePublicAsset(dto.fileBase64, 'theme-assets');
    return { url: `/api/storage/public/${relPath}` };
  }

  @Post()
  @Permissions('MANAGE_THEMES')
  create(@CurrentAdmin() admin: RequestAdmin, @Body() dto: CreateThemeDto) {
    return this.themes.create(dto, admin.adminId);
  }

  @Patch(':id')
  @Permissions('MANAGE_THEMES')
  update(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: UpdateThemeDto) {
    return this.themes.update(id, dto, admin.adminId);
  }

  @Delete(':id')
  @Permissions('MANAGE_THEMES')
  remove(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string) {
    return this.themes.remove(id, admin.adminId);
  }

  @Post(':id/activate')
  @Permissions('MANAGE_THEMES')
  activate(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string) {
    return this.themes.activate(id, admin.adminId);
  }

  @Post(':id/deactivate')
  @Permissions('MANAGE_THEMES')
  deactivate(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string) {
    return this.themes.deactivate(id, admin.adminId);
  }

  @Post(':id/set-default')
  @Permissions('MANAGE_THEMES')
  setDefault(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string) {
    return this.themes.setDefault(id, admin.adminId);
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { StorageService } from '../storage/storage.service';
import { OperatorsService } from '../operators/operators.service';
import { ThemeService } from '../theme/theme.service';
import { tenantSetConfigOp } from '../common/tenant/rls';

const MAX_BANNERS = 5;

/**
 * Operator branding. The name, logo and theme are the fields the spec puts
 * behind Super Admin approval: operators change them through ApprovalsService,
 * whose handlers call the apply* methods below (the Super Admin can call them
 * directly). Welcome message and banners apply immediately.
 */
@Injectable()
export class BrandingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly storage: StorageService,
    private readonly operators: OperatorsService,
    private readonly themes: ThemeService,
  ) {}

  private async row(operatorId: string) {
    const op = await this.prisma.operator.findUnique({ where: { id: operatorId }, include: { branding: { include: { theme: true } } } });
    if (!op) throw new NotFoundException('Operator not found');
    // Branding rows exist for every operator (migration + create); recreate defensively if one was ever lost.
    const branding = op.branding ?? (await this.prisma.operatorBranding.create({ data: { operatorId, displayName: op.name }, include: { theme: true } }));
    return { op, branding };
  }

  async get(operatorId: string) {
    const { op, branding } = await this.row(operatorId);
    return {
      operatorId,
      slug: op.slug,
      displayName: branding.displayName,
      logoUrl: branding.logoUrl,
      theme: branding.theme ? { id: branding.theme.id, name: branding.theme.name } : null,
      welcomeMessage: branding.welcomeMessage,
      bannerUrls: branding.bannerUrls,
      updatedAt: branding.updatedAt,
    };
  }

  /** Unauthenticated splash/branding for the Mini App before login. */
  async publicBranding(slug: string | undefined) {
    const op = await this.operators.resolveForPlayer(slug);
    const { branding } = await this.row(op.id);
    return {
      slug: op.slug,
      name: branding.displayName,
      logoUrl: branding.logoUrl,
      welcomeMessage: branding.welcomeMessage,
      bannerUrls: branding.bannerUrls,
      theme: await this.themes.getEffectiveTheme(null, op.id),
    };
  }

  /** Current values, used as the staleness snapshot for approval requests. */
  async snapshot(operatorId: string) {
    const { branding } = await this.row(operatorId);
    return { displayName: branding.displayName, logoUrl: branding.logoUrl, themeId: branding.themeId };
  }

  async applyName(actingAdminId: string, operatorId: string, displayName: string) {
    const name = displayName.trim();
    if (name.length < 2 || name.length > 80) throw new BadRequestException('Name must be 2–80 characters');
    const before = await this.snapshot(operatorId);
    await this.prisma.$transaction([
      tenantSetConfigOp(this.prisma, operatorId),
      this.prisma.operator.update({ where: { id: operatorId }, data: { name } }),
      this.prisma.operatorBranding.update({ where: { operatorId }, data: { displayName: name } }),
    ]);
    // Also the operator's YENA_BINGO_NAME setting, which the game config / lobby show.
    await this.settings.set('YENA_BINGO_NAME', name, actingAdminId, operatorId);
    this.operators.invalidate(operatorId);
    await this.log(actingAdminId, operatorId, 'BRANDING_NAME_CHANGED', { displayName: before.displayName }, { displayName: name });
  }

  async applyLogo(actingAdminId: string, operatorId: string, logoUrl: string | null) {
    if (logoUrl !== null && !logoUrl.startsWith('/api/storage/public/')) throw new BadRequestException('Logo must be uploaded through the branding upload endpoint');
    const before = await this.snapshot(operatorId);
    await this.prisma.operatorBranding.update({ where: { operatorId }, data: { logoUrl } });
    await this.log(actingAdminId, operatorId, 'BRANDING_LOGO_CHANGED', { logoUrl: before.logoUrl }, { logoUrl });
  }

  async applyTheme(actingAdminId: string, operatorId: string, themeId: string | null) {
    if (themeId) {
      const theme = await this.prisma.theme.findUnique({ where: { id: themeId } });
      if (!theme || !theme.isActive || (theme.operatorId && theme.operatorId !== operatorId)) throw new BadRequestException('Theme not available');
    }
    const before = await this.snapshot(operatorId);
    await this.prisma.operatorBranding.update({ where: { operatorId }, data: { themeId } });
    await this.log(actingAdminId, operatorId, 'BRANDING_THEME_CHANGED', { themeId: before.themeId }, { themeId });
  }

  async updateDirect(actingAdminId: string, operatorId: string, patch: { welcomeMessage?: string | null; bannerUrls?: string[] }) {
    if (patch.bannerUrls) {
      if (patch.bannerUrls.length > MAX_BANNERS) throw new BadRequestException(`At most ${MAX_BANNERS} banners`);
      if (patch.bannerUrls.some((u) => !u.startsWith('/api/storage/public/'))) throw new BadRequestException('Banners must be uploaded through the branding upload endpoint');
    }
    const { branding } = await this.row(operatorId);
    await this.prisma.operatorBranding.update({
      where: { operatorId },
      data: { welcomeMessage: patch.welcomeMessage, bannerUrls: patch.bannerUrls },
    });
    await this.log(
      actingAdminId,
      operatorId,
      'BRANDING_UPDATED',
      { welcomeMessage: branding.welcomeMessage, bannerUrls: branding.bannerUrls },
      { welcomeMessage: patch.welcomeMessage ?? branding.welcomeMessage, bannerUrls: patch.bannerUrls ?? branding.bannerUrls },
    );
  }

  /** Stores an uploaded logo/banner image and returns its public URL (to submit as a logo or banner). */
  async uploadAsset(operatorId: string, fileBase64: string) {
    const { path } = await this.storage.savePublicAsset(fileBase64, `operator-assets/${operatorId}`);
    return { url: `/api/storage/public/${path.replace(/\\/g, '/')}` };
  }

  private async log(actingAdminId: string, operatorId: string, action: string, previousState: unknown, newState: unknown) {
    await this.audit.log({ actorType: 'admin', adminId: actingAdminId, operatorId, action, entityType: 'operator_branding', entityId: operatorId, previousState, newState });
  }
}

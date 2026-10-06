import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateThemeDto, UpdateThemeDto } from './dto/theme.dto';
import { tenantSetConfigOp } from '../common/tenant/rls';

/**
 * Matches src/index.css's current :root values exactly — the resolution
 * fallback of last resort, so a fresh/misconfigured DB (no seeded default
 * theme yet) never breaks the app's appearance.
 */
const HARDCODED_FALLBACK = {
  id: null as string | null,
  name: 'Classic Bingo',
  primaryColor: '#12a150',
  secondaryColor: '#0b7d3e',
  backgroundColor: '#0b1220',
  textColor: '#e8edf6',
  surfaceColor: '#131c2e',
  surfaceAltColor: '#1b2740',
  mutedTextColor: '#93a1b8',
  accentColor: '#ffd166',
  buttonBackgroundColor: '#0b7d3e',
  buttonTextColor: '#ffffff',
  logoUrl: null as string | null,
  bannerUrl: null as string | null,
};

@Injectable()
export class ThemeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Active themes for the player's theme picker. */
  listActive() {
    return this.prisma.theme.findMany({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
  }

  listAllForAdmin() {
    return this.prisma.theme.findMany({ orderBy: { createdAt: 'asc' } });
  }

  /**
   * Resolution order: the user's own selection (if still active) -> a theme
   * currently inside its scheduled window (if any — overlaps are rejected at
   * write time, so at most one can ever match) -> the catalog's isDefault
   * theme -> the hardcoded fallback. Computed live on every call, not cached
   * or cron-flipped, so an admin deactivating/rescheduling a theme takes
   * effect on the very next request with no extra moving parts.
   */
  async getEffectiveTheme(userId: string | null, operatorId?: string) {
    let opId = operatorId;
    if (userId) {
      const user = await this.prisma.telegramUser.findUnique({ where: { id: userId }, select: { selectedTheme: true, operatorId: true } });
      opId ??= user?.operatorId;
      if (user?.selectedTheme?.isActive) return this.withOperatorBranding(user.selectedTheme, opId);
    }
    return this.withOperatorBranding(await this.baseTheme(opId), opId);
  }

  /**
   * An operator's own branding wins over the platform catalog: its chosen
   * theme (unless the player picked one), and its logo / first banner, which
   * the Mini App already renders from theme.logoUrl / theme.bannerUrl.
   */
  private async withOperatorBranding<T extends { logoUrl: string | null; bannerUrl: string | null }>(theme: T, operatorId: string | undefined): Promise<T> {
    if (!operatorId) return theme;
    const branding = await this.prisma.operatorBranding.findUnique({ where: { operatorId }, select: { logoUrl: true, bannerUrls: true } });
    if (!branding) return theme;
    return { ...theme, logoUrl: branding.logoUrl ?? theme.logoUrl, bannerUrl: branding.bannerUrls[0] ?? theme.bannerUrl };
  }

  private async baseTheme(operatorId: string | undefined) {
    if (operatorId) {
      const branding = await this.prisma.operatorBranding.findUnique({ where: { operatorId }, select: { theme: true } });
      if (branding?.theme?.isActive) return branding.theme;
    }

    const now = new Date();
    const scheduled = await this.prisma.theme.findFirst({
      where: { isActive: true, scheduledStartAt: { lte: now }, scheduledEndAt: { gte: now } },
    });
    if (scheduled) return scheduled;

    const def = await this.prisma.theme.findFirst({ where: { isDefault: true, isActive: true } });
    if (def) return def;

    return HARDCODED_FALLBACK;
  }

  /** Rejects a schedule window that overlaps any other active theme's window — an explicit 409 beats a silently-losing theme. */
  private async assertNoScheduleOverlap(params: { start?: Date; end?: Date; excludeId?: string }) {
    if (!params.start && !params.end) return;
    const conflict = await this.prisma.theme.findFirst({
      where: {
        isActive: true,
        scheduledStartAt: { not: null },
        ...(params.excludeId ? { id: { not: params.excludeId } } : {}),
        AND: [
          params.end ? { scheduledStartAt: { lte: params.end } } : {},
          params.start ? { scheduledEndAt: { gte: params.start } } : {},
        ],
      },
    });
    if (conflict) throw new ConflictException(`Schedule window overlaps theme "${conflict.name}"`);
  }

  async create(dto: CreateThemeDto, adminId: string) {
    const start = dto.scheduledStartAt ? new Date(dto.scheduledStartAt) : undefined;
    const end = dto.scheduledEndAt ? new Date(dto.scheduledEndAt) : undefined;
    await this.assertNoScheduleOverlap({ start, end });

    const theme = await this.prisma.theme.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        primaryColor: dto.primaryColor,
        secondaryColor: dto.secondaryColor,
        backgroundColor: dto.backgroundColor,
        textColor: dto.textColor,
        surfaceColor: dto.surfaceColor,
        surfaceAltColor: dto.surfaceAltColor,
        mutedTextColor: dto.mutedTextColor,
        accentColor: dto.accentColor,
        buttonBackgroundColor: dto.buttonBackgroundColor,
        buttonTextColor: dto.buttonTextColor,
        logoUrl: dto.logoUrl,
        bannerUrl: dto.bannerUrl,
        scheduledStartAt: start,
        scheduledEndAt: end,
      },
    });
    await this.audit.log({
      actorType: 'admin',
      adminId,
      action: 'THEME_CREATED',
      entityType: 'theme',
      entityId: theme.id,
      newState: { name: theme.name, slug: theme.slug },
    });
    return theme;
  }

  async update(id: string, dto: UpdateThemeDto, adminId: string) {
    const previous = await this.prisma.theme.findUnique({ where: { id } });
    if (!previous) throw new NotFoundException('Theme not found');

    const start = dto.scheduledStartAt !== undefined ? (dto.scheduledStartAt ? new Date(dto.scheduledStartAt) : null) : undefined;
    const end = dto.scheduledEndAt !== undefined ? (dto.scheduledEndAt ? new Date(dto.scheduledEndAt) : null) : undefined;
    if (start || end) {
      await this.assertNoScheduleOverlap({
        start: start ?? previous.scheduledStartAt ?? undefined,
        end: end ?? previous.scheduledEndAt ?? undefined,
        excludeId: id,
      });
    }

    const theme = await this.prisma.theme.update({
      where: { id },
      data: {
        name: dto.name,
        primaryColor: dto.primaryColor,
        secondaryColor: dto.secondaryColor,
        backgroundColor: dto.backgroundColor,
        textColor: dto.textColor,
        surfaceColor: dto.surfaceColor,
        surfaceAltColor: dto.surfaceAltColor,
        mutedTextColor: dto.mutedTextColor,
        accentColor: dto.accentColor,
        buttonBackgroundColor: dto.buttonBackgroundColor,
        buttonTextColor: dto.buttonTextColor,
        logoUrl: dto.logoUrl,
        bannerUrl: dto.bannerUrl,
        isActive: dto.isActive,
        scheduledStartAt: start,
        scheduledEndAt: end,
      },
    });
    await this.audit.log({
      actorType: 'admin',
      adminId,
      action: 'THEME_UPDATED',
      entityType: 'theme',
      entityId: id,
      previousState: { name: previous.name, isActive: previous.isActive },
      newState: { name: theme.name, isActive: theme.isActive },
    });
    return theme;
  }

  async remove(id: string, adminId: string) {
    const theme = await this.prisma.theme.findUnique({ where: { id } });
    if (!theme) throw new NotFoundException('Theme not found');
    if (theme.isDefault) throw new ForbiddenException('Cannot delete the default theme — set another theme as default first');

    await this.prisma.theme.delete({ where: { id } });
    await this.audit.log({
      actorType: 'admin',
      adminId,
      action: 'THEME_DELETED',
      entityType: 'theme',
      entityId: id,
      previousState: { name: theme.name },
    });
    return { success: true };
  }

  async activate(id: string, adminId: string) {
    const theme = await this.prisma.theme.update({ where: { id }, data: { isActive: true } });
    await this.audit.log({ actorType: 'admin', adminId, action: 'THEME_ACTIVATED', entityType: 'theme', entityId: id });
    return theme;
  }

  async deactivate(id: string, adminId: string) {
    const theme = await this.prisma.theme.findUnique({ where: { id } });
    if (!theme) throw new NotFoundException('Theme not found');
    if (theme.isDefault) throw new ForbiddenException('Cannot deactivate the default theme — set another theme as default first');

    const updated = await this.prisma.theme.update({ where: { id }, data: { isActive: false } });
    await this.audit.log({ actorType: 'admin', adminId, action: 'THEME_DEACTIVATED', entityType: 'theme', entityId: id });
    return updated;
  }

  /** Atomically unsets the previous default and sets this one — the app-layer equivalent of a "single flagged row" constraint. */
  async setDefault(id: string, adminId: string) {
    const [, , theme] = await this.prisma.$transaction([
      tenantSetConfigOp(this.prisma, null),
      this.prisma.theme.updateMany({ where: { isDefault: true, NOT: { id } }, data: { isDefault: false } }),
      this.prisma.theme.update({ where: { id }, data: { isDefault: true, isActive: true } }),
    ]);
    await this.audit.log({ actorType: 'admin', adminId, action: 'THEME_SET_DEFAULT', entityType: 'theme', entityId: id });
    return theme;
  }
}

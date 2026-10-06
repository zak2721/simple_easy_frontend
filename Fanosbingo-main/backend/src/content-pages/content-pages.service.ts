import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ContentPageType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ApprovalsService } from '../operator-management/approvals.service';
import type { ApprovalType } from '../operator-management/approval-policy';

/** Page types that require Super Admin approval when an operator requests a change. */
const APPROVAL_REQUIRED: ReadonlySet<ContentPageType> = new Set<ContentPageType>([
  ContentPageType.TERMS_AND_CONDITIONS,
  ContentPageType.RESPONSIBLE_GAMING,
]);

/** Maps a ContentPageType to its ApprovalType key. */
const PAGE_APPROVAL_TYPE: Record<ContentPageType, ApprovalType> = {
  TERMS_AND_CONDITIONS: 'CONTENT_PAGE_TERMS',
  RESPONSIBLE_GAMING: 'CONTENT_PAGE_RESPONSIBLE_GAMING',
  ABOUT: 'CONTENT_PAGE_ABOUT',
  GAME_INSTRUCTIONS: 'CONTENT_PAGE_GAME_INSTRUCTIONS',
};

/**
 * Content pages are long-form Markdown documents attached to an operator (or
 * platform-wide when operatorId is null).
 *
 * Read: operator-scoped page → fall back to the platform default (operatorId
 * null) if the operator hasn't customized it yet.
 *
 * Write: legal/sensitive pages (Terms, Responsible Gaming) from an operator
 * account go through the ApprovalRequest workflow; all others are direct.
 * Platform admins write all pages directly regardless of type.
 */
@Injectable()
export class ContentPagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  /** Returns the operator-specific page, or the platform default if none exists. */
  async get(operatorId: string | null, pageType: ContentPageType) {
    if (operatorId) {
      const own = await this.prisma.operatorContentPage.findUnique({
        where: { operatorId_pageType: { operatorId, pageType } },
      });
      if (own) return own;
    }
    // Fall back to platform default (operatorId null)
    const fallback = await this.prisma.operatorContentPage.findUnique({
      where: { operatorId_pageType: { operatorId: null as unknown as string, pageType } },
    });
    return fallback ?? null;
  }

  /** Returns all content pages visible to a player (operator-specific with platform fallback). */
  async listForPlayer(operatorId: string): Promise<Record<ContentPageType, { title: string; bodyMarkdown: string } | null>> {
    const types = Object.values(ContentPageType);
    const entries = await Promise.all(types.map((t) => this.get(operatorId, t)));
    return Object.fromEntries(
      types.map((t, i) => [t, entries[i] ? { title: entries[i]!.title, bodyMarkdown: entries[i]!.bodyMarkdown } : null]),
    ) as Record<ContentPageType, { title: string; bodyMarkdown: string } | null>;
  }

  /**
   * Write a content page. If `requiresApproval` is true (legal pages from an
   * operator account), this submits an ApprovalRequest instead of writing
   * directly. Platform admins always write directly regardless of page type.
   */
  async upsert(
    actingAdminId: string,
    operatorId: string | null,
    pageType: ContentPageType,
    dto: { title: string; bodyMarkdown: string },
    opts: { isPlatformAdmin: boolean },
  ) {
    const needsApproval = !opts.isPlatformAdmin && operatorId !== null && APPROVAL_REQUIRED.has(pageType);

    if (needsApproval) {
      // Route through approval workflow — stores a pending request
      return this.approvals.submit(actingAdminId, operatorId!, PAGE_APPROVAL_TYPE[pageType], pageType, {
        title: dto.title,
        bodyMarkdown: dto.bodyMarkdown,
      });
    }

    return this.applyDirect(actingAdminId, operatorId, pageType, dto);
  }

  /** Applies a content page update directly (used by approval handler + direct writes). */
  async applyDirect(
    actingAdminId: string,
    operatorId: string | null,
    pageType: ContentPageType,
    dto: { title: string; bodyMarkdown: string },
  ) {
    const before = await this.prisma.operatorContentPage.findUnique({
      where: { operatorId_pageType: { operatorId: operatorId as unknown as string, pageType } },
      select: { title: true, bodyMarkdown: true },
    });

    const page = await this.prisma.operatorContentPage.upsert({
      where: { operatorId_pageType: { operatorId: operatorId as unknown as string, pageType } },
      create: {
        operatorId: operatorId as unknown as string,
        pageType,
        title: dto.title,
        bodyMarkdown: dto.bodyMarkdown,
        updatedByAdminId: actingAdminId,
      },
      update: {
        title: dto.title,
        bodyMarkdown: dto.bodyMarkdown,
        updatedAt: new Date(),
        updatedByAdminId: actingAdminId,
      },
    });

    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId: operatorId ?? undefined,
      action: 'CONTENT_PAGE_UPDATED',
      entityType: 'operator_content_page',
      entityId: page.id,
      previousState: before ?? undefined,
      newState: { title: dto.title, bodyMarkdown: dto.bodyMarkdown },
    });

    return page;
  }

  /** Validates a content page proposal (used by ApprovalsService handler). */
  static validate(proposed: Record<string, unknown>): { title: string; bodyMarkdown: string } {
    const title = String(proposed.title ?? '').trim();
    const bodyMarkdown = String(proposed.bodyMarkdown ?? '').trim();
    if (!title || title.length > 200) throw new BadRequestException('Title is required (max 200 characters)');
    if (!bodyMarkdown) throw new BadRequestException('Body is required');
    if (bodyMarkdown.length > 100_000) throw new BadRequestException('Body must be ≤ 100,000 characters');
    return { title, bodyMarkdown };
  }

  async getOrThrow(operatorId: string | null, pageType: ContentPageType) {
    const page = await this.get(operatorId, pageType);
    if (!page) throw new NotFoundException(`Content page ${pageType} not found`);
    return page;
  }
}

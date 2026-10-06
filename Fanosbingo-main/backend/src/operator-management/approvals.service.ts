import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ApprovalStatus, ContentPageType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BrandingService } from './branding.service';
import { RoomsService, type NewRoom } from './rooms.service';
import { APPROVAL_TYPES, validateRuleSetting, type ApprovalType } from './approval-policy';
import { setTenantOnTx } from '../common/tenant/rls';

type Json = Prisma.InputJsonValue;

interface Handler {
  /** Live value now — stored at submission and compared again at approval. */
  current(operatorId: string, targetKey: string): Promise<Json>;
  /** Normalizes/validates the proposal; throws BadRequest if invalid. */
  validate(operatorId: string, targetKey: string, proposed: Record<string, unknown>): Promise<Json>;
  /** Applies the change through the same service method a direct change uses. */
  apply(reviewerId: string, operatorId: string, targetKey: string, proposed: Record<string, unknown>): Promise<void>;
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * Operator changes that need Super Admin approval: submit -> pending ->
 * approve (applied) / reject / cancel / superseded by a newer submission.
 * Rows are never deleted and never change once decided (DB trigger).
 */
@Injectable()
export class ApprovalsService {
  private readonly handlers: Record<ApprovalType, Handler>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly branding: BrandingService,
    private readonly rooms: RoomsService,
  ) {
    const brandingField = (field: 'displayName' | 'logoUrl' | 'themeId'): Handler['current'] => async (operatorId) => {
      const snap = await this.branding.snapshot(operatorId);
      return { [field]: snap[field] } as Json;
    };
    this.handlers = {
      BRANDING_NAME: {
        current: brandingField('displayName'),
        validate: async (_op, _t, p) => {
          const name = String(p.displayName ?? '').trim();
          if (name.length < 2 || name.length > 80) throw new BadRequestException('Name must be 2–80 characters');
          return { displayName: name };
        },
        apply: (reviewer, op, _t, p) => this.branding.applyName(reviewer, op, String(p.displayName)),
      },
      BRANDING_LOGO: {
        current: brandingField('logoUrl'),
        validate: async (_op, _t, p) => {
          const url = p.logoUrl === null ? null : String(p.logoUrl ?? '');
          if (url !== null && !url.startsWith('/api/storage/public/')) throw new BadRequestException('Upload the logo first, then submit its URL');
          return { logoUrl: url };
        },
        apply: (reviewer, op, _t, p) => this.branding.applyLogo(reviewer, op, (p.logoUrl as string | null) ?? null),
      },
      BRANDING_THEME: {
        current: brandingField('themeId'),
        validate: async (op, _t, p) => {
          const themeId = p.themeId === null ? null : String(p.themeId ?? '');
          if (themeId) {
            const theme = await this.prisma.theme.findUnique({ where: { id: themeId } });
            if (!theme || !theme.isActive || (theme.operatorId && theme.operatorId !== op)) throw new BadRequestException('Theme not available');
          }
          return { themeId };
        },
        apply: (reviewer, op, _t, p) => this.branding.applyTheme(reviewer, op, (p.themeId as string | null) ?? null),
      },
      ROOM_CREATE: {
        current: async (op, code) => ({ exists: Boolean(await this.prisma.operatorRoom.findUnique({ where: { operatorId_code: { operatorId: op, code } } })) }),
        validate: async (_op, code, p) => {
          const room: NewRoom = {
            code,
            name: String(p.name ?? '').trim(),
            price: Number(p.price),
            capacity: Number(p.capacity),
            maxPerPlayer: p.maxPerPlayer === undefined || p.maxPerPlayer === null ? null : Number(p.maxPerPlayer),
          };
          if (!/^[a-z0-9_-]{1,32}$/.test(code)) throw new BadRequestException('Room code: lowercase letters, digits, _ or -');
          if (!room.name || room.name.length > 60) throw new BadRequestException('Room name is required (max 60 characters)');
          if (!(room.price > 0)) throw new BadRequestException('Price must be greater than 0');
          if (!Number.isInteger(room.capacity) || room.capacity < 1 || room.capacity > 10000) throw new BadRequestException('Capacity must be 1–10000');
          return room as unknown as Json;
        },
        apply: async (reviewer, op, _t, p) => {
          await this.rooms.createRoom(reviewer, op, p as unknown as NewRoom);
        },
      },
      ROOM_CAPACITY_INCREASE: {
        current: async (op, roomId) => ({ capacity: (await this.rooms.getRoom(op, roomId)).capacity }),
        validate: async (op, roomId, p) => {
          const capacity = Number(p.capacity);
          const room = await this.rooms.getRoom(op, roomId);
          if (!Number.isInteger(capacity) || capacity <= room.capacity || capacity > 10000) {
            throw new BadRequestException(`New capacity must be a whole number above the current ${room.capacity} (max 10000)`);
          }
          return { capacity };
        },
        apply: async (reviewer, op, roomId, p) => {
          await this.rooms.setCapacity(reviewer, op, roomId, Number(p.capacity));
        },
      },
      SETTING_CHANGE: {
        current: async (op, key) => ({ value: await this.settings.get(key, op) }),
        validate: async (_op, key, p) => ({ key, value: validateRuleSetting(key, String(p.value ?? '')) }),
        apply: (reviewer, op, key, p) => this.settings.set(key, String(p.value), reviewer, op),
      },
      // Phase 8c — content pages: legal pages route here from ContentPagesService; informational ones are direct
      ...this.buildContentPageHandlers(),
    };
  }

  private buildContentPageHandlers(): Record<'CONTENT_PAGE_TERMS' | 'CONTENT_PAGE_RESPONSIBLE_GAMING' | 'CONTENT_PAGE_ABOUT' | 'CONTENT_PAGE_GAME_INSTRUCTIONS', Handler> {
    const PAGE_TYPE_MAP: Record<string, ContentPageType> = {
      CONTENT_PAGE_TERMS: ContentPageType.TERMS_AND_CONDITIONS,
      CONTENT_PAGE_RESPONSIBLE_GAMING: ContentPageType.RESPONSIBLE_GAMING,
      CONTENT_PAGE_ABOUT: ContentPageType.ABOUT,
      CONTENT_PAGE_GAME_INSTRUCTIONS: ContentPageType.GAME_INSTRUCTIONS,
    };

    const makeHandler = (approvalKey: string): Handler => ({
      current: async (operatorId) => {
        const pageType = PAGE_TYPE_MAP[approvalKey];
        const own = await this.prisma.operatorContentPage.findUnique({
          where: { operatorId_pageType: { operatorId, pageType } },
          select: { title: true, bodyMarkdown: true },
        });
        return (own ?? { title: null, bodyMarkdown: null }) as Json;
      },
      validate: async (_op, _key, p) => {
        const title = String(p.title ?? '').trim();
        const bodyMarkdown = String(p.bodyMarkdown ?? '').trim();
        if (!title || title.length > 200) throw new BadRequestException('Title is required (max 200 characters)');
        if (!bodyMarkdown) throw new BadRequestException('Body is required');
        if (bodyMarkdown.length > 100_000) throw new BadRequestException('Body must be ≤ 100,000 characters');
        return { title, bodyMarkdown } as unknown as Json;
      },
      apply: async (reviewerId, operatorId, _key, p) => {
        const pageType = PAGE_TYPE_MAP[approvalKey];
        const { title, bodyMarkdown } = p as unknown as { title: string; bodyMarkdown: string };
        const page = await this.prisma.operatorContentPage.upsert({
          where: { operatorId_pageType: { operatorId, pageType } },
          create: { operatorId, pageType, title, bodyMarkdown, updatedByAdminId: reviewerId },
          update: { title, bodyMarkdown, updatedAt: new Date(), updatedByAdminId: reviewerId },
        });
        await this.audit.log({
          actorType: 'admin',
          adminId: reviewerId,
          operatorId,
          action: 'CONTENT_PAGE_UPDATED',
          entityType: 'operator_content_page',
          entityId: page.id,
          newState: { title, bodyMarkdown },
        });
      },
    });

    return {
      CONTENT_PAGE_TERMS: makeHandler('CONTENT_PAGE_TERMS'),
      CONTENT_PAGE_RESPONSIBLE_GAMING: makeHandler('CONTENT_PAGE_RESPONSIBLE_GAMING'),
      CONTENT_PAGE_ABOUT: makeHandler('CONTENT_PAGE_ABOUT'),
      CONTENT_PAGE_GAME_INSTRUCTIONS: makeHandler('CONTENT_PAGE_GAME_INSTRUCTIONS'),
    };
  }

  private handler(type: string): Handler {
    const h = this.handlers[type as ApprovalType];
    if (!h) throw new BadRequestException(`Unknown approval type: ${type}`);
    return h;
  }

  /** Stores a pending request, superseding any older pending request for the same (type, target). */
  async submit(submitterId: string, operatorId: string, type: ApprovalType, targetKey: string, proposed: Record<string, unknown>) {
    const h = this.handler(type);
    const [current, normalized] = await Promise.all([h.current(operatorId, targetKey), h.validate(operatorId, targetKey, proposed)]);
    if (type !== 'ROOM_CREATE' && stableJson(current) === stableJson(this.comparable(type, normalized))) {
      throw new BadRequestException('That is already the current value');
    }
    if (type === 'ROOM_CREATE' && (current as { exists: boolean }).exists) throw new ConflictException(`A room with code "${targetKey}" already exists`);

    const request = await this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx, operatorId);
      await tx.approvalRequest.updateMany({
        where: { operatorId, type, targetKey, status: 'pending' },
        data: { status: 'superseded', reviewNote: 'Replaced by a newer request' },
      });
      return tx.approvalRequest.create({
        data: { operatorId, type, targetKey, currentValue: current, proposedValue: normalized, submittedByAdminId: submitterId },
      });
    });

    await this.audit.log({
      actorType: 'admin',
      adminId: submitterId,
      operatorId,
      action: 'APPROVAL_SUBMITTED',
      entityType: 'approval_request',
      entityId: request.id,
      previousState: current,
      newState: { type, targetKey, proposed: normalized },
    });
    const op = await this.prisma.operator.findUnique({ where: { id: operatorId }, select: { slug: true } });
    await this.notifications.notifyPlatform({
      type: 'APPROVAL_PENDING',
      severity: 'info',
      title: `${op?.slug ?? 'An operator'}: ${APPROVAL_TYPES[type]} awaiting approval`,
      body: this.describe(type, targetKey, normalized),
      operatorId,
      relatedEntityType: 'approval_request',
      relatedEntityId: request.id,
    });
    return { pendingApproval: true, request: this.serialize(request) };
  }

  /** The part of a proposal comparable with `current` (for "no change" detection). */
  private comparable(type: ApprovalType, normalized: Json): Json {
    if (type === 'SETTING_CHANGE') return { value: (normalized as { value: string }).value };
    return normalized;
  }

  private describe(type: ApprovalType, targetKey: string, proposed: Json): string {
    const p = proposed as Record<string, unknown>;
    switch (type) {
      case 'BRANDING_NAME': return `New name: ${p.displayName}`;
      case 'BRANDING_LOGO': return 'New logo uploaded';
      case 'BRANDING_THEME': return `New theme: ${p.themeId ?? 'platform default'}`;
      case 'ROOM_CREATE': return `Room "${p.name}" (${targetKey}): ${p.capacity} cartelas at ${p.price} ETB`;
      case 'ROOM_CAPACITY_INCREASE': return `Capacity -> ${p.capacity}`;
      case 'SETTING_CHANGE': return `${targetKey} = ${p.value}`;
      case 'CONTENT_PAGE_TERMS': return `Terms & Conditions: "${p.title}"`;
      case 'CONTENT_PAGE_RESPONSIBLE_GAMING': return `Responsible Gaming: "${p.title}"`;
      case 'CONTENT_PAGE_ABOUT': return `About page: "${p.title}"`;
      case 'CONTENT_PAGE_GAME_INSTRUCTIONS': return `Game Instructions: "${p.title}"`;
    }
  }

  private serialize(r: Prisma.ApprovalRequestGetPayload<object>) {
    return {
      id: r.id,
      operatorId: r.operatorId,
      type: r.type,
      label: APPROVAL_TYPES[r.type as ApprovalType] ?? r.type,
      targetKey: r.targetKey,
      currentValue: r.currentValue,
      proposedValue: r.proposedValue,
      status: r.status,
      submittedByAdminId: r.submittedByAdminId,
      submittedAt: r.submittedAt,
      reviewedByAdminId: r.reviewedByAdminId,
      reviewedAt: r.reviewedAt,
      reviewNote: r.reviewNote,
      appliedAt: r.appliedAt,
    };
  }

  async list(params: { operatorId?: string | null; status?: string; limit?: number }) {
    const status = params.status && params.status in ApprovalStatus ? (params.status as ApprovalStatus) : undefined;
    const rows = await this.prisma.approvalRequest.findMany({
      where: { ...(params.operatorId ? { operatorId: params.operatorId } : {}), ...(status ? { status } : {}) },
      orderBy: { submittedAt: 'desc' },
      take: Math.min(params.limit ?? 200, 1000),
      include: { operator: { select: { slug: true, name: true } } },
    });
    return rows.map((r) => ({ ...this.serialize(r), operator: r.operator }));
  }

  /**
   * Applies a pending request. Refuses to apply if the live value changed
   * since submission (the operator saw a different "before"). Two reviewers
   * can't both apply it: a reviewer first claims the pending row.
   */
  async approve(reviewerId: string, requestId: string, note?: string) {
    const request = await this.prisma.approvalRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Approval request not found');
    if (request.status !== 'pending') throw new ConflictException(`This request is already ${request.status}`);

    const claim = await this.prisma.approvalRequest.updateMany({
      where: { id: requestId, status: 'pending', reviewedByAdminId: null },
      data: { reviewedByAdminId: reviewerId },
    });
    if (claim.count === 0) throw new ConflictException('Another reviewer is handling this request');

    const type = request.type as ApprovalType;
    const h = this.handler(type);
    const proposed = request.proposedValue as Record<string, unknown>;
    try {
      const live = await h.current(request.operatorId, request.targetKey);
      if (stableJson(live) !== stableJson(request.currentValue)) {
        await this.decide(request.id, 'rejected', reviewerId, 'The current value changed after this was submitted — submit it again if still wanted');
        await this.afterDecision(request, 'rejected', reviewerId, 'stale');
        throw new ConflictException('The current value changed after this request was submitted, so it was not applied');
      }
      await h.apply(reviewerId, request.operatorId, request.targetKey, proposed);
    } catch (e) {
      if (!(e instanceof ConflictException)) {
        // Apply failed (e.g. a limit is now exceeded): release the claim, leave it pending so it can be rejected or retried.
        await this.prisma.approvalRequest.updateMany({ where: { id: requestId, status: 'pending' }, data: { reviewedByAdminId: null } });
      }
      throw e;
    }

    await this.decide(request.id, 'approved', reviewerId, note, true);
    await this.afterDecision(request, 'approved', reviewerId, note);
    return { id: request.id, status: 'approved' };
  }

  async reject(reviewerId: string, requestId: string, note: string) {
    if (!note || note.trim().length < 3) throw new BadRequestException('A reason is required to reject');
    const request = await this.prisma.approvalRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Approval request not found');
    const done = await this.prisma.approvalRequest.updateMany({
      where: { id: requestId, status: 'pending' },
      data: { status: 'rejected', reviewedByAdminId: reviewerId, reviewedAt: new Date(), reviewNote: note },
    });
    if (done.count === 0) throw new ConflictException('This request is no longer pending');
    await this.afterDecision(request, 'rejected', reviewerId, note);
    return { id: request.id, status: 'rejected' };
  }

  /** The operator withdraws its own pending request. */
  async cancel(actorId: string, operatorId: string, requestId: string) {
    const done = await this.prisma.approvalRequest.updateMany({
      where: { id: requestId, operatorId, status: 'pending' },
      data: { status: 'cancelled', reviewedAt: new Date(), reviewNote: 'Cancelled by the operator' },
    });
    if (done.count === 0) throw new NotFoundException('No pending request with that id');
    await this.audit.log({ actorType: 'admin', adminId: actorId, operatorId, action: 'APPROVAL_CANCELLED', entityType: 'approval_request', entityId: requestId });
    return { id: requestId, status: 'cancelled' };
  }

  private async decide(id: string, status: 'approved' | 'rejected', reviewerId: string, note?: string, applied = false) {
    await this.prisma.approvalRequest.update({
      where: { id },
      data: { status, reviewedByAdminId: reviewerId, reviewedAt: new Date(), reviewNote: note ?? null, ...(applied ? { appliedAt: new Date() } : {}) },
    });
  }

  private async afterDecision(request: { id: string; operatorId: string; type: string; targetKey: string; proposedValue: Prisma.JsonValue }, status: 'approved' | 'rejected', reviewerId: string, note?: string) {
    const type = request.type as ApprovalType;
    await this.audit.log({
      actorType: 'admin',
      adminId: reviewerId,
      operatorId: request.operatorId,
      action: status === 'approved' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
      entityType: 'approval_request',
      entityId: request.id,
      newState: { type, targetKey: request.targetKey, proposed: request.proposedValue },
      reason: note,
    });
    await this.notifications.notifyOperator(request.operatorId, {
      type: status === 'approved' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
      severity: status === 'approved' ? 'info' : 'warning',
      title: `${APPROVAL_TYPES[type] ?? type} ${status}`,
      body: status === 'rejected' && note ? `Reason: ${note}` : this.describe(type, request.targetKey, request.proposedValue as Json),
      relatedEntityType: 'approval_request',
      relatedEntityId: request.id,
    });
  }
}

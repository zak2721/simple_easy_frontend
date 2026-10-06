import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { setTenantOnTx, tenantSetConfigOp } from '../common/tenant/rls';

const MAX_MESSAGE_LENGTH = 4000;
const MAX_SUBJECT_LENGTH = 200;

/**
 * Player support tickets, scoped to the player's own operator (a ticket
 * belongs to the same operator as its player — enforced by the DB trigger
 * assert_operator_matches_player, same backstop as deposits/withdrawals).
 * Messages are append-only (immutability trigger): a conversation is a
 * record of what was said, not an editable document.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ----- Player side -----

  async create(userId: string, operatorId: string, subject: string, firstMessage: string) {
    const s = subject.trim();
    const m = firstMessage.trim();
    if (!s || s.length > MAX_SUBJECT_LENGTH) throw new BadRequestException(`Subject must be 1–${MAX_SUBJECT_LENGTH} characters`);
    if (!m || m.length > MAX_MESSAGE_LENGTH) throw new BadRequestException(`Message must be 1–${MAX_MESSAGE_LENGTH} characters`);

    const ticket = await this.prisma.$transaction(async (tx) => {
      await setTenantOnTx(tx, operatorId);
      const created = await tx.supportTicket.create({
        data: { operatorId, telegramUserId: userId, subject: s },
      });
      await tx.supportTicketMessage.create({
        data: { ticketId: created.id, authorType: 'player', authorId: userId, body: m },
      });
      return created;
    });

    await this.notifications.notifyOperator(operatorId, {
      type: 'SUPPORT_TICKET_OPENED',
      title: `New support ticket: ${s}`,
      relatedEntityType: 'support_ticket',
      relatedEntityId: ticket.id,
    });
    return this.getForPlayer(userId, ticket.id);
  }

  async listForPlayer(userId: string) {
    return this.prisma.supportTicket.findMany({
      where: { telegramUserId: userId },
      orderBy: { lastMessageAt: 'desc' },
      select: { id: true, subject: true, status: true, priority: true, createdAt: true, lastMessageAt: true },
    });
  }

  async getForPlayer(userId: string, ticketId: string) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id: ticketId, telegramUserId: userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  /** A player can add to open/pending tickets; a resolved/closed ticket is read-only (reopen by creating a new one, or an admin reopens it). */
  async replyAsPlayer(userId: string, ticketId: string, body: string) {
    const ticket = await this.prisma.supportTicket.findFirst({ where: { id: ticketId, telegramUserId: userId } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.status === 'resolved' || ticket.status === 'closed') {
      throw new ForbiddenException('This ticket is closed — open a new one if you still need help');
    }
    return this.addMessage(ticket.id, 'player', userId, body, ticket.status === 'pending' ? 'open' : undefined);
  }

  // ----- Admin side -----

  async listForAdmin(operatorId: string, status?: string) {
    const rows = await this.prisma.supportTicket.findMany({
      where: { operatorId, ...(status ? { status: status as never } : {}) },
      orderBy: { lastMessageAt: 'desc' },
      include: { user: { select: { telegramUserId: true, username: true, firstName: true } } },
    });
    return rows.map((t) => ({ ...t, user: { ...t.user, telegramUserId: Number(t.user.telegramUserId) } }));
  }

  async getForAdmin(operatorId: string, ticketId: string) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id: ticketId, operatorId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        user: { select: { telegramUserId: true, username: true, firstName: true } },
      },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    // BigInt doesn't serialize to JSON — every other admin listing in this codebase converts it at the boundary too.
    return { ...ticket, user: { ...ticket.user, telegramUserId: Number(ticket.user.telegramUserId) } };
  }

  async replyAsAdmin(adminId: string, operatorId: string, ticketId: string, body: string) {
    const ticket = await this.prisma.supportTicket.findFirst({ where: { id: ticketId, operatorId } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    // Replying moves an open ticket to pending (awaiting the player), matching the usual helpdesk convention.
    return this.addMessage(ticket.id, 'admin', adminId, body, ticket.status === 'open' ? 'pending' : undefined);
  }

  async setStatus(adminId: string, operatorId: string, ticketId: string, status: 'open' | 'pending' | 'resolved' | 'closed') {
    const ticket = await this.prisma.supportTicket.findFirst({ where: { id: ticketId, operatorId } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    const updated = await this.prisma.supportTicket.update({ where: { id: ticket.id }, data: { status } });
    await this.audit.log({
      actorType: 'admin',
      adminId,
      operatorId,
      action: 'SUPPORT_TICKET_STATUS_CHANGED',
      entityType: 'support_ticket',
      entityId: ticket.id,
      previousState: { status: ticket.status },
      newState: { status },
    });
    return updated;
  }

  async assign(adminId: string, operatorId: string, ticketId: string, assignedAdminId: string | null) {
    const ticket = await this.prisma.supportTicket.findFirst({ where: { id: ticketId, operatorId } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (assignedAdminId) {
      const assignee = await this.prisma.adminUser.findFirst({ where: { id: assignedAdminId, operatorId } });
      if (!assignee) throw new BadRequestException('That admin does not belong to this operator');
    }
    const updated = await this.prisma.supportTicket.update({ where: { id: ticket.id }, data: { assignedAdminId } });
    await this.audit.log({
      actorType: 'admin',
      adminId,
      operatorId,
      action: 'SUPPORT_TICKET_ASSIGNED',
      entityType: 'support_ticket',
      entityId: ticket.id,
      newState: { assignedAdminId },
    });
    return updated;
  }

  private async addMessage(ticketId: string, authorType: 'player' | 'admin', authorId: string, body: string, nextStatus?: 'open' | 'pending') {
    const b = body.trim();
    if (!b || b.length > MAX_MESSAGE_LENGTH) throw new BadRequestException(`Message must be 1–${MAX_MESSAGE_LENGTH} characters`);
    const [, message] = await this.prisma.$transaction([
      tenantSetConfigOp(this.prisma),
      this.prisma.supportTicketMessage.create({ data: { ticketId, authorType, authorId, body: b } }),
      this.prisma.supportTicket.update({
        where: { id: ticketId },
        data: { lastMessageAt: new Date(), ...(nextStatus ? { status: nextStatus } : {}) },
      }),
    ]);
    return message;
  }
}

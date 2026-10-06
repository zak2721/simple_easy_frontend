import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Operator } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_OPERATOR_ID, DEFAULT_OPERATOR_SLUG } from '../common/operator.constants';
import { decryptSecret } from '../common/crypto/secret-box';

const CACHE_TTL_MS = 10_000;

/**
 * Operator lookup + per-operator Telegram credentials. Hot paths (every
 * login, every bot webhook, every 4s engine tick) go through a short cache;
 * status changes (suspend) therefore take effect within CACHE_TTL_MS, or
 * immediately when the writer calls invalidate().
 */
@Injectable()
export class OperatorsService {
  private byId = new Map<string, { op: Operator; at: number }>();
  private activeList: { ops: Operator[]; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  invalidate(operatorId?: string): void {
    if (operatorId) this.byId.delete(operatorId);
    else this.byId.clear();
    this.activeList = null;
  }

  async get(operatorId: string): Promise<Operator> {
    const hit = this.byId.get(operatorId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.op;
    const op = await this.prisma.operator.findUnique({ where: { id: operatorId } });
    if (!op) throw new NotFoundException('Operator not found');
    this.byId.set(op.id, { op, at: Date.now() });
    return op;
  }

  async getBySlug(slug: string): Promise<Operator> {
    for (const { op, at } of this.byId.values()) {
      if (op.slug === slug && Date.now() - at < CACHE_TTL_MS) return op;
    }
    const op = await this.prisma.operator.findUnique({ where: { slug } });
    if (!op) throw new NotFoundException('Operator not found');
    this.byId.set(op.id, { op, at: Date.now() });
    return op;
  }

  /** Resolves the operator a player is entering through; no slug = the default operator. Rejects non-active operators. */
  async resolveForPlayer(slug: string | undefined): Promise<Operator> {
    const op = await (slug && slug !== DEFAULT_OPERATOR_SLUG ? this.getBySlug(slug) : this.get(DEFAULT_OPERATOR_ID));
    this.assertActive(op);
    return op;
  }

  assertActive(op: Operator): void {
    if (op.status !== 'active') throw new ForbiddenException('This bingo is currently unavailable');
  }

  async listActive(): Promise<Operator[]> {
    if (this.activeList && Date.now() - this.activeList.at < CACHE_TTL_MS) return this.activeList.ops;
    const ops = await this.prisma.operator.findMany({ where: { status: 'active' }, orderBy: { createdAt: 'asc' } });
    this.activeList = { ops, at: Date.now() };
    for (const op of ops) this.byId.set(op.id, { op, at: Date.now() });
    return ops;
  }

  isDefault(operatorId: string): boolean {
    return operatorId === DEFAULT_OPERATOR_ID;
  }

  /** The default operator uses the platform bot from env; every other operator must bring its own. Empty string = not configured. */
  botToken(op: Operator): string {
    if (this.isDefault(op.id)) return this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? '';
    if (!op.botTokenEncrypted) return '';
    return decryptSecret(op.botTokenEncrypted, this.config.get<string>('PLATFORM_ENCRYPTION_KEY'));
  }

  botUsername(op: Operator): string {
    if (this.isDefault(op.id)) return this.config.get<string>('TELEGRAM_BOT_USERNAME') ?? '';
    return op.botUsername ?? '';
  }

  webhookSecret(op: Operator): string {
    if (this.isDefault(op.id)) return this.config.get<string>('TELEGRAM_WEBHOOK_SECRET') ?? '';
    return op.webhookSecret ?? '';
  }

  /** Public Mini App URL for this operator: the base URL for the default operator, `<base>/o/<slug>` for the rest. */
  appUrl(op: Operator): string {
    const base = (this.config.get<string>('YENA_BINGO_APP_URL') ?? '').replace(/\/$/, '');
    if (!base) return '';
    return this.isDefault(op.id) ? base : `${base}/o/${op.slug}`;
  }
}

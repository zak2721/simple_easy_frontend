import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LimitsService } from '../operator-management/limits.service';
import { OperatorsService } from '../operators/operators.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Subscription plan management — named bundles of OperatorLimit values + feature
 * flags. "Applying a plan" calls the existing LimitsService.set() with the plan's
 * limits bundle: the subscription system is a named shortcut for "set several limits
 * at once." Enforcement stays in each service that calls LimitsService.get().
 *
 * See docs/YENA_BINGO_SAAS_PLATFORM_ARCHITECTURE.md §5.
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly limits: LimitsService,
    private readonly operators: OperatorsService,
    private readonly notifications: NotificationsService,
  ) {}

  listPlans() {
    return this.prisma.subscriptionPlan.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { operators: true } } },
    });
  }

  async getPlan(planId: string) {
    const plan = await this.prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Subscription plan not found');
    return plan;
  }

  async createPlan(
    actingAdminId: string,
    dto: {
      key: string;
      name: string;
      monthlyPriceMinor?: number;
      currency?: string;
      limits: Record<string, number>;
      features?: string[];
    },
  ) {
    const plan = await this.prisma.subscriptionPlan.create({
      data: {
        key: dto.key,
        name: dto.name,
        monthlyPriceMinor: dto.monthlyPriceMinor ?? null,
        currency: dto.currency ?? 'ETB',
        limits: dto.limits,
        features: dto.features ?? [],
        isActive: true,
      },
    });
    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      action: 'SUBSCRIPTION_PLAN_CREATED',
      entityType: 'subscription_plan',
      entityId: plan.id,
      newState: { key: plan.key, name: plan.name, limits: plan.limits, features: plan.features },
    });
    return plan;
  }

  async updatePlan(
    actingAdminId: string,
    planId: string,
    dto: {
      name?: string;
      monthlyPriceMinor?: number | null;
      currency?: string;
      limits?: Record<string, number>;
      features?: string[];
      isActive?: boolean;
    },
  ) {
    const before = await this.getPlan(planId);
    const plan = await this.prisma.subscriptionPlan.update({
      where: { id: planId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.monthlyPriceMinor !== undefined && { monthlyPriceMinor: dto.monthlyPriceMinor }),
        ...(dto.currency !== undefined && { currency: dto.currency }),
        ...(dto.limits !== undefined && { limits: dto.limits }),
        ...(dto.features !== undefined && { features: dto.features }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      action: 'SUBSCRIPTION_PLAN_UPDATED',
      entityType: 'subscription_plan',
      entityId: planId,
      previousState: { name: before.name, limits: before.limits, features: before.features, isActive: before.isActive },
      newState: { name: plan.name, limits: plan.limits, features: plan.features, isActive: plan.isActive },
    });
    return plan;
  }

  async getOperatorSubscription(operatorId: string) {
    const op = await this.prisma.operator.findUnique({
      where: { id: operatorId },
      include: { subscriptionPlan: true },
    });
    if (!op) throw new NotFoundException('Operator not found');
    return {
      operatorId: op.id,
      plan: op.subscriptionPlan,
      status: op.subscriptionStatus,
      startedAt: op.subscriptionStartedAt,
      expiresAt: op.subscriptionExpiresAt,
    };
  }

  /**
   * Assign a plan to an operator. Applying a plan sets the operator's OperatorLimit rows to match
   * the plan's limits bundle — calling the existing LimitsService.set() so the same
   * enforcement path is used by both direct limit edits and plan assignments.
   */
  async assignPlan(
    actingAdminId: string,
    operatorId: string,
    planId: string,
    opts?: { status?: 'trialing' | 'active' | 'past_due' | 'cancelled'; expiresAt?: Date },
  ) {
    const [plan, op] = await Promise.all([this.getPlan(planId), this.operators.get(operatorId)]);

    const planLimits = plan.limits as Record<string, number>;
    if (Object.keys(planLimits).length > 0) {
      await this.limits.set(actingAdminId, operatorId, planLimits);
    }

    const status = opts?.status ?? 'active';
    await this.prisma.operator.update({
      where: { id: operatorId },
      data: {
        subscriptionPlanId: planId,
        subscriptionStatus: status,
        subscriptionStartedAt: status === 'active' ? new Date() : undefined,
        subscriptionExpiresAt: opts?.expiresAt ?? null,
      },
    });
    this.operators.invalidate(operatorId);

    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId,
      action: 'SUBSCRIPTION_PLAN_ASSIGNED',
      entityType: 'operator',
      entityId: operatorId,
      previousState: { subscriptionPlanId: op.subscriptionPlanId, subscriptionStatus: op.subscriptionStatus },
      newState: { subscriptionPlanId: planId, subscriptionStatus: status, planKey: plan.key },
    });
    await this.notifications.notifyOperator(operatorId, {
      type: 'SUBSCRIPTION_PLAN_ASSIGNED',
      title: `Subscription plan updated: ${plan.name}`,
      body: `Your account is now on the ${plan.name} plan.`,
    });
    return { operatorId, planId, planKey: plan.key, status };
  }

  async setSubscriptionStatus(
    actingAdminId: string,
    operatorId: string,
    status: 'trialing' | 'active' | 'past_due' | 'cancelled',
    expiresAt?: Date,
  ) {
    const op = await this.operators.get(operatorId);
    await this.prisma.operator.update({
      where: { id: operatorId },
      data: { subscriptionStatus: status, ...(expiresAt !== undefined && { subscriptionExpiresAt: expiresAt }) },
    });
    this.operators.invalidate(operatorId);
    await this.audit.log({
      actorType: 'admin',
      adminId: actingAdminId,
      operatorId,
      action: 'SUBSCRIPTION_STATUS_CHANGED',
      entityType: 'operator',
      entityId: operatorId,
      previousState: { subscriptionStatus: op.subscriptionStatus },
      newState: { subscriptionStatus: status },
    });
    return { operatorId, status };
  }

  async listPayments(operatorId?: string) {
    return this.prisma.subscriptionPayment.findMany({
      where: operatorId ? { operatorId } : undefined,
      include: { operator: { select: { name: true, slug: true } }, plan: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async recordPayment(dto: { operatorId: string; planId: string; amountMinor: number; currency?: string; periodStart: Date; periodEnd: Date; status?: string; notes?: string; paidAt?: Date }) {
    const payment = await this.prisma.subscriptionPayment.create({
      data: {
        operatorId: dto.operatorId,
        planId: dto.planId,
        amountMinor: dto.amountMinor,
        currency: dto.currency ?? 'ETB',
        status: dto.status ?? 'paid',
        periodStart: dto.periodStart,
        periodEnd: dto.periodEnd,
        paidAt: dto.paidAt ?? (dto.status === 'paid' || dto.status === undefined ? new Date() : null),
        notes: dto.notes,
      },
    });
    return payment;
  }

  async platformRevenueSummary() {
    const [total, byPlan, recent] = await Promise.all([
      this.prisma.subscriptionPayment.aggregate({
        where: { status: 'paid' },
        _sum: { amountMinor: true },
        _count: true,
      }),
      this.prisma.subscriptionPayment.groupBy({
        by: ['planId'],
        where: { status: 'paid' },
        _sum: { amountMinor: true },
        _count: true,
      }),
      this.prisma.subscriptionPayment.findMany({
        where: { status: 'paid' },
        include: { operator: { select: { name: true } }, plan: { select: { name: true } } },
        orderBy: { paidAt: 'desc' },
        take: 10,
      }),
    ]);
    return { total, byPlan, recent };
  }

  /** Returns true when the operator's active plan includes the named feature flag. */
  async hasFeature(operatorId: string, feature: string): Promise<boolean> {
    const op = await this.prisma.operator.findUnique({
      where: { id: operatorId },
      include: { subscriptionPlan: true },
    });
    if (!op?.subscriptionPlan) return false;
    return (op.subscriptionPlan.features as string[]).includes(feature);
  }
}

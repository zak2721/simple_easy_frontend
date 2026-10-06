import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAdminGuard } from '../common/guards/jwt-admin.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestAdmin } from '../common/decorators/current-user.decorator';
import { SubscriptionsService } from './subscriptions.service';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

class CreatePlanDto {
  @IsString()
  @Matches(/^[a-z0-9_-]{1,40}$/)
  key!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyPriceMinor?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsObject()
  limits!: Record<string, number>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  features?: string[];
}

class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyPriceMinor?: number | null;

  @IsOptional()
  @IsObject()
  limits?: Record<string, number>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  features?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class AssignPlanDto {
  @IsString()
  @IsOptional()
  @IsIn(['trialing', 'active', 'past_due', 'cancelled'])
  status?: 'trialing' | 'active' | 'past_due' | 'cancelled';

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

class SetStatusDto {
  @IsIn(['trialing', 'active', 'past_due', 'cancelled'])
  status!: 'trialing' | 'active' | 'past_due' | 'cancelled';

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

class RecordPaymentDto {
  @IsString()
  operatorId!: string;

  @IsString()
  planId!: string;

  @IsInt()
  @Min(0)
  amountMinor!: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsDateString()
  periodStart!: string;

  @IsDateString()
  periodEnd!: string;

  @IsOptional()
  @IsIn(['pending', 'paid', 'failed', 'refunded'])
  status?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsDateString()
  paidAt?: string;
}

@Controller('platform/subscriptions')
@UseGuards(JwtAdminGuard, PermissionsGuard)
@Permissions('MANAGE_OPERATORS')
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Get('plans')
  listPlans() {
    return this.subs.listPlans();
  }

  @Post('plans')
  createPlan(@CurrentUser() admin: RequestAdmin, @Body() dto: CreatePlanDto) {
    return this.subs.createPlan(admin.adminId, dto);
  }

  @Patch('plans/:planId')
  updatePlan(@CurrentUser() admin: RequestAdmin, @Param('planId') planId: string, @Body() dto: UpdatePlanDto) {
    return this.subs.updatePlan(admin.adminId, planId, dto);
  }

  @Get('operators/:operatorId')
  getOperatorSubscription(@Param('operatorId') operatorId: string) {
    return this.subs.getOperatorSubscription(operatorId);
  }

  @Post('operators/:operatorId/plans/:planId')
  assignPlan(@CurrentUser() admin: RequestAdmin, @Param('operatorId') operatorId: string, @Param('planId') planId: string, @Body() dto: AssignPlanDto) {
    return this.subs.assignPlan(admin.adminId, operatorId, planId, {
      status: dto.status,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
    });
  }

  @Patch('operators/:operatorId/status')
  setStatus(@CurrentUser() admin: RequestAdmin, @Param('operatorId') operatorId: string, @Body() dto: SetStatusDto) {
    return this.subs.setSubscriptionStatus(admin.adminId, operatorId, dto.status, dto.expiresAt ? new Date(dto.expiresAt) : undefined);
  }

  @Get('payments')
  listPayments(@Query('operatorId') operatorId?: string) {
    return this.subs.listPayments(operatorId);
  }

  @Post('payments')
  recordPayment(@Body() dto: RecordPaymentDto) {
    return this.subs.recordPayment({
      operatorId: dto.operatorId,
      planId: dto.planId,
      amountMinor: dto.amountMinor,
      currency: dto.currency,
      periodStart: new Date(dto.periodStart),
      periodEnd: new Date(dto.periodEnd),
      status: dto.status,
      notes: dto.notes,
      paidAt: dto.paidAt ? new Date(dto.paidAt) : undefined,
    });
  }

  @Get('revenue')
  platformRevenueSummary() {
    return this.subs.platformRevenueSummary();
  }
}

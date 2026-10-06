import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtPlayerGuard } from '../common/guards/jwt-player.guard';
import { JwtAdminGuard } from '../common/guards/jwt-admin.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentAdmin, CurrentUser, RequestAdmin, RequestPlayer } from '../common/decorators/current-user.decorator';
import { OperatorsService } from '../operators/operators.service';
import { readScope } from '../common/tenant/operator-scope';
import { ReferralsService } from './referrals.service';
import { toCsv } from '../common/csv';

@Controller('referrals')
@UseGuards(JwtPlayerGuard)
export class ReferralsController {
  constructor(
    private readonly referrals: ReferralsService,
    private readonly operators: OperatorsService,
  ) {}

  /**
   * Links point at the player's OWN operator's bot and Mini App: a friend
   * invited through them must land in the same operator, or the referral is
   * (correctly) ignored as cross-operator.
   */
  @Get('me')
  async me(@CurrentUser() player: RequestPlayer) {
    const operator = await this.operators.get(player.operatorId);
    const botUsername = this.operators.botUsername(operator);
    const appUrl = this.operators.appUrl(operator);
    const stats = await this.referrals.myStats(player.userId);
    return {
      // Primary: Telegram deep link — the only format that actually opens the
      // Mini App from inside Telegram (surfaced to it as start_param).
      link: botUsername ? `https://t.me/${botUsername}?start=ref_${stats.referralCode}` : '',
      // Secondary: a plain web link for sharing outside Telegram.
      web_link: appUrl ? `${appUrl}?ref=${stats.referralCode}` : '',
      referral_code: stats.referralCode,
      totalReferred: stats.totalReferred,
      successfulReferred: stats.successfulReferred,
      earnedEtb: stats.earnedEtb,
    };
  }

  @Get('me/history')
  history(@CurrentUser() player: RequestPlayer) {
    return this.referrals.myHistory(player.userId);
  }
}

@Controller('admin/referrals')
@UseGuards(JwtAdminGuard, PermissionsGuard)
export class AdminReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  @Get()
  @Permissions('VIEW_REFERRALS')
  list(@CurrentAdmin() admin: RequestAdmin, @Query('take') take?: string, @Query('skip') skip?: string, @Query('operatorId') operatorId?: string) {
    return this.referrals.listForAdmin(take ? Number(take) : 100, skip ? Number(skip) : 0, readScope(admin, operatorId));
  }

  @Get('reports')
  @Permissions('VIEW_REFERRAL_REPORTS')
  reports(@CurrentAdmin() admin: RequestAdmin, @Query('from') from?: string, @Query('to') to?: string, @Query('operatorId') operatorId?: string) {
    return this.referrals.reportSummary({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      operatorId: readScope(admin, operatorId),
    });
  }

  @Get('reports/export.csv')
  @Permissions('EXPORT_REPORTS')
  async exportCsv(
    @CurrentAdmin() admin: RequestAdmin,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('operatorId') operatorId: string | undefined,
    @Res() res: Response,
  ) {
    const rows = await this.referrals.exportRows({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      operatorId: readScope(admin, operatorId),
    });
    const csv = toCsv(rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="referral-report.csv"');
    res.send(csv);
  }
}

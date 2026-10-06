import { Body, Controller, ForbiddenException, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAdminGuard } from '../common/guards/jwt-admin.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentAdmin, RequestAdmin } from '../common/decorators/current-user.decorator';
import { AdminService } from './admin.service';
import { FinanceService } from './finance.service';
import { AlertsService } from './alerts.service';
import { TelegramService } from '../telegram/telegram.service';
import { DepositsService } from '../deposits/deposits.service';
import { WithdrawalsService } from '../withdrawals/withdrawals.service';
import { AuditService } from '../audit/audit.service';
import { WalletService } from '../wallet/wallet.service';
import { SettingsService } from '../settings/settings.service';
import { CardsService } from '../cards/cards.service';
import { GamesService } from '../games/games.service';
import { toCsv } from '../common/csv';
import { readScope, writeTarget } from '../common/tenant/operator-scope';
import { OPERATOR_APPROVAL_REQUIRED_SETTINGS } from '../common/rbac.constants';
import { ApprovalsService } from '../operator-management/approvals.service';
import { REROUTED_SETTINGS } from '../operator-management/approval-policy';
import { PlayerStatus } from '@prisma/client';
import {
  ReviewDepositDto,
  ReviewWithdrawalDto,
  UpdateSettingDto,
  AdjustWalletDto,
  UpdateHousePercentageDto,
  FinancialReportQueryDto,
  SetupWebhookDto,
  SetPlayerStatusDto,
} from './dto/admin.dto';
import { RegenerateCartelaDto } from '../cards/dto/cards.dto';

/** Settings that must go through their own dedicated, reason-required, Super-Admin-only endpoint — never the generic settings editor (spec §9). */
const HOUSE_SETTINGS_KEYS = new Set(['HOUSE_PERCENTAGE', 'WINNER_PERCENTAGE']);

function requirePermission(admin: RequestAdmin, key: string) {
  if (!admin.permissions.includes('*') && !admin.permissions.includes(key)) {
    throw new ForbiddenException(`Missing permission: ${key}`);
  }
}

function requireSuperAdmin(admin: RequestAdmin) {
  if (!admin.roles.includes('SUPER_ADMIN')) {
    throw new ForbiddenException('Only the Super Admin can perform this action');
  }
}

@Controller('admin')
@UseGuards(JwtAdminGuard, PermissionsGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly finance: FinanceService,
    private readonly alerts: AlertsService,
    private readonly deposits: DepositsService,
    private readonly withdrawals: WithdrawalsService,
    private readonly audit: AuditService,
    private readonly wallet: WalletService,
    private readonly settings: SettingsService,
    private readonly cards: CardsService,
    private readonly games: GamesService,
    private readonly telegram: TelegramService,
    private readonly approvals: ApprovalsService,
  ) {}

  @Get('dashboard')
  @Permissions('VIEW_DASHBOARD')
  dashboard(@CurrentAdmin() admin: RequestAdmin, @Query('operatorId') operatorId?: string) {
    return this.admin.dashboard(readScope(admin, operatorId));
  }

  /** Today / This Week / This Month / All-Time financial snapshot — spec §4. */
  @Get('finance/dashboard')
  @Permissions('VIEW_DASHBOARD')
  financialDashboard(@CurrentAdmin() admin: RequestAdmin, @Query('operatorId') operatorId?: string) {
    return this.finance.dashboard(readScope(admin, operatorId));
  }

  @Get('cartelas')
  @Permissions('VIEW_BINGO_CARDS')
  cartelas(@CurrentAdmin() admin: RequestAdmin, @Query('operatorId') operatorId?: string) {
    return this.admin.cartelas(writeTarget(admin, operatorId));
  }

  @Get('players/:telegramUserId/cartelas')
  @Permissions('VIEW_USERS')
  playerCartelas(@CurrentAdmin() admin: RequestAdmin, @Param('telegramUserId') telegramUserId: string) {
    return this.admin.playerCartelas(telegramUserId, readScope(admin));
  }

  // -------------------------------------------------------------------
  // Player account management — audit finding ADMIN-1 (Critical).
  // -------------------------------------------------------------------

  @Get('players')
  @Permissions('VIEW_USERS')
  listPlayers(
    @CurrentAdmin() admin: RequestAdmin,
    @Query('status') status?: PlayerStatus,
    @Query('search') search?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
    @Query('operatorId') operatorId?: string,
  ) {
    return this.admin.listPlayers({
      status,
      search,
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
      operatorId: readScope(admin, operatorId),
    });
  }

  /** A Telegram id is only unique within one operator: `?operatorId=` picks which (default operator if omitted). */
  @Get('players/:telegramUserId')
  @Permissions('VIEW_USERS')
  getPlayer(@CurrentAdmin() admin: RequestAdmin, @Param('telegramUserId') telegramUserId: string, @Query('operatorId') operatorId?: string) {
    return this.admin.getPlayer(writeTarget(admin, operatorId), Number(telegramUserId));
  }

  /** Reuses the existing EDIT_USERS permission key, which was defined in rbac.constants.ts but had zero backing routes before this fix. */
  @Post('players/:telegramUserId/status')
  @Permissions('EDIT_USERS')
  setPlayerStatus(
    @CurrentAdmin() admin: RequestAdmin,
    @Param('telegramUserId') telegramUserId: string,
    @Body() dto: SetPlayerStatusDto,
    @Query('operatorId') operatorId?: string,
  ) {
    return this.admin.setPlayerStatus(writeTarget(admin, operatorId), Number(telegramUserId), dto.status, dto.reason, admin.adminId);
  }

  @Post('cards/:cartelaId/regenerate')
  @Permissions('REGENERATE_BINGO_CARDS')
  regenerateCard(@CurrentAdmin() admin: RequestAdmin, @Param('cartelaId') cartelaId: string, @Body() dto: RegenerateCartelaDto) {
    return this.cards.regenerateCartela(cartelaId, admin.adminId, dto.reason, readScope(admin));
  }

  @Get('deposits')
  @Permissions('VIEW_DEPOSITS')
  async listDeposits(@CurrentAdmin() admin: RequestAdmin, @Query('status') status?: string, @Query('operatorId') operatorId?: string) {
    const deposits = await this.deposits.listForAdmin(status, readScope(admin, operatorId));
    return {
      deposits: deposits.map((d) => ({
        id: d.id,
        operator_slug: d.operator.slug,
        telegram_user_id: Number(d.user.telegramUserId),
        amount: Number(d.amount),
        receipt_file_type: d.receiptMimeType,
        receipt_url: this.deposits.getReceiptUrl(d),
        telebirr_reference: d.telebirrReference,
        notes: d.notes,
        status: d.status,
        rejection_reason: d.rejectionReason,
        submitted_at: d.submittedAt,
        reviewed_by: d.reviewedByAdminId,
      })),
    };
  }

  /** No blanket @Permissions() — approve needs APPROVE_DEPOSITS, reject needs REJECT_DEPOSITS. */
  @Post('deposits/:id/review')
  reviewDeposit(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: ReviewDepositDto) {
    requirePermission(admin, dto.decision === 'approve' ? 'APPROVE_DEPOSITS' : 'REJECT_DEPOSITS');
    return this.deposits.review(id, admin.adminId, dto.decision, dto, readScope(admin));
  }

  @Get('deposits/:id/receipt-url')
  @Permissions('VIEW_DEPOSITS')
  async depositReceiptUrl(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string) {
    const deposit = await this.deposits.findOne(id, readScope(admin));
    return { url: this.deposits.getReceiptUrl(deposit) };
  }

  @Get('withdrawals')
  @Permissions('VIEW_WITHDRAWALS')
  async listWithdrawals(@CurrentAdmin() admin: RequestAdmin, @Query('status') status?: string, @Query('operatorId') operatorId?: string) {
    const withdrawals = await this.withdrawals.listForAdmin(status, readScope(admin, operatorId));
    return {
      withdrawals: withdrawals.map((w) => ({
        id: w.id,
        operator_slug: w.operator.slug,
        telegram_user_id: Number(w.user.telegramUserId),
        amount: Number(w.amount),
        telebirr_account: w.telebirrAccount,
        account_number: w.telebirrAccount,
        proof_url: this.withdrawals.getProofUrl(w),
        notes: w.notes,
        status: w.status,
        rejection_reason: w.rejectionReason,
        requested_at: w.requestedAt,
        reviewed_by: w.reviewedByAdminId,
      })),
    };
  }

  @Get('withdrawals/:id/proof-url')
  @Permissions('VIEW_WITHDRAWALS')
  async withdrawalProofUrl(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string) {
    const withdrawal = await this.withdrawals.findOne(id, readScope(admin));
    return { url: this.withdrawals.getProofUrl(withdrawal) };
  }

  /** spec §15: sortable "everything not yet paid" view. */
  @Get('withdrawals/unpaid')
  @Permissions('VIEW_WITHDRAWALS')
  unpaidWithdrawals(
    @CurrentAdmin() admin: RequestAdmin,
    @Query('sort') sort?: 'oldest' | 'newest' | 'highest_amount' | 'longest_pending',
    @Query('operatorId') operatorId?: string,
  ) {
    return this.finance.unpaidWithdrawals(readScope(admin, operatorId), sort);
  }

  /** No blanket @Permissions() — approve/mark_paid need APPROVE_WITHDRAWALS, reject needs REJECT_WITHDRAWALS. */
  @Post('withdrawals/:id/review')
  reviewWithdrawal(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string, @Body() dto: ReviewWithdrawalDto) {
    requirePermission(admin, dto.decision === 'reject' ? 'REJECT_WITHDRAWALS' : 'APPROVE_WITHDRAWALS');
    return this.withdrawals.review(id, admin.adminId, dto.decision, dto, readScope(admin));
  }

  @Get('ledger')
  @Permissions('VIEW_REPORTS')
  async ledger(@CurrentAdmin() admin: RequestAdmin, @Query('userId') userId?: string) {
    if (!userId) return { ledger: [] };
    await this.admin.assertPlayerInScope(userId, readScope(admin));
    const entries = await this.wallet.getLedger(userId, 500);
    return {
      ledger: entries.map((e) => ({
        id: e.id,
        telegram_user_id: e.telegramUserId,
        entry_type: e.entryType,
        direction: e.direction,
        amount: Number(e.amount),
        note: e.note,
        created_at: e.createdAt,
      })),
    };
  }

  // -------------------------------------------------------------------
  // Wallet control — spec §8. Never a direct balance overwrite; every
  // adjustment goes through WalletService.adjustBalance (locked, reasoned,
  // ledgered, audited).
  // -------------------------------------------------------------------

  @Get('wallets/:telegramUserId')
  @Permissions('VIEW_WALLETS')
  walletDetail(@CurrentAdmin() admin: RequestAdmin, @Param('telegramUserId') telegramUserId: string, @Query('operatorId') operatorId?: string) {
    return this.finance.walletDetail(writeTarget(admin, operatorId), Number(telegramUserId));
  }

  @Post('wallets/:telegramUserId/adjust')
  @Permissions('ADJUST_WALLET')
  adjustWallet(
    @CurrentAdmin() admin: RequestAdmin,
    @Param('telegramUserId') telegramUserId: string,
    @Body() dto: AdjustWalletDto,
    @Query('operatorId') operatorId?: string,
  ) {
    return this.finance.adjustWallet({
      operatorId: writeTarget(admin, operatorId),
      telegramNumericId: Number(telegramUserId),
      ...dto,
      actingAdminId: admin.adminId,
    });
  }

  // -------------------------------------------------------------------
  // Game settlements — spec §10.
  // -------------------------------------------------------------------

  @Get('games/settlements')
  @Permissions('VIEW_REPORTS')
  gameSettlements(@CurrentAdmin() admin: RequestAdmin, @Query('operatorId') operatorId?: string) {
    return this.finance.gameSettlements(readScope(admin, operatorId));
  }

  // -------------------------------------------------------------------
  // Reconciliation — spec §11. Detection only; resolving a discrepancy is a
  // manual investigation followed by a normal reasoned wallet adjustment,
  // not an automated "fix" button.
  // -------------------------------------------------------------------

  @Get('reconciliation')
  @Permissions('VIEW_REPORTS')
  reconciliation(@CurrentAdmin() admin: RequestAdmin, @Query('operatorId') operatorId?: string) {
    return this.finance.reconciliation(readScope(admin, operatorId));
  }

  // -------------------------------------------------------------------
  // Financial reports — spec §14, with CSV export (spec §17).
  // -------------------------------------------------------------------

  @Get('reports/financial')
  @Permissions('VIEW_REPORTS')
  financialReport(@CurrentAdmin() admin: RequestAdmin, @Query() query: FinancialReportQueryDto) {
    // CSV is served by GET /reports/financial/export (needs EXPORT_REPORTS) — this route is always JSON.
    const range = query.from || query.to ? { from: query.from ? new Date(query.from) : undefined, to: query.to ? new Date(query.to) : undefined } : undefined;
    return this.finance.financialReport(query.period, readScope(admin, query.operatorId), range);
  }

  @Get('reports/financial/export')
  @Permissions('EXPORT_REPORTS')
  async exportFinancialReport(
    @CurrentAdmin() admin: RequestAdmin,
    @Query('period') period: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'alltime',
    @Query('operatorId') operatorId: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Res() res: Response,
  ) {
    const scope = readScope(admin, operatorId);
    const range = from || to ? { from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined } : undefined;
    const { by_operator: byOperator, ...report } = await this.finance.financialReport(period ?? 'alltime', scope, range);
    // Platform-wide export: one summary row, then one row per operator, under the same column names.
    const operatorRows = (byOperator ?? []).map((r) => ({
      scope: 'operator',
      operator: r.slug,
      period: report.period,
      generated_at: report.generated_at,
      deposits_total: r.deposits_total,
      deposits_count: r.deposits_count,
      withdrawals_paid_total: r.withdrawals_paid_total,
      withdrawals_paid_count: r.withdrawals_paid_count,
      house_revenue: r.house_revenue_total,
      winner_payouts: r.winner_payouts_total,
      refunds: r.refunds_total,
      bonus_activity: r.bonus_activity_total,
    }));
    const csv = toCsv([{ scope: 'total', operator: scope ?? 'all', ...report }, ...operatorRows]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="financial-report-${period ?? 'alltime'}.csv"`);
    res.send(csv);
  }

  @Get('exports/:kind')
  @Permissions('EXPORT_REPORTS')
  async exportRaw(
    @CurrentAdmin() admin: RequestAdmin,
    @Param('kind') kind: 'deposits' | 'withdrawals' | 'ledger' | 'audit',
    @Query('status') status: string | undefined,
    @Query('userId') userId: string | undefined,
    @Query('operatorId') operatorId: string | undefined,
    @Res() res: Response,
  ) {
    let rows: Array<Record<string, unknown>> = [];
    if (kind === 'deposits') {
      const deposits = await this.deposits.listForAdmin(status, readScope(admin, operatorId));
      rows = deposits.map((d) => ({ id: d.id, operator: d.operator.slug, telegram_user_id: Number(d.user.telegramUserId), amount: Number(d.amount), telebirr_reference: d.telebirrReference, notes: d.notes, status: d.status, submitted_at: d.submittedAt }));
    } else if (kind === 'withdrawals') {
      const withdrawals = await this.withdrawals.listForAdmin(status, readScope(admin, operatorId));
      rows = withdrawals.map((w) => ({ id: w.id, operator: w.operator.slug, telegram_user_id: Number(w.user.telegramUserId), amount: Number(w.amount), notes: w.notes, status: w.status, requested_at: w.requestedAt }));
    } else if (kind === 'ledger') {
      if (!userId) throw new ForbiddenException('?userId= is required to export a ledger');
      await this.admin.assertPlayerInScope(userId, readScope(admin));
      const entries = await this.wallet.getLedger(userId, 5000);
      rows = entries.map((e) => ({ id: e.id, entry_type: e.entryType, direction: e.direction, amount: Number(e.amount), note: e.note, created_at: e.createdAt }));
    } else if (kind === 'audit') {
      const entries = await this.audit.list({ operatorId: readScope(admin, operatorId) });
      rows = entries.map((a) => ({
        id: a.id,
        operator: a.operator?.slug ?? 'platform',
        username: a.username,
        action: a.action,
        entity_type: a.entityType,
        entity_id: a.entityId,
        created_at: a.createdAt,
        impersonated_by_username: a.impersonatedByUsername,
      }));
    }
    const csv = toCsv(rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${kind}.csv"`);
    res.send(csv);
  }

  // -------------------------------------------------------------------
  // Financial alerts — spec §16.
  // -------------------------------------------------------------------

  @Get('alerts')
  @Permissions('VIEW_FINANCIAL_ALERTS')
  listAlerts(@CurrentAdmin() admin: RequestAdmin, @Query('includeAcknowledged') includeAcknowledged?: string, @Query('operatorId') operatorId?: string) {
    return this.alerts.list(includeAcknowledged === 'true', readScope(admin, operatorId));
  }

  @Post('alerts/:id/acknowledge')
  @Permissions('VIEW_FINANCIAL_ALERTS')
  acknowledgeAlert(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string) {
    return this.alerts.acknowledge(id, admin.adminId, readScope(admin));
  }

  @Get('audit')
  @Permissions('VIEW_AUDIT_LOGS')
  async auditLog(@CurrentAdmin() admin: RequestAdmin, @Query('operatorId') operatorId?: string) {
    const entries = await this.audit.list({ operatorId: readScope(admin, operatorId) });
    return {
      audit: entries.map((a) => ({
        id: a.id,
        operator_slug: a.operator?.slug ?? null,
        admin_user_id: a.adminId,
        username: a.username,
        action: a.action,
        entity_type: a.entityType,
        entity_id: a.entityId,
        reason: a.reason,
        ip_address: a.ipAddress,
        created_at: a.createdAt,
        // Set only when this action happened during a Super Admin "viewing
        // as" session — username is the real actor, adminId/username above
        // stay the impersonated target, matching what actually changed the data.
        impersonated_by_admin_id: a.impersonatedByAdminId,
        impersonated_by_username: a.impersonatedByUsername,
      })),
    };
  }

  @Get('settings')
  @Permissions('MANAGE_SETTINGS')
  async getSettings(@CurrentAdmin() admin: RequestAdmin, @Query('operatorId') operatorId?: string) {
    return { settings: await this.settings.getAll(writeTarget(admin, operatorId)) };
  }

  /**
   * The ONLY way to change the house/winner split (spec §9). Super-Admin-only
   * (role check, not just a permission — house-cut changes affect every
   * future game's payout math), requires an explicit reason, and both the
   * old and new values are captured in the audit record automatically by
   * SettingsService.set().
   *
   * Must stay declared BEFORE `settings/:key` below — Nest matches routes in
   * declaration order, so a param route declared first would swallow this
   * literal path (`:key` = "house-percentage") and validate against the
   * wrong DTO.
   */
  @Post('settings/house-percentage')
  async updateHousePercentage(@CurrentAdmin() admin: RequestAdmin, @Body() dto: UpdateHousePercentageDto, @Query('operatorId') operatorId?: string) {
    requireSuperAdmin(admin);
    if (dto.housePercentage < 0 || dto.housePercentage > 100) {
      throw new ForbiddenException('House percentage must be between 0 and 100');
    }
    const target = writeTarget(admin, operatorId);
    const winnerPercentage = 100 - dto.housePercentage;
    await this.settings.set('HOUSE_PERCENTAGE', String(dto.housePercentage), admin.adminId, target);
    await this.settings.set('WINNER_PERCENTAGE', String(winnerPercentage), admin.adminId, target);
    await this.audit.log({
      actorType: 'admin',
      adminId: admin.adminId,
      operatorId: target,
      action: 'HOUSE_PERCENTAGE_CHANGED',
      entityType: 'settings',
      newState: { housePercentage: dto.housePercentage, winnerPercentage },
      reason: dto.reason,
    });
    return { housePercentage: dto.housePercentage, winnerPercentage };
  }

  @Post('settings/:key')
  @Permissions('MANAGE_SETTINGS')
  async updateSetting(
    @CurrentAdmin() admin: RequestAdmin,
    @Param('key') key: string,
    @Body() dto: UpdateSettingDto,
    @Query('operatorId') operatorId?: string,
  ) {
    if (HOUSE_SETTINGS_KEYS.has(key.toUpperCase())) {
      throw new ForbiddenException(`${key} can only be changed via POST /admin/settings/house-percentage (requires Super Admin + a reason)`);
    }
    // Operator accounts: spec-reserved rule changes become approval requests instead of applying now.
    const upper = key.toUpperCase();
    if (admin.operatorId && OPERATOR_APPROVAL_REQUIRED_SETTINGS.has(upper)) {
      if (REROUTED_SETTINGS[upper]) throw new ForbiddenException(REROUTED_SETTINGS[upper]);
      return this.approvals.submit(admin.adminId, admin.operatorId, 'SETTING_CHANGE', upper, { value: dto.value });
    }
    await this.settings.set(key, dto.value, admin.adminId, writeTarget(admin, operatorId));
    return { success: true };
  }

  @Post('games/:id/force-finish')
  @Permissions('UPDATE_GAMES')
  forceFinish(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string) {
    return this.games.forceFinishGame(id, admin.adminId, readScope(admin));
  }

  @Post('telegram/setup-webhook')
  @Permissions('MANAGE_SETTINGS')
  async setupTelegramWebhook(@CurrentAdmin() admin: RequestAdmin, @Body() dto: SetupWebhookDto, @Query('operatorId') operatorId?: string) {
    return this.telegram.setupWebhook(writeTarget(admin, operatorId), dto.publicApiUrl);
  }
}

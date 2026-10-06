// Admin data layer — REST calls against the NestJS backend's /api/admin and
// /api/admin-management routers. Flat per-admin RBAC: exactly one
// SUPER_ADMIN (unrestricted), any number of ADMIN accounts whose
// capabilities come from their own directly-assigned permissions.
import { adminApiClient, adminToken, apiErrorMessage } from '../lib/api-client';

export { adminToken };

async function get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  try {
    const { data } = await adminApiClient.get(path, { params });
    return data as T;
  } catch (e) {
    throw new Error(apiErrorMessage(e));
  }
}

async function post<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  try {
    const { data } = await adminApiClient.post(path, body);
    return data as T;
  } catch (e) {
    throw new Error(apiErrorMessage(e));
  }
}

async function put<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  try {
    const { data } = await adminApiClient.put(path, body);
    return data as T;
  } catch (e) {
    throw new Error(apiErrorMessage(e));
  }
}

async function patch<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  try {
    const { data } = await adminApiClient.patch(path, body);
    return data as T;
  } catch (e) {
    throw new Error(apiErrorMessage(e));
  }
}

async function del<T>(path: string): Promise<T> {
  try {
    const { data } = await adminApiClient.delete(path);
    return data as T;
  } catch (e) {
    throw new Error(apiErrorMessage(e));
  }
}

/** CSV endpoints require the admin JWT, so a plain `<a href>` won't work — fetch as a blob through the authenticated client and trigger a save. */
async function downloadCsv(path: string, filename: string): Promise<void> {
  try {
    const { data } = await adminApiClient.get(path, { responseType: 'blob' });
    const url = URL.createObjectURL(data as Blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    throw new Error(apiErrorMessage(e));
  }
}

export interface AdminMe {
  username: string;
  fullName: string;
  role: AdminRole;
  permissions: string[];
  /** Null for platform admins; set for operator owner/staff accounts. */
  operatorId: string | null;
  totpEnabled: boolean;
  impersonating: boolean;
  telegramAlertChatId: string | null;
}

export type AdminRole = 'SUPER_ADMIN' | 'ADMIN' | 'OPERATOR_OWNER' | 'OPERATOR_STAFF';

export type LoginStepResult =
  | { status: 'ok'; token: string; admin: { username: string; fullName: string; role: string } }
  | { status: 'twofa_required'; challengeToken: string };

export const adminApi = {
  bootstrap: (username: string, password: string, fullName: string, adminKey: string) =>
    post('/auth/admin/bootstrap', { username, password, fullName, adminKey }),
  /** Password step. Returns a completed session, or {status:'twofa_required', challengeToken} — call verifyTwoFactorLogin next. */
  login: async (username: string, password: string): Promise<LoginStepResult> => {
    const res = await post<LoginStepResult>('/auth/admin/login', { username, password });
    if (res.status === 'ok') adminToken.set(res.token);
    return res;
  },
  verifyTwoFactorLogin: async (challengeToken: string, code: string) => {
    const res = await post<{ status: 'ok'; token: string; admin: { username: string; fullName: string; role: string } }>('/auth/admin/2fa/login', { challengeToken, code });
    adminToken.set(res.token);
    return res;
  },
  /** Alternative to verifyTwoFactorLogin for a lost/inaccessible authenticator app. */
  verifyRecoveryLogin: async (challengeToken: string, recoveryCode: string) => {
    const res = await post<{ status: 'ok'; token: string; admin: { username: string; fullName: string; role: string } }>('/auth/admin/2fa/recovery', { challengeToken, recoveryCode });
    adminToken.set(res.token);
    return res;
  },
  me: async (): Promise<{ admin: AdminMe }> => {
    const r = await get<{ admin: { username: string; fullName: string; roles: string[]; permissions: string[]; operatorId: string | null; totpEnabled: boolean; impersonating: boolean; telegramAlertChatId: string | null } }>('/auth/admin/me');
    return {
      admin: {
        username: r.admin.username,
        fullName: r.admin.fullName,
        role: (r.admin.roles[0] as AdminRole) ?? 'ADMIN',
        permissions: r.admin.permissions,
        operatorId: r.admin.operatorId ?? null,
        totpEnabled: r.admin.totpEnabled,
        impersonating: r.admin.impersonating,
        telegramAlertChatId: r.admin.telegramAlertChatId,
      },
    };
  },
  logout: () => post('/auth/admin/logout').finally(() => adminToken.clear()),

  // ----- Two-factor authentication (own account) -----
  /** Phase 8b — first-login forced password change. The Bearer token from the must-change-password session is sent automatically by the axios interceptor. After success all sessions are revoked; the admin must log in fresh. */
  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ success: true }>('/auth/admin/change-password', { currentPassword, newPassword }),
  setupTwoFactor: () => post<{ secret: string; otpauthUrl: string }>('/auth/admin/2fa/setup'),
  /** Turns 2FA on. The response's recoveryCodes are shown exactly once — the backend only ever stores their hash after this call. */
  confirmTwoFactor: (code: string) => post<{ success: true; recoveryCodes: string[] }>('/auth/admin/2fa/confirm', { code }),
  disableTwoFactor: (password: string) => post<{ success: true }>('/auth/admin/2fa/disable', { password }),
  /** Invalidates the current recovery-code batch and issues a new one — for a lost/exhausted set. Same one-time-display rule as confirmTwoFactor. */
  regenerateRecoveryCodes: (password: string) => post<{ recoveryCodes: string[] }>('/auth/admin/2fa/recovery-codes/regenerate', { password }),
  /** Super Admin recovery path for an admin who lost their authenticator. */
  forceDisableTwoFactor: (adminId: string) => post<{ success: true }>(`/admin-management/admins/${adminId}/2fa/disable`),

  // ----- Impersonation ("view as") -----
  /** Starts a "view as" session for the target account. Sets adminToken to the impersonation token — capture the previous token first if you'll want to return to it. */
  impersonate: (adminId: string, reason?: string) =>
    post<{ status: 'ok'; token: string; accessTokenExpiresIn: number; impersonating: true; admin: { username: string; fullName: string; role: string } }>(`/admin-management/admins/${adminId}/impersonate`, { reason }).then((r) => {
      adminToken.set(r.token);
      return r;
    }),
  exitImpersonation: () => post<{ success: true }>('/auth/admin/impersonation/exit'),

  // ----- Telegram push alerts (own account) -----
  /** null/omitted chatId clears it — back to in-app only. */
  setTelegramAlertChat: (chatId: string | null) => post<{ success: true }>('/auth/admin/telegram-alerts', { chatId }),

  dashboard: () => get<{ dashboard: DashboardData }>('/admin/dashboard'),
  cartelas: () => get<CartelasData>('/admin/cartelas'),
  listDeposits: (status?: string, operatorId?: string) => get<{ deposits: DepositRow[] }>('/admin/deposits', { status, operatorId }),
  reviewDeposit: (depositId: string, decision: 'approve' | 'reject', rejectionReason?: string, adminNote?: string) =>
    post(`/admin/deposits/${depositId}/review`, { decision, rejectionReason, adminNote }),
  listWithdrawals: (status?: string, operatorId?: string) => get<{ withdrawals: WithdrawalRow[] }>('/admin/withdrawals', { status, operatorId }),
  reviewWithdrawal: (withdrawalId: string, decision: 'approve' | 'reject' | 'mark_paid', extra: { proofBase64?: string; rejectionReason?: string; adminNote?: string }) =>
    post(`/admin/withdrawals/${withdrawalId}/review`, { decision, ...extra }),
  ledger: (userId?: string) => get<{ ledger: LedgerRow[] }>('/admin/ledger', { userId }),
  audit: () => get<{ audit: AuditRow[] }>('/admin/audit'),
  receiptUrl: (id: string) => get<{ url: string | null }>(`/admin/deposits/${id}/receipt-url`),
  withdrawalProofUrl: (id: string) => get<{ url: string | null }>(`/admin/withdrawals/${id}/proof-url`),

  // Player account management — audit finding ADMIN-1 (Critical): the backend
  // route existed with zero frontend consumer until this.
  listPlayers: (params: { status?: string; search?: string; take?: number; skip?: number; operatorId?: string }) =>
    get<{ total: number; players: PlayerRow[] }>('/admin/players', params),
  getPlayer: (telegramUserId: number) => get<PlayerDetail>(`/admin/players/${telegramUserId}`),
  setPlayerStatus: (telegramUserId: number, status: 'active' | 'suspended' | 'banned', reason: string) =>
    post(`/admin/players/${telegramUserId}/status`, { status, reason }),

  settings: () => get<{ settings: Record<string, string> }>('/admin/settings'),
  updateSetting: (key: string, value: string) => post(`/admin/settings/${key}`, { value }),
  setupTelegramWebhook: (publicApiUrl: string) => post<{ webhookUrl: string; ok: boolean; description?: string }>('/admin/telegram/setup-webhook', { publicApiUrl }),

  // Admin management — Super Admin only (enforced server-side regardless of what this UI shows).
  listAdmins: () => get<AdminRow[]>('/admin-management/admins'),
  getAdmin: (id: string) => get<AdminRow & { permissions: Array<{ key: string; enabled: boolean }> }>(`/admin-management/admins/${id}`),
  createAdmin: (username: string, password: string, fullName: string, permissions: string[]) =>
    post<{ id: string; username: string; fullName: string; role: string }>('/admin-management/admins', { username, password, fullName, permissions }),
  updateAdmin: (id: string, fullName: string) => put(`/admin-management/admins/${id}`, { fullName }),
  setAdminStatus: (id: string, status: 'active' | 'suspended' | 'disabled') =>
    post(`/admin-management/admins/${id}/status`, { status }),
  deleteAdmin: (id: string) => del(`/admin-management/admins/${id}`),
  resetPassword: (id: string, newPassword: string) => post(`/admin-management/admins/${id}/reset-password`, { newPassword }),
  setPermissions: (id: string, permissions: string[]) => post(`/admin-management/admins/${id}/permissions`, { permissions }),
  togglePermission: (id: string, key: string, enabled: boolean) =>
    post(`/admin-management/admins/${id}/permissions/${key}/toggle`, { enabled }),
  listSessions: (id: string) => get(`/admin-management/admins/${id}/sessions`),
  revokeSession: (sessionId: string) => post(`/admin-management/sessions/${sessionId}/revoke`),
  adminActivity: (id: string) => get<AuditRow[]>(`/admin-management/admins/${id}/activity`),
  permissionCatalog: () => get<Array<{ id: string; key: string; description: string | null }>>('/admin-management/permissions'),

  // Financial Control Center — SUPER_ADMIN authority over deposits, withdrawals,
  // wallets, house revenue, reconciliation, and financial alerts.
  financeDashboard: () => get<FinanceDashboard>('/admin/finance/dashboard'),
  walletDetail: (telegramUserId: number) => get<WalletDetail>(`/admin/wallets/${telegramUserId}`),
  adjustWallet: (telegramUserId: number, bucket: 'deposited' | 'won' | 'bonus', amount: number, direction: 'credit' | 'debit', reason: string) =>
    post(`/admin/wallets/${telegramUserId}/adjust`, { bucket, amount, direction, reason }),
  gameSettlements: () => get<GameSettlement[]>('/admin/games/settlements'),
  reconciliation: () => get<Reconciliation>('/admin/reconciliation'),
  financialReport: (period: 'daily' | 'weekly' | 'monthly' | 'alltime') => get<FinancialReport>('/admin/reports/financial', { period }),
  downloadFinancialReportCsv: (period: 'daily' | 'weekly' | 'monthly' | 'alltime') =>
    downloadCsv(`/admin/reports/financial/export?period=${period}`, `financial-report-${period}.csv`),
  downloadRawExport: (kind: 'deposits' | 'withdrawals' | 'ledger' | 'audit', userId?: string) =>
    downloadCsv(`/admin/exports/${kind}${userId ? `?userId=${userId}` : ''}`, `${kind}-export.csv`),
  unpaidWithdrawals: (sort: 'oldest' | 'newest' | 'highest_amount' | 'longest_pending' = 'oldest') =>
    get<UnpaidWithdrawal[]>('/admin/withdrawals/unpaid', { sort }),
  financialAlerts: (includeAcknowledged = false) => get<FinancialAlert[]>('/admin/alerts', { includeAcknowledged }),
  acknowledgeAlert: (id: string) => post(`/admin/alerts/${id}/acknowledge`),
  updateHousePercentage: (housePercentage: number, reason: string) =>
    post<{ housePercentage: number; winnerPercentage: number }>('/admin/settings/house-percentage', { housePercentage, reason }),

  // Welcome bonus settings
  getBonusSettings: () => get<BonusSettings>('/admin/bonus-settings'),
  updateBonusSettings: (body: BonusSettings) => put<BonusSettings>('/admin/bonus-settings', body as unknown as Record<string, unknown>),

  // Referral reports
  referralReports: (from?: string, to?: string) => get<ReferralReport>('/admin/referrals/reports', { from, to }),
  downloadReferralReportCsv: (from?: string, to?: string) => {
    const qs = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
    return downloadCsv(`/admin/referrals/reports/export.csv${qs ? `?${qs}` : ''}`, 'referral-report.csv');
  },

  // Game rules
  gameRules: () => get<GameRuleRow[]>('/admin/game-rules'),
  createGameRule: (dto: { title: string; body: string; category?: string }) => post<GameRuleRow>('/admin/game-rules', dto),
  updateGameRule: (id: string, dto: { title?: string; body?: string; category?: string; isActive?: boolean }) =>
    patch<GameRuleRow>(`/admin/game-rules/${id}`, dto),
  deleteGameRule: (id: string) => del(`/admin/game-rules/${id}`),
  reorderGameRule: (id: string, direction: 'up' | 'down') => post<GameRuleRow[]>(`/admin/game-rules/${id}/reorder`, { direction }),

  // Contact center
  getContact: () => get<ContactRow>('/admin/contact'),
  updateContact: (dto: Partial<{ telegram: string; phone: string; whatsapp: string; email: string; supportHours: string }>) =>
    put<ContactRow>('/admin/contact', dto),

  // Themes
  themes: () => get<ThemeRow[]>('/admin/themes'),
  createTheme: (dto: Record<string, unknown>) => post<ThemeRow>('/admin/themes', dto),
  updateTheme: (id: string, dto: Record<string, unknown>) => patch<ThemeRow>(`/admin/themes/${id}`, dto),
  deleteTheme: (id: string) => del(`/admin/themes/${id}`),
  activateTheme: (id: string) => post<ThemeRow>(`/admin/themes/${id}/activate`),
  deactivateTheme: (id: string) => post<ThemeRow>(`/admin/themes/${id}/deactivate`),
  setDefaultTheme: (id: string) => post<ThemeRow>(`/admin/themes/${id}/set-default`),
  uploadThemeAsset: (fileBase64: string, kind: 'logo' | 'banner') => post<{ url: string }>('/admin/themes/upload', { fileBase64, kind }),

  // ----- Multi-operator platform: operator lifecycle (Super Admin / MANAGE_OPERATORS) -----
  listOperators: () => get<OperatorRow[]>('/platform/operators'),
  createOperator: (dto: CreateOperatorDto) => post<{ id: string; slug: string; appUrl: string; owner: { id: string; username: string }; nextStep: string; temporaryPassword?: string; mustChangePassword?: boolean }>('/platform/operators', dto as unknown as Record<string, unknown>),
  setOperatorStatus: (id: string, status: 'active' | 'suspended' | 'disabled', reason: string) => post(`/platform/operators/${id}/status`, { status, reason }),
  setOperatorGameMode: (id: string, gameMode: 'continuous' | 'scheduled') => post<{ id: string; gameMode: string }>(`/platform/operators/${id}/game-mode`, { gameMode }),
  resetOwnerPassword: (id: string, newPassword: string) => post(`/platform/operators/${id}/reset-owner-password`, { newPassword }),
  transferOwnership: (id: string, newOwnerAdminId: string, reason: string) => post(`/platform/operators/${id}/transfer-ownership`, { newOwnerAdminId, reason }),
  getOperatorBot: (id: string) => get<BotInfo>(`/platform/operators/${id}/bot`),
  configureOperatorBot: (id: string, dto: { botToken: string; publicApiUrl?: string }) => put<BotConfigResult>(`/platform/operators/${id}/bot`, dto),
  listOperatorStaff: (id: string) => get<StaffRow[]>(`/platform/operators/${id}/staff`),
  createOperatorStaff: (id: string, dto: { username: string; password: string; fullName: string; permissions: string[] }) => post<StaffRow>(`/platform/operators/${id}/staff`, dto),

  // ----- Operator self-service (owner / staff with MANAGE_STAFF etc.) -----
  getMyBot: () => get<BotInfo>('/operator/bot'),
  configureMyBot: (dto: { botToken: string; publicApiUrl?: string }) => put<BotConfigResult>('/operator/bot', dto),
  listMyStaff: () => get<StaffRow[]>('/operator/staff'),
  createMyStaff: (dto: { username: string; password?: string; fullName: string; permissions: string[] }) => post<StaffRow>('/operator/staff', dto),
  setMyStaffPermissions: (id: string, permissions: string[]) => put(`/operator/staff/${id}/permissions`, { permissions }),
  setMyStaffStatus: (id: string, status: 'active' | 'suspended' | 'disabled') => post(`/operator/staff/${id}/status`, { status }),
  resetMyStaffPassword: (id: string, newPassword: string) => post(`/operator/staff/${id}/reset-password`, { newPassword }),
  removeMyStaff: (id: string) => del(`/operator/staff/${id}`),

  loginHistory: (params: { operatorId?: string; principalId?: string; limit?: number } = {}) => get<LoginHistoryRow[]>('/admin/login-history', params),

  // ----- Rooms & inventory -----
  myInventory: () => get<InventoryResponse>('/operator/rooms'),
  createMyRoom: (dto: NewRoomDto) => post<{ pendingApproval: true; request: ApprovalRow }>('/operator/rooms', dto as unknown as Record<string, unknown>),
  updateMyRoom: (id: string, dto: Partial<{ name: string; price: number; maxPerPlayer: number | null; isActive: boolean }>) => patch<RoomRow>(`/operator/rooms/${id}`, dto),
  setMyRoomCapacity: (id: string, capacity: number) => post<RoomRow | { pendingApproval: true; request: ApprovalRow }>(`/operator/rooms/${id}/capacity`, { capacity }),
  setMySlot: (id: string, number: number, isActive: boolean, reason?: string) => patch(`/operator/rooms/${id}/slots/${number}`, { isActive, reason }),
  myLimits: () => get<LimitsRow>('/operator/limits'),

  operatorInventory: (opId: string) => get<InventoryResponse>(`/platform/operators/${opId}/rooms`),
  createOperatorRoom: (opId: string, dto: NewRoomDto) => post<RoomRow>(`/platform/operators/${opId}/rooms`, dto as unknown as Record<string, unknown>),
  updateOperatorRoom: (opId: string, roomId: string, dto: Partial<{ name: string; price: number; maxPerPlayer: number | null; isActive: boolean }>) => patch<RoomRow>(`/platform/operators/${opId}/rooms/${roomId}`, dto),
  setOperatorRoomCapacity: (opId: string, roomId: string, capacity: number) => post<RoomRow>(`/platform/operators/${opId}/rooms/${roomId}/capacity`, { capacity }),
  setOperatorSlot: (opId: string, roomId: string, number: number, isActive: boolean, reason?: string) => patch(`/platform/operators/${opId}/rooms/${roomId}/slots/${number}`, { isActive, reason }),
  reassignInventory: (dto: { fromRoomId: string; toRoomId: string; amount: number; reason: string }) => post('/platform/inventory/reassign', dto),
  operatorLimits: (opId: string) => get<LimitsRow>(`/platform/operators/${opId}/limits`),
  setOperatorLimits: (opId: string, dto: Partial<LimitsRow>) => put<LimitsRow>(`/platform/operators/${opId}/limits`, dto),

  // ----- Branding -----
  myBranding: () => get<BrandingResponse>('/operator/branding'),
  updateMyBranding: (dto: Partial<{ displayName: string; themeId: string | null; logoUrl: string | null; welcomeMessage: string | null; bannerUrls: string[] }>) =>
    put<{ branding: BrandingResponse; submittedForApproval: ApprovalRow[]; appliedDirectly: boolean }>('/operator/branding', dto),
  uploadMyBrandingAsset: (fileBase64: string) => post<{ url: string }>('/operator/branding/upload', { fileBase64 }),
  operatorBranding: (opId: string) => get<BrandingResponse>(`/platform/operators/${opId}/branding`),
  updateOperatorBranding: (opId: string, dto: Partial<{ displayName: string; themeId: string | null; logoUrl: string | null; welcomeMessage: string | null; bannerUrls: string[] }>) =>
    put<BrandingResponse>(`/platform/operators/${opId}/branding`, dto),
  uploadOperatorBrandingAsset: (opId: string, fileBase64: string) => post<{ url: string }>(`/platform/operators/${opId}/branding/upload`, { fileBase64 }),

  // ----- Approvals -----
  myApprovals: (status?: string) => get<ApprovalRow[]>('/operator/approvals', { status }),
  cancelMyApproval: (id: string) => post(`/operator/approvals/${id}/cancel`),
  platformApprovals: (status?: string, operatorId?: string) => get<ApprovalRow[]>('/platform/approvals', { status, operatorId }),
  approveRequest: (id: string, note?: string) => post(`/platform/approvals/${id}/approve`, { note }),
  rejectRequest: (id: string, note: string) => post(`/platform/approvals/${id}/reject`, { note }),

  // ----- Notifications -----
  notifications: (params: { unread?: boolean; operatorId?: string; limit?: number } = {}) =>
    get<{ unread: number; items: NotificationRow[] }>('/admin/notifications', { unread: params.unread ? 'true' : undefined, operatorId: params.operatorId, limit: params.limit }),
  markAllNotificationsRead: () => post<{ marked: number }>('/admin/notifications/read-all'),
  markNotificationRead: (id: string) => post(`/admin/notifications/${id}/read`),

  // ----- Games (scheduled mode) -----
  myGames: () => get<GamesListResponse>('/operator/games'),
  scheduleMyGame: (dto: { startsAt: string; salesOpenMinutes?: number; winningPatterns?: string[] }) => post<GameAdminRow>('/operator/games', dto),
  updateMyGame: (id: string, dto: Partial<{ startsAt: string; winningPatterns: string[] }>) => patch<GameAdminRow>(`/operator/games/${id}`, dto),
  cancelMyGame: (id: string, reason: string) => post(`/operator/games/${id}/cancel`, { reason }),
  operatorGames: (opId: string) => get<GamesListResponse>(`/platform/operators/${opId}/games`),
  scheduleOperatorGame: (opId: string, dto: { startsAt: string; salesOpenMinutes?: number; winningPatterns?: string[] }) => post<GameAdminRow>(`/platform/operators/${opId}/games`, dto),
  cancelOperatorGame: (opId: string, id: string, reason: string) => post(`/platform/operators/${opId}/games/${id}/cancel`, { reason }),

  // ----- Support tickets -----
  myTickets: (status?: string) => get<TicketRow[]>('/operator/tickets', { status }),
  getMyTicket: (id: string) => get<TicketDetail>(`/operator/tickets/${id}`),
  replyMyTicket: (id: string, body: string) => post(`/operator/tickets/${id}/reply`, { body }),
  setMyTicketStatus: (id: string, status: 'open' | 'pending' | 'resolved' | 'closed') => post(`/operator/tickets/${id}/status`, { status }),
  assignMyTicket: (id: string, assignedAdminId: string | null) => post(`/operator/tickets/${id}/assign`, { assignedAdminId }),
  operatorTickets: (opId: string, status?: string) => get<TicketRow[]>(`/platform/operators/${opId}/tickets`, { status }),
  getOperatorTicket: (opId: string, id: string) => get<TicketDetail>(`/platform/operators/${opId}/tickets/${id}`),

  // ----- Subscription management (platform) -----
  listSubscriptionPlans: () => get<{ plans: SubscriptionPlanRow[] }>('/platform/subscriptions/plans'),
  createSubscriptionPlan: (dto: Record<string, unknown>) => post<SubscriptionPlanRow>('/platform/subscriptions/plans', dto),
  listSubscriptionPayments: (operatorId?: string) => get<{ payments: SubscriptionPaymentRow[] }>('/platform/subscriptions/payments' + (operatorId ? `?operatorId=${operatorId}` : '')),
  recordSubscriptionPayment: (dto: Record<string, unknown>) => post<SubscriptionPaymentRow>('/platform/subscriptions/payments', dto),
  getPlatformRevenue: () => get<PlatformRevenueData>('/platform/subscriptions/revenue'),

  // ----- System health (super admin) -----
  getHealth: () => get<Record<string, unknown>>('/health'),
  getMetrics: () => get<Record<string, unknown>>('/metrics'),
  getAllActiveSessions: () => get<{ sessions: ActiveSessionRow[] }>('/admin-management/sessions/active'),

  // ----- Content Pages -----
  getContentPage: (pageType: string, operatorId?: string) =>
    get<ContentPageRow>(`/admin/content-pages/${pageType}` + (operatorId ? `?operatorId=${operatorId}` : '')),
  upsertContentPage: (pageType: string, dto: { title: string; bodyMarkdown: string }, operatorId?: string) =>
    put<ContentPageRow | ApprovalRow>(`/admin/content-pages/${pageType}` + (operatorId ? `?operatorId=${operatorId}` : ''), dto),
  getPlatformContentPage: (pageType: string) => get<ContentPageRow>(`/platform/content-pages/${pageType}`),
  upsertPlatformContentPage: (pageType: string, dto: { title: string; bodyMarkdown: string }) =>
    put<ContentPageRow>(`/platform/content-pages/${pageType}`, dto),

  // ----- FAQ -----
  faqList: (operatorId?: string) => get<FaqRow[]>('/admin/faq', { operatorId }),
  createFaq: (dto: { question: string; answer: string }, operatorId?: string) => post<FaqRow>(`/admin/faq${operatorId ? `?operatorId=${operatorId}` : ''}`, dto),
  updateFaq: (id: string, dto: Partial<{ question: string; answer: string; isActive: boolean }>, operatorId?: string) =>
    patch<FaqRow>(`/admin/faq/${id}${operatorId ? `?operatorId=${operatorId}` : ''}`, dto),
  deleteFaq: (id: string, operatorId?: string) => del(`/admin/faq/${id}${operatorId ? `?operatorId=${operatorId}` : ''}`),
  reorderFaq: (id: string, direction: 'up' | 'down', operatorId?: string) => post<FaqRow[]>(`/admin/faq/${id}/reorder${operatorId ? `?operatorId=${operatorId}` : ''}`, { direction }),
};

export interface AdminRow {
  id: string;
  username: string;
  fullName: string;
  role: 'SUPER_ADMIN' | 'ADMIN';
  status: 'active' | 'suspended' | 'disabled';
  permissions: string[];
  totpEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface DepositRow {
  id: string; telegram_user_id: number; amount: number;
  receipt_file_type?: string; receipt_url?: string | null; telebirr_reference?: string; notes?: string;
  status: string; rejection_reason?: string; submitted_at: string; reviewed_by?: string;
}
export interface WithdrawalRow {
  id: string; telegram_user_id: number; amount: number; telebirr_account?: string; account_number?: string;
  proof_url?: string | null; notes?: string;
  status: string; rejection_reason?: string; requested_at: string; reviewed_by?: string;
}
export interface LedgerRow {
  id: string; telegram_user_id: number | null; entry_type: string; direction: string; amount: number; note?: string; created_at: string;
}
export interface AuditRow {
  id: string; admin_user_id?: string; username?: string; action: string; entity_type: string; entity_id?: string; reason?: string; ip_address?: string; created_at: string;
  /** Set only when this action happened during a Super Admin "viewing as" session — the real actor; username above stays the impersonated target. */
  impersonated_by_admin_id?: string | null;
  impersonated_by_username?: string | null;
}
export interface DashboardRoomAvailability {
  code: string;
  name: string;
  price: number;
  capacity: number;
  available: number;
}
export interface DashboardData {
  active_games: number;
  pending_deposits: number;
  pending_withdrawals: number;
  today_deposits_etb: number;
  today_withdrawals_etb: number;
  total_players: number;
  total_house_revenue_etb: number;
  rooms: DashboardRoomAvailability[];
}
export interface CartelaHolderRow {
  id: string;
  cartelaNumber: number;
  isDisqualified: boolean;
  user: { username: string | null; firstName: string | null; telegramUserId: number };
}
export interface CartelasData {
  rooms: Array<{ code: string; name: string; price: number; capacity: number }>;
  holders: Record<string, CartelaHolderRow[]>;
  total_capacity: number;
  max_per_player: number;
  limit_violations: Array<{ telegram_user_id: number; cartelas: number }>;
}

export interface PlayerRow {
  telegram_user_id: number; username?: string | null; first_name?: string | null;
  status: 'active' | 'suspended' | 'banned'; status_reason?: string | null; status_changed_at?: string | null;
  total_balance: number; created_at: string;
}
export interface PlayerDetail {
  telegram_user_id: number; username?: string | null; first_name?: string | null;
  status: 'active' | 'suspended' | 'banned'; status_reason?: string | null;
  status_changed_at?: string | null; status_changed_by_admin_id?: string | null; created_at: string;
}

interface PeriodSnapshot {
  deposits_total: number; deposits_count: number;
  withdrawals_paid_total: number; withdrawals_paid_count: number;
  house_revenue: number; winner_payouts: number; refunds: number; bonus_activity: number;
}
export interface FinanceDashboard {
  today: PeriodSnapshot & { pending_deposits: number; pending_withdrawals: number; unpaid_withdrawals: number };
  this_week: PeriodSnapshot;
  this_month: PeriodSnapshot;
  all_time: PeriodSnapshot & { current_wallet_liability: number; outstanding_withdrawals: number };
}
export interface WalletDetail {
  player: { telegram_user_id: number; username: string | null; first_name: string | null };
  wallet: { deposited_balance: number; won_balance: number; bonus_balance: number; total_balance: number; on_hold: number; withdrawable: number };
  ledger: Array<{ id: string; entryType: string; direction: string; amount: number; note?: string; createdAt: string }>;
  deposits: Array<{ id: string; amount: number; status: string; submittedAt: string }>;
  withdrawals: Array<{ id: string; amount: number; status: string; requestedAt: string }>;
}
export interface GameSettlement {
  game_id: string; game_number: number; finished_at: string;
  gross_entry_revenue: number; house_percentage_amount: number; player_payout_pool: number;
  winner_count: number;
  winners: Array<{ telegram_user_id: number; username: string | null; room: string; cartela_number: number; payout: number }>;
}
export interface Reconciliation {
  status: 'BALANCED' | 'DISCREPANCY';
  checked_players: number;
  discrepancies: Array<{ telegram_user_id: number; username: string | null; expected_total_balance: number; actual_total_balance: number; difference: number }>;
}
export interface FinancialReport extends PeriodSnapshot {
  period: string; generated_at: string;
  pending_transactions: number; unpaid_withdrawals: number; failed_transactions: number;
}
export interface UnpaidWithdrawal {
  id: string; telegram_user_id: number; username: string | null; amount: number;
  telebirr_account?: string; requested_at: string; age_hours: number;
}
export interface FinancialAlert {
  id: string; type: string; severity: string; message: string;
  createdAt: string; acknowledgedAt: string | null;
}
export interface BonusSettings {
  enabled: boolean;
  amountEtb: number;
  wageringMultiplier: number;
}
export interface ReferralReport {
  total_referrals: number;
  total_rewards_paid_etb: number;
  top_referrers: Array<{ telegram_user_id: number | null; name: string; successful_referrals: number }>;
}
export interface GameRuleRow {
  id: string;
  title: string;
  body: string;
  category: string | null;
  sortOrder: number;
  isActive: boolean;
}
export interface ContactRow {
  telegram: string;
  phone: string;
  whatsapp: string;
  email: string;
  support_hours: string;
  configured: boolean;
}
export interface ThemeRow {
  id: string;
  name: string;
  slug: string;
  primaryColor: string;
  secondaryColor: string;
  backgroundColor: string;
  textColor: string;
  surfaceColor: string;
  surfaceAltColor: string;
  mutedTextColor: string;
  accentColor: string;
  buttonBackgroundColor: string | null;
  buttonTextColor: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  isActive: boolean;
  isDefault: boolean;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
}

// ----- Multi-operator platform types -----

export interface OperatorRow {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended' | 'disabled';
  suspendedReason: string | null;
  isDefault: boolean;
  appUrl: string;
  bot: { username: string | null; configured: boolean };
  owner: { id: string; username: string; fullName: string; status: string } | null;
  rooms: Array<{ code: string; name: string; price: number; capacity: number; isActive: boolean }>;
  players: number;
  adminAccounts: number;
  createdAt: string;
}

export interface CreateOperatorDto {
  slug: string;
  name: string;
  owner: { username: string; password?: string; fullName: string };
  rooms: NewRoomDto[];
}

export interface NewRoomDto {
  code: string;
  name: string;
  price: number;
  capacity: number;
  maxPerPlayer?: number;
}

export interface BotInfo {
  botUsername: string | null;
  configured: boolean;
  miniAppUrl: string;
}

export interface BotConfigResult {
  botUsername: string;
  miniAppUrl: string;
  webhook: { ok: boolean; description?: string; webhookUrl?: string };
}

export interface StaffRow {
  id: string;
  username: string;
  fullName: string;
  role: 'OPERATOR_OWNER' | 'OPERATOR_STAFF';
  status: 'active' | 'suspended' | 'disabled';
  permissions: string[];
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface LoginHistoryRow {
  id: string;
  principalType: 'admin' | 'player';
  principalId: string | null;
  operatorId: string | null;
  attemptedUsername: string | null;
  success: boolean;
  failureReason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface RoomRow {
  id: string;
  operatorId: string;
  code: string;
  name: string;
  price: number;
  capacity: number;
  maxPerPlayer: number | null;
  isActive: boolean;
  sortOrder: number;
}

export interface RoomInventoryRow {
  id: string;
  code: string;
  name: string;
  price: number;
  capacity: number;
  maxPerPlayer: number | null;
  isActive: boolean;
  sortOrder: number;
  inactiveNumbers: Array<{ number: number; reason: string | null }>;
  liveGame: { sold: number; available: number } | null;
  allTime: { sold: number; revenue: number; winning: number };
}

export interface InventoryResponse {
  liveGame: { id: string; status: string } | null;
  rooms: RoomInventoryRow[];
  limits?: LimitsRow;
}

export interface LimitsRow {
  MAX_ROOMS: number;
  MAX_TOTAL_CARTELAS: number;
  MIN_CARTELA_PRICE: number;
  MAX_CARTELA_PRICE: number;
  MAX_STAFF: number;
}

export interface BrandingResponse {
  operatorId: string;
  slug: string;
  displayName: string;
  logoUrl: string | null;
  theme: { id: string; name: string } | null;
  welcomeMessage: string | null;
  bannerUrls: string[];
  updatedAt: string;
  pendingChanges?: ApprovalRow[];
}

export interface ApprovalRow {
  id: string;
  operatorId: string;
  type: 'BRANDING_NAME' | 'BRANDING_LOGO' | 'BRANDING_THEME' | 'ROOM_CREATE' | 'ROOM_CAPACITY_INCREASE' | 'SETTING_CHANGE';
  label: string;
  targetKey: string;
  currentValue: unknown;
  proposedValue: unknown;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'superseded';
  submittedByAdminId: string;
  submittedAt: string;
  reviewedByAdminId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  appliedAt: string | null;
  operator?: { slug: string; name: string };
}

export interface NotificationRow {
  id: string;
  audience: 'platform' | 'operator';
  operatorId: string | null;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  createdAt: string;
  readAt: string | null;
  operator?: { slug: string } | null;
}

export interface GameAdminRow {
  id: string;
  gameNumber: number;
  status: 'scheduled' | 'waiting' | 'playing' | 'finished';
  startsAt: string;
  salesOpenAt: string | null;
  winningPatterns: string[];
  cartelasSold: number;
  totalPot: number;
  cancelledReason: string | null;
  finishedAt: string | null;
}

export interface GamesListResponse {
  upcoming: GameAdminRow[];
  recent: GameAdminRow[];
}

export interface TicketRow {
  id: string;
  operatorId: string;
  subject: string;
  status: 'open' | 'pending' | 'resolved' | 'closed';
  priority: string;
  assignedAdminId: string | null;
  createdAt: string;
  lastMessageAt: string;
  user?: { telegramUserId: number; username: string | null; firstName: string | null };
}

export interface TicketMessage {
  id: string;
  ticketId: string;
  authorType: 'player' | 'admin';
  authorId: string;
  body: string;
  createdAt: string;
}

export interface TicketDetail extends TicketRow {
  messages: TicketMessage[];
}

export interface ContentPageRow {
  id: string;
  operatorId: string | null;
  pageType: 'ABOUT' | 'TERMS_AND_CONDITIONS' | 'RESPONSIBLE_GAMING' | 'GAME_INSTRUCTIONS';
  title: string;
  bodyMarkdown: string;
  updatedAt: string;
  updatedByAdminId: string | null;
}

export interface FaqRow {
  id: string;
  operatorId: string;
  question: string;
  answer: string;
  sortOrder: number;
  isActive: boolean;
}

export interface SubscriptionPlanRow {
  id: string;
  name: string;
  key: string;
  monthlyPriceMinor: number;
  limits: Record<string, unknown>;
  features: string[];
  isActive: boolean;
  createdAt: string;
}

export interface SubscriptionPaymentRow {
  id: string;
  operatorId: string;
  operatorName: string;
  planId: string;
  planName: string;
  amountMinor: number;
  status: 'paid' | 'pending' | 'failed';
  periodStart: string;
  periodEnd: string;
  paidAt: string | null;
  notes: string | null;
}

export interface PlatformRevenueData {
  totalPaidMinor: number;
  paymentCount: number;
  byPlan: Array<{ planName: string; count: number; totalMinor: number }>;
}

export interface ActiveSessionRow {
  id: string;
  adminId: string;
  username: string;
  role: string;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
}

export { fileToBase64 } from '../lib/api-client';

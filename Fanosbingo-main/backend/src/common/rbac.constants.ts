/**
 * Granular permission keys — the single source of truth for the seed script
 * (prisma/seed.ts) and the @Permissions() decorator checks.
 *
 * Flat, per-admin direct-assignment model: no role-preset bundles.
 *   - SUPER_ADMIN bypasses this list entirely ('*', see JwtAdminStrategy).
 *   - Platform ADMIN: exactly its own AdminPermission rows.
 *   - OPERATOR_OWNER: every "operator"-scoped key, within its own operator.
 *   - OPERATOR_STAFF: its own grants, filtered to "operator"-scoped keys.
 *
 * Scope "platform" = can never reach an operator account, whatever is stored
 * in admin_permissions (the strategy filters it out). Adding a permission is
 * adding an entry here + running the seed — no architecture change.
 */
export const PERMISSION_SCOPES = {
  VIEW_USERS: 'operator',
  EDIT_USERS: 'operator',
  DELETE_USERS: 'platform',
  VIEW_DEPOSITS: 'operator',
  APPROVE_DEPOSITS: 'operator',
  REJECT_DEPOSITS: 'operator',
  VIEW_WITHDRAWALS: 'operator',
  APPROVE_WITHDRAWALS: 'operator',
  REJECT_WITHDRAWALS: 'operator',
  VIEW_GAMES: 'operator',
  CREATE_GAMES: 'operator',
  UPDATE_GAMES: 'operator',
  DELETE_GAMES: 'platform',
  VIEW_BINGO_CARDS: 'operator',
  REGENERATE_BINGO_CARDS: 'operator',
  VIEW_REPORTS: 'operator',
  VIEW_AUDIT_LOGS: 'operator',
  VIEW_DASHBOARD: 'operator',
  MANAGE_NOTIFICATIONS: 'platform',
  /** Operator admins can't change the keys in OPERATOR_APPROVAL_REQUIRED_SETTINGS — see AdminController.updateSetting. */
  MANAGE_SETTINGS: 'operator',
  // Financial control — see PRODUCTION_MIGRATION_REPORT.md §23.
  // MANAGE_HOUSE_PERCENTAGE additionally requires the SUPER_ADMIN role itself.
  VIEW_WALLETS: 'operator',
  ADJUST_WALLET: 'platform',
  MANAGE_HOUSE_PERCENTAGE: 'platform',
  RESOLVE_RECONCILIATION: 'platform',
  EXPORT_REPORTS: 'operator',
  VIEW_FINANCIAL_ALERTS: 'operator',
  VIEW_REFERRALS: 'operator',
  VIEW_REFERRAL_REPORTS: 'operator',
  VIEW_GAME_RULES: 'operator',
  MANAGE_GAME_RULES: 'operator',
  // Themes are one shared catalog until per-operator branding (Phase 4).
  VIEW_THEMES: 'platform',
  MANAGE_THEMES: 'platform',
  VIEW_CONTACT_CENTER: 'operator',
  MANAGE_CONTACT_CENTER: 'operator',
  // Bonus rule changes require Super Admin approval (spec); until the approval
  // workflow exists (Phase 4), only the platform can change them.
  MANAGE_BONUS_SETTINGS: 'platform',
  // Multi-operator.
  MANAGE_OPERATORS: 'platform',
  MANAGE_STAFF: 'operator',
  VIEW_LOGIN_HISTORY: 'operator',
  // Phase 4: operator self-service. Changes that need Super Admin approval
  // (name/logo/theme, cartela increases, rule changes) become approval
  // requests when an operator account makes them.
  MANAGE_ROOMS: 'operator',
  MANAGE_BRANDING: 'operator',
  APPROVE_OPERATOR_CHANGES: 'platform',
  VIEW_SUPPORT_TICKETS: 'operator',
  MANAGE_SUPPORT_TICKETS: 'operator',
} as const;

export type PermissionKey = keyof typeof PERMISSION_SCOPES;
export type PermissionScope = (typeof PERMISSION_SCOPES)[PermissionKey];

export const PERMISSIONS = Object.keys(PERMISSION_SCOPES) as PermissionKey[];
export const OPERATOR_PERMISSIONS = PERMISSIONS.filter((k) => PERMISSION_SCOPES[k] === 'operator');

export function isOperatorPermission(key: string): key is PermissionKey {
  return (PERMISSION_SCOPES as Record<string, string>)[key] === 'operator';
}

/**
 * Settings an operator-bound admin may not change directly: the spec requires
 * Super Admin approval for name, cartela quantity, and withdrawal / bonus /
 * referral rule changes. Until the approval workflow ships (Phase 4) these are
 * refused for operator accounts rather than applied unreviewed.
 */
export const OPERATOR_APPROVAL_REQUIRED_SETTINGS = new Set([
  'YENA_BINGO_NAME',
  'ETB5_ROOM_CAPACITY',
  'ETB10_ROOM_CAPACITY',
  'MAX_STANDARD_CARTELAS',
  'WITHDRAWAL_MIN_ETB',
  'WELCOME_BONUS_ENABLED',
  'SIGNUP_BONUS_ETB',
  'SIGNUP_BONUS_WAGERING_MULTIPLIER',
  'BONUS_EXPIRY_DAYS',
  'REFERRAL_ENABLED',
  'REFERRAL_BONUS_REFERRER_ETB',
  'REFERRAL_BONUS_NEW_USER_ETB',
  'REFERRAL_MAX_PER_USER',
  'WINNING_PATTERNS',
]);

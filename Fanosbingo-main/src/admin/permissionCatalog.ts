/**
 * Operator-scoped permission keys grantable to operator staff — mirrors the
 * backend's PERMISSION_SCOPES (backend/src/common/rbac.constants.ts) filtered
 * to scope: 'operator'. Kept as a static list here (rather than fetched) since
 * an operator owner has no route to the platform's full permission catalog.
 */
export const OPERATOR_PERMISSION_CATALOG = [
  'VIEW_USERS',
  'EDIT_USERS',
  'VIEW_DEPOSITS',
  'APPROVE_DEPOSITS',
  'REJECT_DEPOSITS',
  'VIEW_WITHDRAWALS',
  'APPROVE_WITHDRAWALS',
  'REJECT_WITHDRAWALS',
  'VIEW_GAMES',
  'CREATE_GAMES',
  'UPDATE_GAMES',
  'VIEW_BINGO_CARDS',
  'REGENERATE_BINGO_CARDS',
  'VIEW_REPORTS',
  'VIEW_AUDIT_LOGS',
  'VIEW_DASHBOARD',
  'MANAGE_SETTINGS',
  'VIEW_WALLETS',
  'EXPORT_REPORTS',
  'VIEW_FINANCIAL_ALERTS',
  'VIEW_REFERRALS',
  'VIEW_REFERRAL_REPORTS',
  'VIEW_GAME_RULES',
  'MANAGE_GAME_RULES',
  'VIEW_CONTACT_CENTER',
  'MANAGE_CONTACT_CENTER',
  'MANAGE_STAFF',
  'VIEW_LOGIN_HISTORY',
  'MANAGE_ROOMS',
  'MANAGE_BRANDING',
  'VIEW_SUPPORT_TICKETS',
  'MANAGE_SUPPORT_TICKETS',
] as const;

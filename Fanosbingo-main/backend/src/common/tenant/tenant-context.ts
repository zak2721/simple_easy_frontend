import { AsyncLocalStorage } from 'node:async_hooks';

interface TenantStore {
  operatorId: string | null;
  /** Set only when the current request is a Super Admin "viewing as" another account — see AuditService.log(). */
  impersonatedByAdminId: string | null;
}

/**
 * Carries the current request's operatorId (from the authenticated admin's
 * or player's own JWT — never client input) across every `await` in the
 * request, without threading it through every service/method signature.
 * Set once per request by TenantContextInterceptor; read by
 * common/tenant/rls.ts at every $transaction call site to activate Postgres
 * RLS (migration 20260926090000_row_level_security) for that transaction.
 *
 * Also carries impersonatedByAdminId for the same reason: AuditService.log()
 * reads it to stamp the real (impersonating) admin onto every audit row,
 * without every one of its ~100 call sites needing to pass it explicitly
 * (Production Readiness Audit — Medium: an audit row previously only ever
 * recorded the impersonated target's id, never the actor behind it).
 */
const storage = new AsyncLocalStorage<TenantStore>();

export function runWithTenant<T>(operatorId: string | null, impersonatedByAdminId: string | null, fn: () => T): T {
  return storage.run({ operatorId, impersonatedByAdminId }, fn);
}

export function getTenantOperatorId(): string | null {
  return storage.getStore()?.operatorId ?? null;
}

export function getImpersonatedByAdminId(): string | null {
  return storage.getStore()?.impersonatedByAdminId ?? null;
}

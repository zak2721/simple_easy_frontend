import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { getTenantOperatorId } from './tenant-context';

/**
 * Activates Postgres RLS (migration 20260926090000_row_level_security) for
 * one transaction, by setting the `app.operator_id` session variable that
 * every tenant table's policy checks. Uses `set_config(..., true)` — the
 * function form of `SET LOCAL` — so the value is scoped to this transaction
 * only and can never leak to another request that reuses the same pooled
 * connection afterward.
 *
 * `operatorId`, when passed explicitly, wins (for cron/system code that
 * already knows which operator it's processing, outside any HTTP request).
 * Otherwise falls back to the current request's own operatorId from
 * TenantContextInterceptor (the authenticated admin's or player's own
 * operatorId — never client input). `null`/absent resolves to '' , which
 * every policy in that migration treats as "platform-level, see every
 * operator" — correct for platform admins and system code, and safe
 * because getting here at all already required passing an auth guard (or
 * being trusted system code), same trust boundary the app layer already
 * relies on.
 *
 * LIVE since this was activated: DATABASE_URL now points at the restricted
 * `app_runtime` role (see docs/YENA_BINGO_MULTI_OPERATOR_ARCHITECTURE.md
 * Phase 7 Part 2), not the Postgres superuser, so the policies these calls
 * activate are genuinely enforced, not a no-op.
 *
 * IMPORTANT — this is a MUTATION-ONLY backstop, not blanket coverage.
 * setTenantOnTx()/tenantSetConfigOp() are only ever called from the ~20
 * service files that explicitly wrap a write in `$transaction`. Every bare
 * (non-transaction) Prisma call elsewhere in the codebase — the majority of
 * reads — never sets this session variable, and every RLS policy treats an
 * unset value as "platform-level, see everything." So for those calls, RLS
 * provides NO protection at all: correctness there rests entirely on that
 * service method's own `WHERE operatorId = ...` filter.
 *
 * This was a deliberate decision (Production Readiness Audit, "RLS coverage"
 * finding), not an oversight: a Prisma Client Extension could intercept
 * every query and activate RLS universally, but that's a global behavioral
 * change to the ORM layer affecting ~258 call sites, all of which were
 * independently verified (two separate audit passes) to already carry
 * correct application-level tenant scoping with no active leak found. Given
 * that, the safer, lower-risk choice was to keep RLS as a defense-in-depth
 * backstop for the write paths that already use it, and document the actual
 * boundary clearly here rather than expand it blind. Revisit this decision
 * if the application-level scoping discipline ever becomes harder to trust
 * (e.g., many more contributors, less consistent review) — the argument for
 * blanket coverage gets stronger as that trust gets weaker.
 */
export async function setTenantOnTx(tx: Prisma.TransactionClient, operatorId?: string | null): Promise<void> {
  const opId = operatorId !== undefined ? operatorId : getTenantOperatorId();
  await tx.$executeRaw`SELECT set_config('app.operator_id', ${opId ?? ''}, true)`;
}

/**
 * Same as setTenantOnTx, for the `$transaction([op1, op2, ...])` batch form
 * used elsewhere in this codebase: prepend this as element 0 of the array.
 * All elements of a batch transaction run on one connection in one
 * transaction, exactly like the interactive callback form, so this has the
 * same effect.
 */
export function tenantSetConfigOp(prisma: PrismaService, operatorId?: string | null) {
  const opId = operatorId !== undefined ? operatorId : getTenantOperatorId();
  return prisma.$executeRaw`SELECT set_config('app.operator_id', ${opId ?? ''}, true)`;
}

-- AlterTable
ALTER TABLE "manual_deposits" ADD COLUMN     "telebirr_reference" TEXT;

-- Finding DEP-1 (High): at most one APPROVED deposit may exist per Telebirr
-- reference. Nothing stops the same physical payment from being submitted as
-- two separate PENDING rows (a partial index can't see intent), but it
-- guarantees only ONE of them can ever be approved — the second approval
-- attempt fails at the database level (unique_violation -> Prisma P2002),
-- not just relies on an admin remembering to cross-check every receipt.
-- Same hand-appended-partial-unique-index pattern as uniq_single_super_admin
-- in migration 20260920180113_audit_fixes_indexes_ban_expiry (Prisma's schema
-- DSL cannot express a partial/filtered unique index).
CREATE UNIQUE INDEX "uniq_approved_telebirr_reference" ON "manual_deposits" ("telebirr_reference")
  WHERE status = 'approved';

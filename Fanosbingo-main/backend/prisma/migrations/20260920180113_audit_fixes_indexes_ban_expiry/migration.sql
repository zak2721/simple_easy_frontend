-- CreateEnum
CREATE TYPE "PlayerStatus" AS ENUM ('active', 'suspended', 'banned');

-- AlterEnum
ALTER TYPE "LedgerEntryType" ADD VALUE 'BONUS_EXPIRED';

-- AlterTable
ALTER TABLE "bonus_grants" ADD COLUMN     "expires_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "telegram_users" ADD COLUMN     "status" "PlayerStatus" NOT NULL DEFAULT 'active',
ADD COLUMN     "status_changed_at" TIMESTAMP(3),
ADD COLUMN     "status_changed_by_admin_id" TEXT,
ADD COLUMN     "status_reason" TEXT;

-- CreateIndex
CREATE INDEX "bonus_grants_status_expires_at_idx" ON "bonus_grants"("status", "expires_at");

-- CreateIndex
CREATE INDEX "player_refresh_tokens_token_hash_idx" ON "player_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "telegram_users_status_idx" ON "telegram_users"("status");

-- CreateIndex
CREATE INDEX "wallet_ledger_related_entity_type_related_entity_id_idx" ON "wallet_ledger"("related_entity_type", "related_entity_id");

-- Audit finding SEC-6 (Medium): AuthService.adminBootstrap's "only one ever"
-- guard was a plain count()-then-create() with no DB-level backstop — a race
-- (two concurrent bootstrap calls, ADMIN_KEY already in hand) could create two
-- SUPER_ADMIN rows. This partial unique index makes a second SUPER_ADMIN
-- physically impossible at the database level, as defense-in-depth alongside
-- the pg_advisory_xact_lock added in AuthService.adminBootstrap. Not
-- representable in schema.prisma's DSL (no partial-index syntax), same as the
-- ledger-immutability trigger in 20260919032018_ledger_immutability — this is
-- deliberate, intentional schema drift the Prisma client doesn't need to know
-- about, it only needs the database to enforce it.
CREATE UNIQUE INDEX "uniq_single_super_admin" ON "admins" ((role))
  WHERE role = 'SUPER_ADMIN';


-- Nullable, additive: safe against the live telegram_users table (existing
-- rows become NULL; Postgres unique indexes permit unlimited NULLs).
-- Tightened to NOT NULL in a later migration, after
-- backend/scripts/backfill-referral-codes.ts populates every existing row.
ALTER TABLE "telegram_users" ADD COLUMN "referral_code" TEXT;

CREATE UNIQUE INDEX "telegram_users_referral_code_key" ON "telegram_users"("referral_code");

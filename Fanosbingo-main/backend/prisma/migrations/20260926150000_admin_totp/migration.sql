-- Phase 5: TOTP two-factor auth for admin accounts. All four columns are
-- nullable/defaulted, so this is a plain metadata-only ALTER — no backfill,
-- no lock beyond the brief one every ALTER TABLE takes, and the admins table
-- is not append-only so there's no immutability trigger to consider.
ALTER TABLE "admins"
  ADD COLUMN "totp_secret_encrypted" TEXT,
  ADD COLUMN "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "totp_verified_at" TIMESTAMP(3),
  ADD COLUMN "totp_last_used_counter" INTEGER;

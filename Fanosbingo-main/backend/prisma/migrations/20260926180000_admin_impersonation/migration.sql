-- Phase 5: Super Admin impersonation ("view as"). Both columns are nullable,
-- so this is a plain metadata-only ALTER — no backfill, no lock beyond the
-- brief one every ALTER TABLE takes.
ALTER TABLE "admin_sessions"
  ADD COLUMN "impersonated_by_admin_id" TEXT,
  ADD COLUMN "impersonation_reason" TEXT;

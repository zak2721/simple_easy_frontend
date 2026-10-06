ALTER TABLE "audit_logs"
  ADD COLUMN IF NOT EXISTS "actor_role" TEXT,
  ADD COLUMN IF NOT EXISTS "request_id" TEXT;

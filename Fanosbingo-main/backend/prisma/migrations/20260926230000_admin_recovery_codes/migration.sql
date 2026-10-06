-- Phase 5: one-time 2FA recovery codes. New table, cascades with its admin
-- (same as admin_refresh_tokens) — recovery codes are meaningless once the
-- account is gone, unlike the RESTRICT used for cross-tenant financial rows.
CREATE TABLE "admin_recovery_codes" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_recovery_codes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_recovery_codes_admin_id_idx" ON "admin_recovery_codes"("admin_id");

ALTER TABLE "admin_recovery_codes" ADD CONSTRAINT "admin_recovery_codes_admin_id_fkey"
    FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

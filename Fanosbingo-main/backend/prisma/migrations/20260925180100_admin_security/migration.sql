-- Multi-operator Phase 3: operator admin accounts + login security.

-- Account lockout + password age.
ALTER TABLE "admins" ADD COLUMN "failed_login_count" INTEGER NOT NULL DEFAULT 0,
                     ADD COLUMN "locked_until" TIMESTAMP(3),
                     ADD COLUMN "password_changed_at" TIMESTAMP(3);

-- Platform admins have no operator; operator owners/staff must have one.
ALTER TABLE "admins" ADD CONSTRAINT "admins_operator_scope_chk" CHECK (
  ("role" IN ('SUPER_ADMIN', 'ADMIN') AND "operator_id" IS NULL) OR
  ("role" IN ('OPERATOR_OWNER', 'OPERATOR_STAFF') AND "operator_id" IS NOT NULL)
);

-- Exactly one owner per operator (same partial-unique pattern as uniq_single_super_admin).
CREATE UNIQUE INDEX "uniq_operator_owner" ON "admins"("operator_id") WHERE "role" = 'OPERATOR_OWNER';

-- Permission scope: "platform" permissions can never be granted to operator accounts.
-- Every existing key starts as platform; prisma/seed.ts marks the operator-scoped ones.
ALTER TABLE "permissions" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'platform';
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_scope_chk" CHECK ("scope" IN ('platform', 'operator'));

ALTER TABLE "admin_sessions" ADD COLUMN "device_id" TEXT;

-- Player refresh-token rotation chain, for reuse detection.
ALTER TABLE "player_refresh_tokens" ADD COLUMN "family_id" TEXT,
                                    ADD COLUMN "replaced_by_id" TEXT;
CREATE INDEX "player_refresh_tokens_family_id_idx" ON "player_refresh_tokens"("family_id");

CREATE TABLE "admin_refresh_tokens" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "replaced_by_id" TEXT,
    CONSTRAINT "admin_refresh_tokens_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "admin_refresh_tokens_token_hash_idx" ON "admin_refresh_tokens"("token_hash");
CREATE INDEX "admin_refresh_tokens_session_id_idx" ON "admin_refresh_tokens"("session_id");
ALTER TABLE "admin_refresh_tokens" ADD CONSTRAINT "admin_refresh_tokens_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_refresh_tokens" ADD CONSTRAINT "admin_refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "admin_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "login_history" (
    "id" TEXT NOT NULL,
    "principal_type" TEXT NOT NULL,
    "principal_id" TEXT,
    "operator_id" TEXT,
    "attempted_username" TEXT,
    "success" BOOLEAN NOT NULL,
    "failure_reason" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "device_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "login_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "login_history_principal_type_principal_id_created_at_idx" ON "login_history"("principal_type", "principal_id", "created_at");
CREATE INDEX "login_history_ip_address_created_at_idx" ON "login_history"("ip_address", "created_at");
CREATE INDEX "login_history_operator_id_created_at_idx" ON "login_history"("operator_id", "created_at");

-- Login history is evidence: append-only, like wallet_ledger and audit_logs.
CREATE TRIGGER login_history_immutable
  BEFORE UPDATE OR DELETE ON login_history
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

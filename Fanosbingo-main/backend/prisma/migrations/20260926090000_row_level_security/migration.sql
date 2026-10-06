-- Phase 7 (Part 1): Postgres Row-Level Security — a second, independent
-- tenant-isolation layer beneath the application-level `operatorId` scoping
-- built in Phases 1-4b (and the consistency triggers from those phases).
--
-- WHAT THIS DOES: creates a new, unprivileged Postgres role ("app_runtime")
-- and, for every table that carries an operator_id (directly, or indirectly
-- for support_ticket_messages via its parent ticket), a policy that only
-- lets that role see/write rows for the operator named by the
-- "app.operator_id" session variable — so even a query with a forgotten
-- `WHERE operator_id = ...` clause cannot cross a tenant boundary, as long
-- as the connection is running as app_runtime with that variable set.
--
-- WHAT THIS DOES NOT DO YET: the backend still connects as the "postgres"
-- superuser (see DATABASE_URL), and superusers bypass row security
-- unconditionally — Postgres does not allow RLS to restrict a superuser at
-- all, regardless of policies. So today, right after this migration runs,
-- application behavior is UNCHANGED: nothing is enforced yet. Activating
-- enforcement requires two more steps, deliberately left as follow-up work
-- (not done in this migration) because they touch how every request talks
-- to the database and deserve their own careful rollout + regression pass:
--   1. Give app_runtime a real password (`ALTER ROLE app_runtime WITH
--      PASSWORD '...'`, never committed) and point DATABASE_URL at it
--      instead of the postgres superuser.
--   2. Have the backend run `SET LOCAL app.operator_id = '<uuid>'` (inside
--      an explicit transaction, so it can never leak to another request
--      reusing the same pooled connection) at the start of every
--      operator-scoped request, and leave it unset for platform-level
--      requests (an unset/empty value intentionally means "see every
--      operator" below — that's what lets the Super Admin console keep
--      working once this is switched on).
--
-- Until both of those land, this migration is inert but fully real: you can
-- verify every policy right now by connecting AS app_runtime directly (after
-- giving it a password) and confirming cross-operator reads/writes are
-- rejected while same-operator ones succeed — see
-- docs/YENA_BINGO_MULTI_OPERATOR_ARCHITECTURE.md for the verification this
-- migration was tested with.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN;
  END IF;
END
$$;

-- No password is set here on purpose: a role with no password rejects every
-- password-based login attempt, so this role is safe to create in every
-- environment (including this shadow/dev database) without granting anyone
-- access until an operator deliberately sets one out of band (never in a
-- migration file, which is committed to git).

-- ===== Privileges =====
-- Every table the application touches, so app_runtime is a drop-in
-- replacement for the superuser connection whenever DATABASE_URL is
-- switched over. _prisma_migrations is deliberately excluded: migrations
-- run only as the owning/superuser role, never as the runtime app role.
GRANT CONNECT ON DATABASE "yena_bingo" TO app_runtime;
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "operator_settings" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "operator_limits" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "operator_branding" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "operator_rooms" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "cartela_slots" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "telegram_users" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "games" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "game_cartelas" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "wallet_ledger" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "manual_deposits" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "withdrawal_requests" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "bonus_grants" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "referrals" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "game_rules" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "approval_requests" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "support_tickets" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "faq_entries" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "admins" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "login_history" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "audit_logs" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "themes" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "financial_alerts" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "support_ticket_messages" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "operators" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "permissions" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "admin_permissions" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "admin_refresh_tokens" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "admin_sessions" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "player_refresh_tokens" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "settings" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "games_game_number_seq" TO app_runtime;

-- ===== Row-level security policies =====
-- Every policy has the same shape: unrestricted when "app.operator_id" is
-- unset/empty (platform-level access — the Super Admin console needs to see
-- every operator), otherwise pinned to one operator. Tables whose
-- operator_id is nullable (a platform-wide row with no single owning
-- operator, e.g. a platform admin account or the default theme catalog)
-- also allow NULL through unconditionally.

ALTER TABLE "operator_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "operator_settings"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  );

ALTER TABLE "operator_limits" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "operator_limits"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  );

ALTER TABLE "operator_branding" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "operator_branding"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  );

ALTER TABLE "operator_rooms" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "operator_rooms"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  );

ALTER TABLE "cartela_slots" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cartela_slots"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  );

ALTER TABLE "telegram_users" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "telegram_users"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  );

ALTER TABLE "games" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "games"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  );

ALTER TABLE "game_cartelas" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "game_cartelas"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  );

ALTER TABLE "wallet_ledger" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wallet_ledger"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  );

ALTER TABLE "manual_deposits" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "manual_deposits"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  );

ALTER TABLE "withdrawal_requests" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "withdrawal_requests"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  );

ALTER TABLE "bonus_grants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "bonus_grants"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  );

ALTER TABLE "referrals" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "referrals"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  );

ALTER TABLE "game_rules" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "game_rules"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  );

ALTER TABLE "approval_requests" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "approval_requests"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  );

ALTER TABLE "support_tickets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "support_tickets"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  );

ALTER TABLE "faq_entries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "faq_entries"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
  );

ALTER TABLE "admins" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "admins"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
    OR "operator_id" IS NULL
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
    OR "operator_id" IS NULL
  );

ALTER TABLE "login_history" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "login_history"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
    OR "operator_id" IS NULL
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
    OR "operator_id" IS NULL
  );

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_logs"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
    OR "operator_id" IS NULL
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
    OR "operator_id" IS NULL
  );

ALTER TABLE "themes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "themes"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
    OR "operator_id" IS NULL
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
    OR "operator_id" IS NULL
  );

ALTER TABLE "financial_alerts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "financial_alerts"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
    OR "operator_id" IS NULL
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
    OR "operator_id" IS NULL
  );

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notifications"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
    OR "operator_id" IS NULL
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR "operator_id" = current_setting('app.operator_id', true)
    OR "operator_id" IS NULL
  );

-- No operator_id of its own — scoped indirectly via its parent ticket.
ALTER TABLE "support_ticket_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "support_ticket_messages"
  USING (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR EXISTS (
      SELECT 1 FROM "support_tickets" t
      WHERE t."id" = "support_ticket_messages"."ticket_id"
        AND t."operator_id" = current_setting('app.operator_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.operator_id', true) IS NULL
    OR current_setting('app.operator_id', true) = ''
    OR EXISTS (
      SELECT 1 FROM "support_tickets" t
      WHERE t."id" = "support_ticket_messages"."ticket_id"
        AND t."operator_id" = current_setting('app.operator_id', true)
    )
  );

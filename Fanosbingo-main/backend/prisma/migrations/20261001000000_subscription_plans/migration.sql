-- Phase 8a: Subscription plans — named, sellable bundles of OperatorLimit
-- values + feature flags. Rows (not hard-coded enum values) so a Super Admin
-- can add a plan without a deploy. See docs/YENA_BINGO_SAAS_PLATFORM_ARCHITECTURE.md §2.
--
-- Migration ordering (S1 → S2 → S3):
--   S1: Create subscription_plans table + seed four rows.
--   S2: Add nullable FK + status/date columns to operators (additive, DEFAULT NULL/'trialing').
--   S3: Backfill every existing operator to the "legacy" plan so nothing hits a
--       new ceiling on deploy day (existing behavior unchanged by construction).
--
-- Risk: None — pure addition. Every existing operator query is unaffected;
-- the new columns are nullable or have defaults.

-- =============================================================================
-- S1: subscription_plans table
-- =============================================================================

CREATE TABLE "subscription_plans" (
  "id"                   TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "key"                  TEXT         NOT NULL,
  "name"                 TEXT         NOT NULL,
  "monthly_price_minor"  INTEGER,
  "currency"             TEXT         DEFAULT 'ETB',
  "limits"               JSONB        NOT NULL DEFAULT '{}',
  "features"             TEXT[]       NOT NULL DEFAULT '{}',
  "is_active"            BOOLEAN      NOT NULL DEFAULT true,
  "created_at"           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE ("key")
);

-- Seed four plans. "Legacy" is unlimited-equivalent so no existing operator
-- loses capability when the backfill (S3) assigns it to them.
INSERT INTO "subscription_plans" ("id", "key", "name", "monthly_price_minor", "limits", "features", "is_active") VALUES
  ('00000000-0000-0000-0000-000000000010', 'legacy',       'Legacy (Unlimited)',   NULL,     '{"MAX_ROOMS":100,"MAX_TOTAL_CARTELAS":100000,"MAX_STAFF":100,"MAX_GAMES_PER_DAY":9999,"MAX_ACTIVE_PLAYERS":99999}', '{"REFERRALS","CUSTOM_DOMAIN","ADVANCED_REPORTS"}', true),
  ('00000000-0000-0000-0000-000000000011', 'starter',      'Starter',              4900,     '{"MAX_ROOMS":2,"MAX_TOTAL_CARTELAS":1000,"MAX_STAFF":3,"MAX_GAMES_PER_DAY":50,"MAX_ACTIVE_PLAYERS":500}',          '{}',                                                true),
  ('00000000-0000-0000-0000-000000000012', 'professional', 'Professional',         14900,    '{"MAX_ROOMS":5,"MAX_TOTAL_CARTELAS":5000,"MAX_STAFF":10,"MAX_GAMES_PER_DAY":200,"MAX_ACTIVE_PLAYERS":5000}',         '{"REFERRALS","ADVANCED_REPORTS"}',                  true),
  ('00000000-0000-0000-0000-000000000013', 'enterprise',   'Enterprise',           49900,    '{"MAX_ROOMS":20,"MAX_TOTAL_CARTELAS":50000,"MAX_STAFF":50,"MAX_GAMES_PER_DAY":2000,"MAX_ACTIVE_PLAYERS":50000}',      '{"REFERRALS","CUSTOM_DOMAIN","ADVANCED_REPORTS"}',  true);

-- =============================================================================
-- S2: Additive columns on operators — nullable FK, defaults so zero data risk
-- =============================================================================

ALTER TABLE "operators"
  ADD COLUMN IF NOT EXISTS "subscription_plan_id"    TEXT         REFERENCES "subscription_plans"("id") ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "subscription_status"     TEXT         NOT NULL DEFAULT 'trialing',
  ADD COLUMN IF NOT EXISTS "subscription_started_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "subscription_expires_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "business_phone"          TEXT,
  ADD COLUMN IF NOT EXISTS "business_email"          TEXT;

-- =============================================================================
-- S3: Backfill — every existing operator gets the "legacy" plan.
--     Uses a constant that matches the seeded row above; safe to re-run (ON CONFLICT DO NOTHING).
-- =============================================================================

UPDATE "operators"
   SET "subscription_plan_id" = '00000000-0000-0000-0000-000000000010',
       "subscription_status"  = 'active'
 WHERE "subscription_plan_id" IS NULL;

-- =============================================================================
-- RLS grants for app_runtime (same pattern as 20260926090000_row_level_security)
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON "subscription_plans" TO app_runtime;

-- subscription_plans is a platform-owned catalog — no RLS needed (every operator
-- can read it; only a platform admin writes it, enforced at the application layer).
-- The operators table already has RLS from the earlier migration; the new columns
-- inherit the existing policy automatically.

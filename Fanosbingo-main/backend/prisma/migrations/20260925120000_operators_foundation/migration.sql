-- Multi-operator foundation (Phase 1). No behavior change: every existing row
-- is assigned to the default operator "yena", and the current single-operator
-- code keeps working because the new operator_id columns DEFAULT to it.
--
-- wallet_ledger and audit_logs reject every UPDATE (prevent_ledger_mutation).
-- Adding a column with a constant DEFAULT is a metadata-only change on
-- Postgres 11+: existing rows read the default without being rewritten, so
-- the trigger never fires. Do NOT replace this with ADD COLUMN + UPDATE.
--
-- The two telegram_users trigram indexes from 20260920200000_db_audit_fixes
-- are raw SQL that Prisma can't model; `prisma migrate diff` proposes dropping
-- them, which was deliberately removed from this file.

-- CreateEnum
CREATE TYPE "OperatorStatus" AS ENUM ('active', 'suspended', 'disabled');
CREATE TYPE "GameMode" AS ENUM ('continuous', 'scheduled');

-- Operators
CREATE TABLE "operators" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "OperatorStatus" NOT NULL DEFAULT 'active',
    "owner_admin_id" TEXT,
    "game_mode" "GameMode" NOT NULL DEFAULT 'continuous',
    "bot_username" TEXT,
    "bot_token_encrypted" TEXT,
    "webhook_secret" TEXT,
    "suspended_reason" TEXT,
    "suspended_at" TIMESTAMP(3),
    "created_by_admin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "operators_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "operators_slug_key" ON "operators"("slug");
CREATE INDEX "operators_status_idx" ON "operators"("status");

-- The default operator must exist before any FK below is validated.
INSERT INTO "operators" ("id", "slug", "name", "status", "game_mode", "updated_at")
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'yena',
  COALESCE((SELECT "value" FROM "settings" WHERE "id" = 'YENA_BINGO_NAME'), 'የኛ bingo'),
  'active',
  'continuous',
  CURRENT_TIMESTAMP
);

CREATE TABLE "operator_settings" (
    "operator_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_by_admin_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "operator_settings_pkey" PRIMARY KEY ("operator_id","key")
);

CREATE TABLE "operator_limits" (
    "operator_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "operator_limits_pkey" PRIMARY KEY ("operator_id","key")
);

CREATE TABLE "operator_branding" (
    "operator_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "logo_url" TEXT,
    "theme_id" TEXT,
    "welcome_message" TEXT,
    "banner_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "operator_branding_pkey" PRIMARY KEY ("operator_id")
);

CREATE TABLE "operator_rooms" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "max_per_player" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "operator_rooms_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "operator_rooms_sane_chk" CHECK ("price" > 0 AND "capacity" BETWEEN 1 AND 10000)
);
CREATE UNIQUE INDEX "operator_rooms_operator_id_code_key" ON "operator_rooms"("operator_id", "code");

CREATE TABLE "cartela_slots" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "cartela_number" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deactivated_reason" TEXT,
    CONSTRAINT "cartela_slots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cartela_slots_number_positive_chk" CHECK ("cartela_number" >= 1)
);
CREATE INDEX "cartela_slots_operator_id_idx" ON "cartela_slots"("operator_id");
CREATE UNIQUE INDEX "cartela_slots_room_id_cartela_number_key" ON "cartela_slots"("room_id", "cartela_number");

-- operator_id on existing tables. Constant DEFAULT = metadata-only back-fill.
ALTER TABLE "telegram_users"      ADD COLUMN "operator_id" TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE "games"               ADD COLUMN "operator_id" TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE "game_cartelas"       ADD COLUMN "operator_id" TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
                                  ADD COLUMN "room_id" TEXT;
ALTER TABLE "manual_deposits"     ADD COLUMN "operator_id" TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE "withdrawal_requests" ADD COLUMN "operator_id" TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE "bonus_grants"        ADD COLUMN "operator_id" TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE "referrals"           ADD COLUMN "operator_id" TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE "wallet_ledger"       ADD COLUMN "operator_id" TEXT DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE "audit_logs"          ADD COLUMN "operator_id" TEXT DEFAULT '00000000-0000-0000-0000-000000000001';
-- Null = platform-level (platform admins, platform theme library/rules, platform alerts).
ALTER TABLE "admins"              ADD COLUMN "operator_id" TEXT;
ALTER TABLE "themes"              ADD COLUMN "operator_id" TEXT;
ALTER TABLE "game_rules"          ADD COLUMN "operator_id" TEXT;
ALTER TABLE "financial_alerts"    ADD COLUMN "operator_id" TEXT;

-- Default operator's branding + rooms, seeded from the current settings so the
-- two sources agree on day one.
INSERT INTO "operator_branding" ("operator_id", "display_name", "updated_at")
SELECT "id", "name", CURRENT_TIMESTAMP FROM "operators" WHERE "id" = '00000000-0000-0000-0000-000000000001';

INSERT INTO "operator_rooms" ("id", "operator_id", "code", "name", "price", "capacity", "sort_order", "updated_at")
VALUES
  (gen_random_uuid()::text, '00000000-0000-0000-0000-000000000001', 'etb5', 'ETB 5 room',
   COALESCE((SELECT "value" FROM "settings" WHERE "id" = 'ETB5_ROOM_PRICE'), '5')::numeric,
   COALESCE((SELECT "value" FROM "settings" WHERE "id" = 'ETB5_ROOM_CAPACITY'), '400')::int,
   0, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, '00000000-0000-0000-0000-000000000001', 'etb10', 'ETB 10 room',
   COALESCE((SELECT "value" FROM "settings" WHERE "id" = 'ETB10_ROOM_PRICE'), '10')::numeric,
   COALESCE((SELECT "value" FROM "settings" WHERE "id" = 'ETB10_ROOM_CAPACITY'), '200')::int,
   1, CURRENT_TIMESTAMP);

INSERT INTO "cartela_slots" ("id", "operator_id", "room_id", "cartela_number")
SELECT gen_random_uuid()::text, r."operator_id", r."id", n
FROM "operator_rooms" r
CROSS JOIN LATERAL generate_series(1, r."capacity") AS n;

-- game_cartelas is mutable (no immutability trigger), so a plain UPDATE is fine.
UPDATE "game_cartelas" gc
SET "room_id" = r."id"
FROM "operator_rooms" r
WHERE r."operator_id" = gc."operator_id"
  AND r."code" = gc."room_type"::text
  AND gc."room_id" IS NULL;

-- Indexes
CREATE INDEX "admins_operator_id_idx" ON "admins"("operator_id");
CREATE INDEX "audit_logs_operator_id_created_at_idx" ON "audit_logs"("operator_id", "created_at");
CREATE INDEX "bonus_grants_operator_id_idx" ON "bonus_grants"("operator_id");
CREATE INDEX "game_cartelas_operator_id_idx" ON "game_cartelas"("operator_id");
CREATE INDEX "game_cartelas_room_id_idx" ON "game_cartelas"("room_id");
CREATE INDEX "game_rules_operator_id_idx" ON "game_rules"("operator_id");
CREATE INDEX "games_operator_id_status_idx" ON "games"("operator_id", "status");
CREATE INDEX "manual_deposits_operator_id_status_idx" ON "manual_deposits"("operator_id", "status");
CREATE INDEX "referrals_operator_id_created_at_idx" ON "referrals"("operator_id", "created_at");
CREATE INDEX "telegram_users_operator_id_idx" ON "telegram_users"("operator_id");
CREATE INDEX "themes_operator_id_idx" ON "themes"("operator_id");
CREATE INDEX "wallet_ledger_operator_id_created_at_idx" ON "wallet_ledger"("operator_id", "created_at");
CREATE INDEX "withdrawal_requests_operator_id_status_idx" ON "withdrawal_requests"("operator_id", "status");

-- Foreign keys (validation only reads rows; it never UPDATEs the immutable tables).
ALTER TABLE "operator_settings" ADD CONSTRAINT "operator_settings_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_limits" ADD CONSTRAINT "operator_limits_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_branding" ADD CONSTRAINT "operator_branding_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_branding" ADD CONSTRAINT "operator_branding_theme_id_fkey" FOREIGN KEY ("theme_id") REFERENCES "themes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "operator_rooms" ADD CONSTRAINT "operator_rooms_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cartela_slots" ADD CONSTRAINT "cartela_slots_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cartela_slots" ADD CONSTRAINT "cartela_slots_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "operator_rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "telegram_users" ADD CONSTRAINT "telegram_users_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "games" ADD CONSTRAINT "games_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_cartelas" ADD CONSTRAINT "game_cartelas_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_cartelas" ADD CONSTRAINT "game_cartelas_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "operator_rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "manual_deposits" ADD CONSTRAINT "manual_deposits_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bonus_grants" ADD CONSTRAINT "bonus_grants_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admins" ADD CONSTRAINT "admins_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_rules" ADD CONSTRAINT "game_rules_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "themes" ADD CONSTRAINT "themes_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "financial_alerts" ADD CONSTRAINT "financial_alerts_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

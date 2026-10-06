-- CreateEnum
CREATE TYPE "RoomType" AS ENUM ('etb5', 'etb10');

-- CreateEnum
CREATE TYPE "GameStatus" AS ENUM ('waiting', 'playing', 'finished');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('MANUAL_TELEBIRR_DEPOSIT', 'GAME_ENTRY', 'GAME_REFUND', 'WINNING_CREDIT', 'HOUSE_REVENUE', 'WITHDRAWAL_HOLD', 'WITHDRAWAL_PAID', 'WITHDRAWAL_RELEASE', 'BONUS_GRANT', 'BONUS_STAKE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('credit', 'debit');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('pending', 'approved', 'paid', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "BonusStatus" AS ENUM ('active', 'wagered_out', 'expired');

-- CreateEnum
CREATE TYPE "AdminStatus" AS ENUM ('active', 'suspended', 'disabled');

-- CreateTable
CREATE TABLE "telegram_users" (
    "id" TEXT NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "username" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "language_code" TEXT NOT NULL DEFAULT 'am',
    "deposited_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "won_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "bonus_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_refresh_tokens" (
    "id" TEXT NOT NULL,
    "telegram_user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "player_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" TEXT NOT NULL,
    "game_number" SERIAL NOT NULL,
    "status" "GameStatus" NOT NULL DEFAULT 'waiting',
    "current_number" INTEGER,
    "called_numbers" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "winner_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "winner_prize_each" DECIMAL(14,2),
    "winner_prize_amount" DECIMAL(14,2),
    "house_share_amount" DECIMAL(14,2),
    "winner_payouts" JSONB,
    "total_pot" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "selection_closed_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "return_to_lobby_at" TIMESTAMP(3),
    "claim_window_start" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_cartelas" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "telegram_user_id" TEXT NOT NULL,
    "room_type" "RoomType" NOT NULL,
    "cartela_number" INTEGER NOT NULL,
    "entry_price" DECIMAL(14,2) NOT NULL,
    "card_numbers" JSONB NOT NULL,
    "marked_cells" JSONB NOT NULL DEFAULT '[]',
    "reserved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reservation_expires_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "is_disqualified" BOOLEAN NOT NULL DEFAULT false,
    "winning_pattern" JSONB,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_cartelas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_ledger" (
    "id" TEXT NOT NULL,
    "telegram_user_id" TEXT,
    "entry_type" "LedgerEntryType" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "related_entity_type" TEXT,
    "related_entity_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manual_deposits" (
    "id" TEXT NOT NULL,
    "telegram_user_id" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "telebirr_transaction_reference" TEXT NOT NULL,
    "receipt_path" TEXT,
    "receipt_mime_type" TEXT,
    "status" "DepositStatus" NOT NULL DEFAULT 'pending',
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by_admin_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "admin_note" TEXT,

    CONSTRAINT "manual_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_requests" (
    "id" TEXT NOT NULL,
    "telegram_user_id" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "telebirr_account" TEXT NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'pending',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by_admin_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "telebirr_transaction_reference" TEXT,
    "payment_proof_path" TEXT,
    "rejection_reason" TEXT,
    "admin_note" TEXT,

    CONSTRAINT "withdrawal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bonus_grants" (
    "id" TEXT NOT NULL,
    "telegram_user_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "campaign_id" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "wagering_required" DECIMAL(14,2) NOT NULL,
    "wagering_progress" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "BonusStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bonus_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" "AdminStatus" NOT NULL DEFAULT 'active',
    "created_by_admin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "admin_user_roles" (
    "admin_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,

    CONSTRAINT "admin_user_roles_pkey" PRIMARY KEY ("admin_id","role_id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "ip_address" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "admin_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "previous_state" JSONB,
    "new_state" JSONB,
    "reason" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_users_telegram_user_id_key" ON "telegram_users"("telegram_user_id");

-- CreateIndex
CREATE INDEX "player_refresh_tokens_telegram_user_id_idx" ON "player_refresh_tokens"("telegram_user_id");

-- CreateIndex
CREATE INDEX "games_status_idx" ON "games"("status");

-- CreateIndex
CREATE INDEX "game_cartelas_game_id_telegram_user_id_idx" ON "game_cartelas"("game_id", "telegram_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_cartelas_game_id_room_type_cartela_number_key" ON "game_cartelas"("game_id", "room_type", "cartela_number");

-- CreateIndex
CREATE INDEX "wallet_ledger_telegram_user_id_idx" ON "wallet_ledger"("telegram_user_id");

-- CreateIndex
CREATE INDEX "wallet_ledger_entry_type_idx" ON "wallet_ledger"("entry_type");

-- CreateIndex
CREATE INDEX "manual_deposits_telegram_user_id_idx" ON "manual_deposits"("telegram_user_id");

-- CreateIndex
CREATE INDEX "manual_deposits_status_idx" ON "manual_deposits"("status");

-- CreateIndex
CREATE INDEX "withdrawal_requests_telegram_user_id_idx" ON "withdrawal_requests"("telegram_user_id");

-- CreateIndex
CREATE INDEX "withdrawal_requests_status_idx" ON "withdrawal_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "bonus_grants_telegram_user_id_reason_key" ON "bonus_grants"("telegram_user_id", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "admin_sessions_admin_id_idx" ON "admin_sessions"("admin_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_admin_id_idx" ON "audit_logs"("admin_id");

-- AddForeignKey
ALTER TABLE "player_refresh_tokens" ADD CONSTRAINT "player_refresh_tokens_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_cartelas" ADD CONSTRAINT "game_cartelas_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_cartelas" ADD CONSTRAINT "game_cartelas_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_deposits" ADD CONSTRAINT "manual_deposits_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonus_grants" ADD CONSTRAINT "bonus_grants_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

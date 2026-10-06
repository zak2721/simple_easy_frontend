-- Full DB audit findings (High/Medium): onDelete correctness + missing
-- indexes on the fastest-growing / most-queried tables. See schema.prisma
-- comments at each field/index for the individual rationale.

-- DropForeignKey
ALTER TABLE "game_cartelas" DROP CONSTRAINT "game_cartelas_game_id_fkey";

-- DropForeignKey
ALTER TABLE "wallet_ledger" DROP CONSTRAINT "wallet_ledger_telegram_user_id_fkey";

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "bonus_grants_reason_idx" ON "bonus_grants"("reason");

-- CreateIndex
CREATE INDEX "game_cartelas_telegram_user_id_idx" ON "game_cartelas"("telegram_user_id");

-- CreateIndex
CREATE INDEX "referrals_created_at_idx" ON "referrals"("created_at");

-- CreateIndex
CREATE INDEX "referrals_inviter_rewarded_idx" ON "referrals"("inviter_rewarded");

-- CreateIndex
CREATE INDEX "wallet_ledger_entry_type_created_at_idx" ON "wallet_ledger"("entry_type", "created_at");

-- AddForeignKey
-- Finding (Medium): GameCartela.game was ON DELETE CASCADE — inconsistent
-- with this schema's "never destroy financial history" convention; no code
-- path deletes a Game today, but Cascade here would silently destroy paid
-- cartela records the moment any future tool deleted a Game row.
ALTER TABLE "game_cartelas" ADD CONSTRAINT "game_cartelas_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- Finding (High): WalletLedgerEntry.telegramUserId is nullable (HOUSE_REVENUE
-- entries have no user), so Prisma's default onDelete for an optional
-- relation was SetNull. The wallet_ledger immutability trigger (migration
-- 20260919032018_ledger_immutability) unconditionally blocks UPDATE on this
-- table, and SetNull's delete-time action IS an UPDATE — a future
-- TelegramUser delete with ledger rows would hit that trigger and hard-fail
-- with an opaque Postgres error instead of a clean SetNull. Restrict matches
-- every sibling relation off TelegramUser (GameCartela, ManualDeposit,
-- WithdrawalRequest, BonusGrant, Referral).
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Finding (Medium): admin player search (admin.service.ts's listPlayers)
-- does `username`/`firstName` `contains`+`insensitive` (ILIKE '%x%'), which a
-- plain btree index cannot serve — full table scan once the player table
-- grows. A trigram GIN index makes ILIKE '%substring%' actually indexable.
-- Not expressible in Prisma's schema DSL (no operator-class syntax), same
-- category of intentional drift as the partial unique indexes elsewhere.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "telegram_users_username_trgm_idx" ON "telegram_users" USING gin ("username" gin_trgm_ops);
CREATE INDEX "telegram_users_first_name_trgm_idx" ON "telegram_users" USING gin ("first_name" gin_trgm_ops);

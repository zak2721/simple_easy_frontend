-- Multi-operator Phase 2a: per-operator isolation.
--
-- Ships together with the code that passes operatorId on every write; the
-- column DEFAULTs added in 20260925120000 are dropped here so a forgotten
-- operatorId fails loudly instead of silently landing in the default operator.
--
-- DROP DEFAULT is metadata-only: rows back-filled through the fast-default
-- mechanism keep their value (it lives in pg_attribute.attmissingval, which
-- DROP DEFAULT does not clear), and no UPDATE runs against wallet_ledger or
-- audit_logs, so prevent_ledger_mutation never fires.
--
-- As in earlier migrations, raw-SQL indexes Prisma can't model
-- (telegram_users_*_trgm_idx, uniq_live_game_per_operator below) show up as
-- DROP INDEX in `prisma migrate diff`; those lines are deliberately absent.

-- 1. Cartelas: room_id becomes the room key. Re-run the back-fill first for
--    any cartela bought between the Phase 1 deploy and this one.
UPDATE "game_cartelas" gc
SET "room_id" = r."id"
FROM "operator_rooms" r
WHERE r."operator_id" = gc."operator_id"
  AND r."code" = gc."room_type"::text
  AND gc."room_id" IS NULL;

ALTER TABLE "game_cartelas" ALTER COLUMN "room_type" DROP NOT NULL,
                            ALTER COLUMN "room_id" SET NOT NULL;

DROP INDEX "game_cartelas_game_id_room_type_cartela_number_key";
CREATE UNIQUE INDEX "game_cartelas_game_id_room_id_cartela_number_key" ON "game_cartelas"("game_id", "room_id", "cartela_number");

-- 2. Players: a Telegram id is unique per operator, not globally (separate
--    account + wallet per operator). The composite unique also serves
--    operator_id-leading lookups, so the single-column operator index goes.
DROP INDEX "telegram_users_telegram_user_id_key";
DROP INDEX "telegram_users_operator_id_idx";
CREATE UNIQUE INDEX "telegram_users_operator_id_telegram_user_id_key" ON "telegram_users"("operator_id", "telegram_user_id");
CREATE INDEX "telegram_users_telegram_user_id_idx" ON "telegram_users"("telegram_user_id");

-- 3. Drop the temporary back-fill defaults.
ALTER TABLE "telegram_users"      ALTER COLUMN "operator_id" DROP DEFAULT;
ALTER TABLE "games"               ALTER COLUMN "operator_id" DROP DEFAULT;
ALTER TABLE "game_cartelas"       ALTER COLUMN "operator_id" DROP DEFAULT;
ALTER TABLE "manual_deposits"     ALTER COLUMN "operator_id" DROP DEFAULT;
ALTER TABLE "withdrawal_requests" ALTER COLUMN "operator_id" DROP DEFAULT;
ALTER TABLE "bonus_grants"        ALTER COLUMN "operator_id" DROP DEFAULT;
ALTER TABLE "referrals"           ALTER COLUMN "operator_id" DROP DEFAULT;
ALTER TABLE "wallet_ledger"       ALTER COLUMN "operator_id" DROP DEFAULT;
ALTER TABLE "audit_logs"          ALTER COLUMN "operator_id" DROP DEFAULT;

-- Every ledger row belongs to an operator (HOUSE_REVENUE included). SET NOT
-- NULL only scans to validate; it rewrites nothing and runs no UPDATE, so the
-- immutability trigger is not involved. audit_logs stays nullable: platform
-- actions (admin login, operator management) belong to no operator.
ALTER TABLE "wallet_ledger"       ALTER COLUMN "operator_id" SET NOT NULL;

-- 4. At most one live (waiting/playing) game per operator. GamesService
--    relies on this: a concurrent ensureWaitingGame race loses with P2002
--    and re-reads the winner instead of creating a second live game.
CREATE UNIQUE INDEX "uniq_live_game_per_operator" ON "games"("operator_id") WHERE "status" IN ('waiting', 'playing');

-- 5. Cross-operator consistency, enforced by the database. The application
--    always derives operator_id from the player/game row; these triggers make
--    a future bug that mixes operators fail instead of corrupting money data.
CREATE OR REPLACE FUNCTION assert_operator_matches_player() RETURNS trigger AS $$
DECLARE
  player_operator TEXT;
BEGIN
  IF NEW.telegram_user_id IS NULL THEN
    RETURN NEW; -- e.g. HOUSE_REVENUE ledger rows have no player
  END IF;
  SELECT operator_id INTO player_operator FROM telegram_users WHERE id = NEW.telegram_user_id;
  IF NEW.operator_id IS DISTINCT FROM player_operator THEN
    RAISE EXCEPTION '%: operator_id % does not match the player''s operator %', TG_TABLE_NAME, NEW.operator_id, player_operator
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wallet_ledger_operator_matches_player
  BEFORE INSERT ON wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION assert_operator_matches_player();
CREATE TRIGGER manual_deposits_operator_matches_player
  BEFORE INSERT OR UPDATE OF operator_id, telegram_user_id ON manual_deposits
  FOR EACH ROW EXECUTE FUNCTION assert_operator_matches_player();
CREATE TRIGGER withdrawal_requests_operator_matches_player
  BEFORE INSERT OR UPDATE OF operator_id, telegram_user_id ON withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION assert_operator_matches_player();
CREATE TRIGGER bonus_grants_operator_matches_player
  BEFORE INSERT OR UPDATE OF operator_id, telegram_user_id ON bonus_grants
  FOR EACH ROW EXECUTE FUNCTION assert_operator_matches_player();

CREATE OR REPLACE FUNCTION assert_cartela_operator_consistent() RETURNS trigger AS $$
DECLARE
  game_operator TEXT;
  player_operator TEXT;
  room_operator TEXT;
BEGIN
  SELECT operator_id INTO game_operator FROM games WHERE id = NEW.game_id;
  SELECT operator_id INTO player_operator FROM telegram_users WHERE id = NEW.telegram_user_id;
  SELECT operator_id INTO room_operator FROM operator_rooms WHERE id = NEW.room_id;
  IF NEW.operator_id IS DISTINCT FROM game_operator
     OR NEW.operator_id IS DISTINCT FROM player_operator
     OR NEW.operator_id IS DISTINCT FROM room_operator THEN
    RAISE EXCEPTION 'game_cartelas: operator mismatch (row %, game %, player %, room %)', NEW.operator_id, game_operator, player_operator, room_operator
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER game_cartelas_operator_consistent
  BEFORE INSERT OR UPDATE OF operator_id, game_id, telegram_user_id, room_id ON game_cartelas
  FOR EACH ROW EXECUTE FUNCTION assert_cartela_operator_consistent();

CREATE OR REPLACE FUNCTION assert_referral_operator_consistent() RETURNS trigger AS $$
DECLARE
  inviter_operator TEXT;
  invited_operator TEXT;
BEGIN
  SELECT operator_id INTO inviter_operator FROM telegram_users WHERE id = NEW.inviter_user_id;
  SELECT operator_id INTO invited_operator FROM telegram_users WHERE id = NEW.invited_user_id;
  IF NEW.operator_id IS DISTINCT FROM inviter_operator OR NEW.operator_id IS DISTINCT FROM invited_operator THEN
    RAISE EXCEPTION 'referrals: operator mismatch (row %, inviter %, invited %)', NEW.operator_id, inviter_operator, invited_operator
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER referrals_operator_consistent
  BEFORE INSERT OR UPDATE OF operator_id, inviter_user_id, invited_user_id ON referrals
  FOR EACH ROW EXECUTE FUNCTION assert_referral_operator_consistent();

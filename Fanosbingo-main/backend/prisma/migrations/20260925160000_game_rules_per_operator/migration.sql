-- Multi-operator Phase 2b: every game rule belongs to one operator.
-- Rule text names rooms and prices, which differ per operator, so rules that
-- existed before multi-operator (all platform-wide, operator_id NULL) become
-- the default operator's rules. game_rules is mutable, so a plain UPDATE is fine.
UPDATE "game_rules" SET "operator_id" = '00000000-0000-0000-0000-000000000001' WHERE "operator_id" IS NULL;

ALTER TABLE "game_rules" ALTER COLUMN "operator_id" SET NOT NULL;

DROP INDEX "game_rules_operator_id_idx";
CREATE INDEX "game_rules_operator_id_is_active_sort_order_idx" ON "game_rules"("operator_id", "is_active", "sort_order");

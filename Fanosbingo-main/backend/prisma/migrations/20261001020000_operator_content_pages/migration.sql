-- Phase 8c (S5): operator_content_pages — long-form branded text per operator.
--
-- Same shape as faq_entries / game_rules: one table, operatorId nullable
-- (null = platform-wide default a new operator starts from). One row per
-- (operator, page_type) pair enforced by unique constraint.
--
-- Page types: ABOUT, TERMS_AND_CONDITIONS, RESPONSIBLE_GAMING, GAME_INSTRUCTIONS.
-- TERMS and RESPONSIBLE_GAMING changes by an operator account route through the
-- ApprovalRequest workflow (approval-policy.ts); ABOUT and GAME_INSTRUCTIONS
-- are applied directly (low legal/compliance risk).
--
-- RLS: same "nullable-operator variant" as themes/audit_logs/notifications in
-- 20260926090000_row_level_security — a null operator_id means platform-default
-- (every operator may read it), while a set operator_id scopes to that tenant.

CREATE TABLE "operator_content_pages" (
  "id"                TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "operator_id"       TEXT         REFERENCES "operators"("id") ON DELETE RESTRICT,
  "page_type"         TEXT         NOT NULL,
  "title"             TEXT         NOT NULL,
  "body_markdown"     TEXT         NOT NULL DEFAULT '',
  "updated_at"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_by_admin_id" TEXT,
  UNIQUE ("operator_id", "page_type")
);

CREATE INDEX "operator_content_pages_operator_id_page_type_idx"
  ON "operator_content_pages" ("operator_id", "page_type");

-- Grant to app_runtime
GRANT SELECT, INSERT, UPDATE, DELETE ON "operator_content_pages" TO app_runtime;

-- RLS — same nullable-operator policy used by themes, audit_logs, notifications
ALTER TABLE "operator_content_pages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "operator_content_pages"
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

-- Seed platform-wide default pages (operatorId null) so new operators start
-- with sensible placeholder content rather than a blank page.
INSERT INTO "operator_content_pages" ("id", "operator_id", "page_type", "title", "body_markdown") VALUES
  (gen_random_uuid()::text, NULL, 'ABOUT',
   'About Us',
   'Welcome to our Bingo platform! We offer exciting Bingo games with real prizes.'),
  (gen_random_uuid()::text, NULL, 'TERMS_AND_CONDITIONS',
   'Terms and Conditions',
   'By using this platform you agree to our terms and conditions. Please play responsibly.'),
  (gen_random_uuid()::text, NULL, 'RESPONSIBLE_GAMING',
   'Responsible Gaming',
   'We are committed to responsible gaming. If you or someone you know has a gambling problem, please seek help.'),
  (gen_random_uuid()::text, NULL, 'GAME_INSTRUCTIONS',
   'How to Play Bingo',
   'Purchase your cartela(s), wait for the game to start, and mark off numbers as they are called. First to complete a pattern wins!');

CREATE TABLE "subscription_payments" (
  "id"            TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "operator_id"   TEXT         NOT NULL REFERENCES "operators"("id") ON DELETE RESTRICT,
  "plan_id"       TEXT         NOT NULL REFERENCES "subscription_plans"("id") ON DELETE RESTRICT,
  "amount_minor"  INTEGER      NOT NULL,
  "currency"      TEXT         NOT NULL DEFAULT 'ETB',
  "status"        TEXT         NOT NULL DEFAULT 'pending',
  "period_start"  TIMESTAMPTZ  NOT NULL,
  "period_end"    TIMESTAMPTZ  NOT NULL,
  "paid_at"       TIMESTAMPTZ,
  "notes"         TEXT,
  "created_at"    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX "subscription_payments_operator_id_idx" ON "subscription_payments"("operator_id");
GRANT SELECT, INSERT, UPDATE ON "subscription_payments" TO app_runtime;

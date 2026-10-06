-- Lightweight Sybil/bonus-farming defense (product decision, see
-- PRODUCTION_READINESS_AUDIT.md "Sybil/multi-account defense"). Captures the
-- IP and client-generated device id present at account creation, so
-- BonusService can cap how many SIGNUP/REFERRAL_* bonuses pay out per
-- fingerprint per day. Both nullable, pure metadata-only ADD COLUMN — no
-- existing row is affected, and a NULL fingerprint (a pre-existing account,
-- or a request with no device id) simply can't be evaluated against the cap.
ALTER TABLE "telegram_users" ADD COLUMN "signup_ip" TEXT;
ALTER TABLE "telegram_users" ADD COLUMN "signup_device_id" TEXT;

CREATE INDEX "telegram_users_operator_id_signup_ip_idx" ON "telegram_users"("operator_id", "signup_ip");
CREATE INDEX "telegram_users_operator_id_signup_device_id_idx" ON "telegram_users"("operator_id", "signup_device_id");

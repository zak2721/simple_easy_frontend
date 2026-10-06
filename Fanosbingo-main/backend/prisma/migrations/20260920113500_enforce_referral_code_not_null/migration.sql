-- Safe now that backend/scripts/backfill-referral-codes.ts has populated
-- every existing row (verified: 0 remaining NULLs). Ship this in the same
-- deploy as the AuthService change that assigns a code to every new signup,
-- never earlier.
ALTER TABLE "telegram_users" ALTER COLUMN "referral_code" SET NOT NULL;

-- Fix: subscription_status column was added as plain TEXT but Prisma schema
-- defines SubscriptionStatus as a Postgres enum. Create the enum type and
-- cast the column so Prisma's generated client can query it correctly.

CREATE TYPE "SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'cancelled');

-- Drop default before cast (Postgres cannot auto-cast a TEXT default to enum)
ALTER TABLE "operators" ALTER COLUMN "subscription_status" DROP DEFAULT;

ALTER TABLE "operators"
  ALTER COLUMN "subscription_status"
    TYPE "SubscriptionStatus"
    USING "subscription_status"::"SubscriptionStatus";

-- Re-apply default as enum literal
ALTER TABLE "operators"
  ALTER COLUMN "subscription_status" SET DEFAULT 'trialing'::"SubscriptionStatus";

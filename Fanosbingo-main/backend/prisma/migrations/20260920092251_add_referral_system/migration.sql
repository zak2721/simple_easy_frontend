-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "inviter_user_id" TEXT NOT NULL,
    "invited_user_id" TEXT NOT NULL,
    "inviter_rewarded" BOOLEAN NOT NULL DEFAULT false,
    "invited_rewarded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referrals_invited_user_id_key" ON "referrals"("invited_user_id");

-- CreateIndex
CREATE INDEX "referrals_inviter_user_id_idx" ON "referrals"("inviter_user_id");

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_inviter_user_id_fkey" FOREIGN KEY ("inviter_user_id") REFERENCES "telegram_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_invited_user_id_fkey" FOREIGN KEY ("invited_user_id") REFERENCES "telegram_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


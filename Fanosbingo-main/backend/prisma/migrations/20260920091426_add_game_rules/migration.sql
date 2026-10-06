-- CreateTable
CREATE TABLE "game_rules" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "game_rules_is_active_sort_order_idx" ON "game_rules"("is_active", "sort_order");


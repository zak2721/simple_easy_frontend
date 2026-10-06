-- CreateEnum
CREATE TYPE "FinancialAlertType" AS ENUM ('OLD_UNPAID_WITHDRAWAL', 'LARGE_WITHDRAWAL', 'DUPLICATE_TELEBIRR_REFERENCE', 'LEDGER_WALLET_MISMATCH');

-- CreateTable
CREATE TABLE "financial_alerts" (
    "id" TEXT NOT NULL,
    "type" "FinancialAlertType" NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "message" TEXT NOT NULL,
    "related_entity_type" TEXT,
    "related_entity_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by_admin_id" TEXT,

    CONSTRAINT "financial_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "financial_alerts_acknowledged_at_idx" ON "financial_alerts"("acknowledged_at");

-- CreateIndex
CREATE UNIQUE INDEX "financial_alerts_type_related_entity_type_related_entity_id_key" ON "financial_alerts"("type", "related_entity_type", "related_entity_id");


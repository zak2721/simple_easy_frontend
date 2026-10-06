-- AlterEnum
BEGIN;
CREATE TYPE "FinancialAlertType_new" AS ENUM ('OLD_UNPAID_WITHDRAWAL', 'LARGE_WITHDRAWAL', 'LEDGER_WALLET_MISMATCH');
ALTER TABLE "financial_alerts" ALTER COLUMN "type" TYPE "FinancialAlertType_new" USING ("type"::text::"FinancialAlertType_new");
ALTER TYPE "FinancialAlertType" RENAME TO "FinancialAlertType_old";
ALTER TYPE "FinancialAlertType_new" RENAME TO "FinancialAlertType";
DROP TYPE "FinancialAlertType_old";
COMMIT;

-- AlterTable
ALTER TABLE "manual_deposits" DROP COLUMN "telebirr_transaction_reference";

-- AlterTable
ALTER TABLE "withdrawal_requests" DROP COLUMN "telebirr_transaction_reference";


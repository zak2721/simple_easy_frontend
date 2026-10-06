-- AlterTable
ALTER TABLE "manual_deposits" DROP COLUMN "receipt_mime_type",
DROP COLUMN "receipt_path",
ADD COLUMN     "notes" TEXT;

-- AlterTable
ALTER TABLE "withdrawal_requests" DROP COLUMN "payment_proof_path",
ADD COLUMN     "notes" TEXT;


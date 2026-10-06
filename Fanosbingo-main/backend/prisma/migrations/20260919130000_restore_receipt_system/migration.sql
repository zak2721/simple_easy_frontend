-- AlterTable
ALTER TABLE "manual_deposits" ADD COLUMN     "receipt_mime_type" TEXT,
ADD COLUMN     "receipt_path" TEXT;

-- AlterTable
ALTER TABLE "withdrawal_requests" ADD COLUMN     "payment_proof_path" TEXT;


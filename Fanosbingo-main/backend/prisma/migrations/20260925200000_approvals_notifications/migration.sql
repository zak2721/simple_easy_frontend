-- Multi-operator Phase 4a: approval workflow + notifications.

CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected', 'cancelled', 'superseded');

CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "target_key" TEXT NOT NULL DEFAULT '',
    "current_value" JSONB,
    "proposed_value" JSONB NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "submitted_by_admin_id" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by_admin_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "applied_at" TIMESTAMP(3),
    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "approval_requests_status_submitted_at_idx" ON "approval_requests"("status", "submitted_at");
CREATE INDEX "approval_requests_operator_id_status_idx" ON "approval_requests"("operator_id", "status");
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one pending request per (operator, type, target). A new submission
-- supersedes the older pending one in the same transaction (ApprovalsService).
CREATE UNIQUE INDEX "uniq_pending_approval" ON "approval_requests"("operator_id", "type", "target_key") WHERE "status" = 'pending';

-- Approval history is evidence: never deleted, and a decided request never
-- changes again (status only moves forward out of 'pending').
CREATE OR REPLACE FUNCTION protect_approval_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval_requests rows cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'approval request % is already %; it cannot change again', OLD.id, OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.operator_id <> OLD.operator_id OR NEW.type <> OLD.type OR NEW.proposed_value <> OLD.proposed_value
     OR NEW.submitted_by_admin_id <> OLD.submitted_by_admin_id OR NEW.submitted_at <> OLD.submitted_at THEN
    RAISE EXCEPTION 'approval request % content is immutable', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER approval_requests_protected
  BEFORE UPDATE OR DELETE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION protect_approval_history();

CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "operator_id" TEXT,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "related_entity_type" TEXT,
    "related_entity_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMP(3),
    "read_by_admin_id" TEXT,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notifications_audience_chk" CHECK (
      ("audience" = 'platform') OR ("audience" = 'operator' AND "operator_id" IS NOT NULL)
    ),
    CONSTRAINT "notifications_severity_chk" CHECK ("severity" IN ('info', 'warning', 'critical'))
);
CREATE INDEX "notifications_audience_read_at_created_at_idx" ON "notifications"("audience", "read_at", "created_at");
CREATE INDEX "notifications_operator_id_audience_read_at_idx" ON "notifications"("operator_id", "audience", "read_at");
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

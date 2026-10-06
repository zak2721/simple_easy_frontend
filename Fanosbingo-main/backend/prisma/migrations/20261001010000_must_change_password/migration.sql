-- Phase 8b (S4): must_change_password flag on admins.
--
-- Set true when an operator owner account is created with a Super-Admin-generated
-- temporary password. JwtAdminStrategy rejects all routes except
-- POST /auth/admin/change-password until cleared (see auth.service.ts).
--
-- DEFAULT false: existing admins are unaffected; the flag is only ever set true
-- by the new OperatorManagementService.create() path when dto.owner.password is
-- omitted — no existing data or behavior changes on deploy.

ALTER TABLE "admins"
  ADD COLUMN IF NOT EXISTS "must_change_password" BOOLEAN NOT NULL DEFAULT false;

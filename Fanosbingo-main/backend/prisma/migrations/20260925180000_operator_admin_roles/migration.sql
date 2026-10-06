-- Multi-operator Phase 3: operator-bound admin roles.
-- Kept in its own migration: Postgres does not allow a newly added enum value
-- to be used in the same transaction that adds it, and the next migration
-- (20260925180100_admin_security) references these values in a CHECK
-- constraint and a partial unique index.
ALTER TYPE "AdminRole" ADD VALUE 'OPERATOR_OWNER';
ALTER TYPE "AdminRole" ADD VALUE 'OPERATOR_STAFF';

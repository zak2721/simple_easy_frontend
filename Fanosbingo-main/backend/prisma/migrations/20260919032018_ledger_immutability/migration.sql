-- Ledger and audit-log immutability, enforced at the database level.
--
-- The application layer already never issues UPDATE/DELETE against these
-- tables (see WalletService.writeEntry / AuditService.log — no update/delete
-- method exists on either service). This trigger is defense-in-depth: it
-- makes tampering impossible even via a direct psql session, a future bug,
-- or a compromised app credential — a BEFORE trigger that raises fires
-- regardless of the connecting role's privileges (unlike a plain REVOKE,
-- which a superuser role such as the default "postgres" dev user would
-- simply bypass).
--
-- Deliberately NOT blocking INSERT — both tables are append-only, not
-- read-only.

CREATE OR REPLACE FUNCTION prevent_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted on this table', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wallet_ledger_immutable ON wallet_ledger;
CREATE TRIGGER wallet_ledger_immutable
  BEFORE UPDATE OR DELETE ON wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

DROP TRIGGER IF EXISTS audit_logs_immutable ON audit_logs;
CREATE TRIGGER audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

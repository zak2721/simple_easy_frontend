/*
  # የኛ — RLS hardening for financial tables

  የኛ players authenticate via Telegram, not Supabase Auth, so the browser
  holds only the anon key. Row-level filtering by auth.uid() is therefore
  impossible for player data. Every read of financial data goes through an edge
  function (service role) that is keyed by the verified Telegram user id.

  This migration removes the over-permissive public SELECT policies added in
  earlier የኛ migrations so anon/public cannot read other users' rows.
*/

DROP POLICY IF EXISTS "Users read own deposits"  ON manual_deposits;
DROP POLICY IF EXISTS "Users read own ledger"    ON wallet_ledger;

-- withdrawal_requests: drop the self-referential public policy from the original project
DROP POLICY IF EXISTS "Users can read own withdrawal requests" ON withdrawal_requests;

-- Keep ONLY service-role access on these tables (edge functions do the filtering).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='manual_deposits' AND policyname='Service role manages deposits') THEN
    CREATE POLICY "Service role manages deposits" ON manual_deposits FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='wallet_ledger' AND policyname='Service role manages ledger') THEN
    CREATE POLICY "Service role manages ledger" ON wallet_ledger FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='withdrawal_requests' AND policyname='Service role manages withdrawals') THEN
    CREATE POLICY "Service role manages withdrawals" ON withdrawal_requests FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

/*
  Player-facing read of own finance, keyed by Telegram user id (called only from
  the list-my-finance / wallet edge paths via service role, but SECURITY DEFINER
  so it also works if ever exposed to authenticated).
*/
CREATE OR REPLACE FUNCTION eds_my_finance(p_user bigint, p_limit int DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'wallet', eds_wallet(p_user),
    'deposits', COALESCE((SELECT jsonb_agg(d ORDER BY d.submitted_at DESC) FROM (
        SELECT id, amount, telebirr_transaction_reference, status, rejection_reason,
               submitted_at, reviewed_at
        FROM manual_deposits WHERE telegram_user_id = p_user
        ORDER BY submitted_at DESC LIMIT p_limit) d), '[]'),
    'withdrawals', COALESCE((SELECT jsonb_agg(w ORDER BY w.requested_at DESC) FROM (
        SELECT id, amount, telebirr_account, status, rejection_reason,
               telebirr_transaction_reference, requested_at, reviewed_at, paid_at
        FROM withdrawal_requests WHERE telegram_user_id = p_user
        ORDER BY requested_at DESC LIMIT p_limit) w), '[]'),
    'ledger', COALESCE((SELECT jsonb_agg(l ORDER BY l.created_at DESC) FROM (
        SELECT id, entry_type, direction, amount, note, created_at,
               balance_after_deposited, balance_after_won
        FROM wallet_ledger WHERE telegram_user_id = p_user
        ORDER BY created_at DESC LIMIT p_limit) l), '[]')
  );
END;
$$;
GRANT EXECUTE ON FUNCTION eds_my_finance(bigint, int) TO service_role;

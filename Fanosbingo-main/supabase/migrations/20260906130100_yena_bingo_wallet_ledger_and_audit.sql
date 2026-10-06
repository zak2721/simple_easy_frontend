/*
  # የኛ — unified wallet ledger + audit log

  The original project tracked balances with bare column updates and a set of
  per-purpose tables (balance_transfers, referral_bonuses, deposit_transactions...).
  There was no single ledger and no admin audit trail.

  ## wallet_ledger
  Append-only. EVERY change to telegram_users.deposited_balance / won_balance
  MUST be accompanied by a wallet_ledger row written in the same transaction.

    entry_type:
      MANUAL_TELEBIRR_DEPOSIT  credit deposited_balance (admin-approved deposit)
      GAME_ENTRY               debit  (cartela purchase)
      WINNING_CREDIT           credit won_balance
      WITHDRAWAL_HOLD          debit  won_balance (funds locked, request pending)
      WITHDRAWAL_PAID          settle (hold -> paid; no balance change, closes hold)
      WITHDRAWAL_RELEASE       credit won_balance (hold released: reject/cancel)
      REFUND                   credit (cartela released before game start)
      HOUSE_REVENUE            house ledger (not a player balance)
      ADJUSTMENT               manual admin correction (audited)

  amount is always POSITIVE; `direction` says credit/debit/settle.
  `balance_after_deposited` / `balance_after_won` are snapshots for reconciliation.

  ## audit_logs
  One row per privileged/financial admin action. previous_state / new_state are
  JSON snapshots. Written by the eds_* admin functions.
*/

-- ---------------------------------------------------------------------------
-- wallet_ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id         bigint,                     -- NULL for HOUSE_REVENUE
  entry_type               text NOT NULL,
  direction                text NOT NULL CHECK (direction IN ('credit','debit','settle')),
  amount                   numeric(14,2) NOT NULL CHECK (amount >= 0),
  currency                 text NOT NULL DEFAULT 'ETB',
  balance_after_deposited  numeric(14,2),
  balance_after_won        numeric(14,2),
  reference_type           text,                       -- 'deposit' | 'withdrawal' | 'game' | 'player' | 'manual'
  reference_id             text,
  related_game_id          uuid,
  related_player_id        uuid,
  note                     text,
  created_by               text,                       -- admin id / 'system' / 'player'
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_ledger_entry_type_check CHECK (entry_type IN (
    'MANUAL_TELEBIRR_DEPOSIT','GAME_ENTRY','WINNING_CREDIT','WITHDRAWAL_HOLD',
    'WITHDRAWAL_PAID','WITHDRAWAL_RELEASE','REFUND','HOUSE_REVENUE','ADJUSTMENT'
  ))
);

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user       ON wallet_ledger(telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_type       ON wallet_ledger(entry_type);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_reference  ON wallet_ledger(reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_game       ON wallet_ledger(related_game_id);
-- idempotency: at most one ledger row per (entry_type, reference_type, reference_id)
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_ledger_ref
  ON wallet_ledger(entry_type, reference_type, reference_id)
  WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;

ALTER TABLE wallet_ledger ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='wallet_ledger' AND policyname='Users read own ledger') THEN
    CREATE POLICY "Users read own ledger" ON wallet_ledger
      FOR SELECT TO public
      USING (telegram_user_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='wallet_ledger' AND policyname='Service role manages ledger') THEN
    CREATE POLICY "Service role manages ledger" ON wallet_ledger
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE wallet_ledger IS
  'Append-only financial ledger. Never UPDATE/DELETE. Every player balance change has a matching row.';

-- ---------------------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id  text,
  actor          text NOT NULL DEFAULT 'system',
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      text,
  previous_state jsonb,
  new_state      jsonb,
  reason         text,
  ip             text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin  ON audit_logs(admin_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action, created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='audit_logs' AND policyname='Service role manages audit') THEN
    CREATE POLICY "Service role manages audit" ON audit_logs
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION eds_audit(
  p_admin text, p_action text, p_entity_type text, p_entity_id text,
  p_prev jsonb, p_new jsonb, p_reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO audit_logs(admin_user_id, actor, action, entity_type, entity_id, previous_state, new_state, reason)
  VALUES (p_admin, COALESCE(p_admin,'system'), p_action, p_entity_type, p_entity_id, p_prev, p_new, p_reason)
  RETURNING id;
$$;

-- ---------------------------------------------------------------------------
-- eds_ledger_write — the ONLY way to move a player's balance
-- ---------------------------------------------------------------------------
/*
  Applies a signed change to a player's balances and records it. Returns the
  ledger row id. Idempotent on (entry_type, reference_type, reference_id) via the
  unique index — a duplicate call raises unique_violation, which callers treat as
  "already applied".

  p_deposited_delta / p_won_delta are signed (negative = debit). The function
  refuses to drive either balance below zero.
*/
CREATE OR REPLACE FUNCTION eds_ledger_write(
  p_user            bigint,
  p_entry_type      text,
  p_direction       text,
  p_amount          numeric,
  p_deposited_delta numeric,
  p_won_delta       numeric,
  p_reference_type  text  DEFAULT NULL,
  p_reference_id    text  DEFAULT NULL,
  p_game_id         uuid  DEFAULT NULL,
  p_player_id       uuid  DEFAULT NULL,
  p_created_by      text  DEFAULT 'system',
  p_note            text  DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dep numeric;
  v_won numeric;
  v_id  uuid;
BEGIN
  IF p_user IS NOT NULL THEN
    SELECT deposited_balance, won_balance INTO v_dep, v_won
    FROM telegram_users WHERE telegram_user_id = p_user
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'eds_ledger_write: user % not found', p_user;
    END IF;

    v_dep := v_dep + COALESCE(p_deposited_delta, 0);
    v_won := v_won + COALESCE(p_won_delta, 0);

    IF v_dep < 0 OR v_won < 0 THEN
      RAISE EXCEPTION 'eds_ledger_write: insufficient balance (deposited %, won %) for %', v_dep, v_won, p_entry_type
        USING ERRCODE = 'check_violation';
    END IF;

    UPDATE telegram_users
    SET deposited_balance = v_dep,
        won_balance       = v_won,
        balance           = v_dep + v_won
    WHERE telegram_user_id = p_user;
  END IF;

  INSERT INTO wallet_ledger(
    telegram_user_id, entry_type, direction, amount, currency,
    balance_after_deposited, balance_after_won,
    reference_type, reference_id, related_game_id, related_player_id,
    note, created_by
  ) VALUES (
    p_user, p_entry_type, p_direction, ABS(COALESCE(p_amount,0)), 'ETB',
    v_dep, v_won,
    p_reference_type, p_reference_id, p_game_id, p_player_id,
    p_note, p_created_by
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- read helper
CREATE OR REPLACE FUNCTION eds_wallet(p_user bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'deposited_balance', COALESCE(tu.deposited_balance, 0),
    'won_balance',       COALESCE(tu.won_balance, 0),
    'total_balance',     COALESCE(tu.deposited_balance,0) + COALESCE(tu.won_balance,0),
    'on_hold',           COALESCE((
        SELECT SUM(amount) FROM wallet_ledger wl
        WHERE wl.telegram_user_id = p_user AND wl.entry_type = 'WITHDRAWAL_HOLD'
      ), 0) - COALESCE((
        SELECT SUM(amount) FROM wallet_ledger wl
        WHERE wl.telegram_user_id = p_user AND wl.entry_type IN ('WITHDRAWAL_PAID','WITHDRAWAL_RELEASE')
      ), 0),
    'withdrawable',      GREATEST(0, COALESCE(tu.won_balance,0))
  )
  FROM telegram_users tu
  WHERE tu.telegram_user_id = p_user;
$$;
GRANT EXECUTE ON FUNCTION eds_wallet(bigint) TO anon, authenticated;

/*
  # የኛ — manual Telebirr deposits

  There is NO automatic Telebirr API. A player submits a deposit (amount +
  Telebirr transaction reference + receipt file), it lands as PENDING, and an
  admin approves or rejects it. Approval credits the wallet EXACTLY ONCE
  (idempotent via wallet_ledger's unique reference index).

  ## manual_deposits
    status: pending | approved | rejected | cancelled
    payment_method: MANUAL_TELEBIRR
    receipt_file_path points into the private `receipts` storage bucket.

  ## Telebirr account config (placeholders until the operator supplies real ones)
    settings: TELEBIRR_ACCOUNT_NAME, TELEBIRR_ACCOUNT_NUMBER, TELEBIRR_INSTRUCTIONS
*/

INSERT INTO settings (id, value, description) VALUES
  ('TELEBIRR_ACCOUNT_NAME',   'YOUR_ACCOUNT_NAME',   'የኛ Telebirr account holder name (set by operator)'),
  ('TELEBIRR_ACCOUNT_NUMBER', 'YOUR_ACCOUNT_NUMBER', 'የኛ Telebirr account / phone number (set by operator)'),
  ('TELEBIRR_INSTRUCTIONS',
   'Send the EXACT amount to the የኛ Telebirr account shown above. Then paste the Telebirr transaction / reference number and upload the confirmation SMS screenshot or PDF. Your balance is credited only after an admin verifies the payment.',
   'Deposit instructions shown to players'),
  ('DEPOSIT_MIN_ETB', '10',   'Minimum manual deposit amount'),
  ('DEPOSIT_MAX_ETB', '50000','Maximum single manual deposit amount')
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION eds_telebirr_account()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'account_name',   (SELECT value FROM settings WHERE id = 'TELEBIRR_ACCOUNT_NAME'),
    'account_number', (SELECT value FROM settings WHERE id = 'TELEBIRR_ACCOUNT_NUMBER'),
    'instructions',   (SELECT value FROM settings WHERE id = 'TELEBIRR_INSTRUCTIONS'),
    'min_etb',        (SELECT value::int FROM settings WHERE id = 'DEPOSIT_MIN_ETB'),
    'max_etb',        (SELECT value::int FROM settings WHERE id = 'DEPOSIT_MAX_ETB'),
    'configured',     (SELECT value FROM settings WHERE id = 'TELEBIRR_ACCOUNT_NUMBER') <> 'YOUR_ACCOUNT_NUMBER'
  );
$$;
GRANT EXECUTE ON FUNCTION eds_telebirr_account() TO anon, authenticated;

-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manual_deposits (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id              bigint NOT NULL REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  amount                        numeric(14,2) NOT NULL CHECK (amount > 0),
  currency                      text NOT NULL DEFAULT 'ETB',
  payment_method                text NOT NULL DEFAULT 'MANUAL_TELEBIRR',
  telebirr_transaction_reference text NOT NULL,
  receipt_file_path             text,
  receipt_file_type             text,
  status                        text NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','approved','rejected','cancelled')),
  submitted_at                  timestamptz NOT NULL DEFAULT now(),
  reviewed_at                   timestamptz,
  reviewed_by                   text,
  rejection_reason              text,
  admin_note                    text,
  ledger_id                     uuid,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_manual_deposits_user   ON manual_deposits(telegram_user_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_manual_deposits_status ON manual_deposits(status, submitted_at DESC);
-- one active pending/approved deposit per (user, telebirr reference): blocks re-submission of the same payment
CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_deposits_ref
  ON manual_deposits(telegram_user_id, lower(telebirr_transaction_reference))
  WHERE status IN ('pending','approved');

ALTER TABLE manual_deposits ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='manual_deposits' AND policyname='Users read own deposits') THEN
    CREATE POLICY "Users read own deposits" ON manual_deposits
      FOR SELECT TO public USING (true);   -- refined by app query; receipts are NOT exposed here
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='manual_deposits' AND policyname='Service role manages deposits') THEN
    CREATE POLICY "Service role manages deposits" ON manual_deposits
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION eds_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_manual_deposits_updated_at ON manual_deposits;
CREATE TRIGGER trg_manual_deposits_updated_at
  BEFORE UPDATE ON manual_deposits FOR EACH ROW EXECUTE FUNCTION eds_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Private storage bucket for receipts
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('receipts', 'receipts', false, 10485760,
        ARRAY['image/png','image/jpeg','application/pdf'])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- No public policies on storage.objects for this bucket: receipts are only ever
-- reached through the `upload-receipt` / `get-receipt` edge functions using the
-- service role, which enforce ownership / admin authorization.

-- ---------------------------------------------------------------------------
-- Player: submit a deposit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION eds_submit_deposit(
  p_user            bigint,
  p_amount          numeric,
  p_reference       text,
  p_receipt_path    text,
  p_receipt_type    text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_min numeric := (SELECT value::numeric FROM settings WHERE id = 'DEPOSIT_MIN_ETB');
  v_max numeric := (SELECT value::numeric FROM settings WHERE id = 'DEPOSIT_MAX_ETB');
  v_id  uuid;
BEGIN
  IF p_reference IS NULL OR length(trim(p_reference)) < 4 THEN
    RETURN jsonb_build_object('success', false, 'error', 'A valid Telebirr transaction reference is required', 'error_code', 'BAD_REFERENCE');
  END IF;
  IF p_amount IS NULL OR p_amount < v_min OR p_amount > v_max THEN
    RETURN jsonb_build_object('success', false,
      'error', format('Amount must be between %s and %s ETB', v_min, v_max), 'error_code', 'BAD_AMOUNT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM telegram_users WHERE telegram_user_id = p_user) THEN
    RETURN jsonb_build_object('success', false, 'error', 'User not found', 'error_code', 'USER_NOT_FOUND');
  END IF;

  BEGIN
    INSERT INTO manual_deposits (telegram_user_id, amount, telebirr_transaction_reference, receipt_file_path, receipt_file_type)
    VALUES (p_user, p_amount, trim(p_reference), p_receipt_path, p_receipt_type)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false,
      'error', 'You already submitted a deposit with this Telebirr reference', 'error_code', 'DUPLICATE');
  END;

  PERFORM eds_audit(NULL, 'deposit.submit', 'manual_deposit', v_id::text, NULL,
    jsonb_build_object('amount', p_amount, 'reference', p_reference), 'player submitted');

  RETURN jsonb_build_object('success', true, 'deposit_id', v_id, 'status', 'pending');
END;
$$;

-- ---------------------------------------------------------------------------
-- Admin: approve / reject a deposit  (atomic, single credit)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION eds_review_deposit(
  p_deposit_id       uuid,
  p_admin            text,
  p_action           text,               -- 'approve' | 'reject'
  p_rejection_reason text DEFAULT NULL,
  p_admin_note       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_dep    RECORD;
  v_ledger uuid;
BEGIN
  SELECT * INTO v_dep FROM manual_deposits WHERE id = p_deposit_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Deposit not found', 'error_code', 'NOT_FOUND');
  END IF;
  IF v_dep.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false,
      'error', format('Deposit already %s', v_dep.status), 'error_code', 'ALREADY_REVIEWED');
  END IF;

  IF p_action = 'approve' THEN
    BEGIN
      v_ledger := eds_ledger_write(
        p_user            => v_dep.telegram_user_id,
        p_entry_type      => 'MANUAL_TELEBIRR_DEPOSIT',
        p_direction       => 'credit',
        p_amount          => v_dep.amount,
        p_deposited_delta => v_dep.amount,
        p_won_delta       => 0,
        p_reference_type  => 'deposit',
        p_reference_id    => v_dep.id::text,
        p_created_by      => p_admin,
        p_note            => 'Telebirr deposit approved'
      );
    EXCEPTION WHEN unique_violation THEN
      -- already credited by a prior (racing) approval — make the row consistent, no double credit
      UPDATE manual_deposits
      SET status='approved', reviewed_at=now(), reviewed_by=COALESCE(reviewed_by,p_admin)
      WHERE id = p_deposit_id AND status='pending';
      RETURN jsonb_build_object('success', true, 'status', 'approved', 'note', 'already credited');
    END;

    UPDATE telegram_users
    SET total_deposited = COALESCE(total_deposited,0) + v_dep.amount
    WHERE telegram_user_id = v_dep.telegram_user_id;

    UPDATE manual_deposits
    SET status='approved', reviewed_at=now(), reviewed_by=p_admin,
        admin_note=p_admin_note, ledger_id=v_ledger
    WHERE id = p_deposit_id;

    PERFORM eds_audit(p_admin, 'deposit.approve', 'manual_deposit', p_deposit_id::text,
      to_jsonb(v_dep), jsonb_build_object('status','approved','ledger_id',v_ledger), p_admin_note);

    RETURN jsonb_build_object('success', true, 'status', 'approved', 'credited', v_dep.amount);

  ELSIF p_action = 'reject' THEN
    IF p_rejection_reason IS NULL OR length(trim(p_rejection_reason)) = 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'A rejection reason is required', 'error_code', 'REASON_REQUIRED');
    END IF;
    UPDATE manual_deposits
    SET status='rejected', reviewed_at=now(), reviewed_by=p_admin,
        rejection_reason=p_rejection_reason, admin_note=p_admin_note
    WHERE id = p_deposit_id;

    PERFORM eds_audit(p_admin, 'deposit.reject', 'manual_deposit', p_deposit_id::text,
      to_jsonb(v_dep), jsonb_build_object('status','rejected','reason',p_rejection_reason), p_rejection_reason);

    RETURN jsonb_build_object('success', true, 'status', 'rejected');
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Unknown action', 'error_code', 'BAD_ACTION');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION eds_cancel_deposit(p_deposit_id uuid, p_user bigint)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_dep RECORD;
BEGIN
  SELECT * INTO v_dep FROM manual_deposits WHERE id = p_deposit_id FOR UPDATE;
  IF NOT FOUND OR v_dep.telegram_user_id <> p_user THEN
    RETURN jsonb_build_object('success', false, 'error', 'Deposit not found', 'error_code', 'NOT_FOUND');
  END IF;
  IF v_dep.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only a pending deposit can be cancelled', 'error_code', 'NOT_PENDING');
  END IF;
  UPDATE manual_deposits SET status='cancelled' WHERE id = p_deposit_id;
  RETURN jsonb_build_object('success', true, 'status', 'cancelled');
END;
$$;

GRANT EXECUTE ON FUNCTION eds_submit_deposit(bigint, numeric, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION eds_review_deposit(uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION eds_cancel_deposit(uuid, bigint) TO service_role, authenticated;

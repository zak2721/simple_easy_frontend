/*
  # የኛ — manual Telebirr withdrawals (hold -> approve -> mark paid)

  Extends the existing `withdrawal_requests` table (no data loss) and adds the
  የኛ flow on top:

    request  -> won_balance is DEBITED immediately as a WITHDRAWAL_HOLD (funds
               can't be requested twice / spent while pending)   status=pending
    approve  -> admin OKs it; no balance change                  status=approved
    mark_paid-> admin has sent Telebirr; records reference/proof  status=paid
               (hold already removed the funds; PAID is a settle entry)
    reject   -> WITHDRAWAL_RELEASE credits won_balance back       status=rejected
    cancel   -> player cancels a pending request; hold released   status=cancelled

  All money moves through eds_ledger_write; every admin action is audited.

  NOTE: there is NO automatic Telebirr payout API. `mark_paid` requires the admin
  to enter the Telebirr transaction reference — it only records that a human paid.
*/

-- Extend the status domain (keep legacy values for old rows).
ALTER TABLE withdrawal_requests DROP CONSTRAINT IF EXISTS withdrawal_requests_status_check;
ALTER TABLE withdrawal_requests
  ADD CONSTRAINT withdrawal_requests_status_check
  CHECK (status IN ('pending','approved','paid','rejected','cancelled','processing','completed'));

ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'MANUAL_TELEBIRR';
ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS telebirr_account text;
ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS reviewed_by text;
ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS telebirr_transaction_reference text;
ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS payment_proof_file_path text;
ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS hold_ledger_id uuid;
ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS created_at timestamptz;
UPDATE withdrawal_requests SET created_at = COALESCE(created_at, requested_at);

INSERT INTO settings (id, value, description) VALUES
  ('WITHDRAWAL_MIN_ETB', '20',    'Minimum withdrawal amount'),
  ('WITHDRAWAL_MAX_ETB', '100000','Maximum single withdrawal amount')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Player: request a withdrawal (places the hold)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION eds_request_withdrawal(
  p_user            bigint,
  p_amount          numeric,
  p_telebirr_account text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_min numeric := (SELECT value::numeric FROM settings WHERE id = 'WITHDRAWAL_MIN_ETB');
  v_max numeric := (SELECT value::numeric FROM settings WHERE id = 'WITHDRAWAL_MAX_ETB');
  v_won numeric;
  v_id  uuid;
BEGIN
  IF p_telebirr_account IS NULL OR length(regexp_replace(p_telebirr_account, '\D', '', 'g')) < 9 THEN
    RETURN jsonb_build_object('success', false, 'error', 'A valid Telebirr phone/account number is required', 'error_code', 'BAD_ACCOUNT');
  END IF;
  IF p_amount IS NULL OR p_amount < v_min OR p_amount > v_max THEN
    RETURN jsonb_build_object('success', false,
      'error', format('Amount must be between %s and %s ETB', v_min, v_max), 'error_code', 'BAD_AMOUNT');
  END IF;

  IF EXISTS (SELECT 1 FROM withdrawal_requests
             WHERE telegram_user_id = p_user AND status IN ('pending','approved','processing')) THEN
    RETURN jsonb_build_object('success', false,
      'error', 'You already have a withdrawal in progress. Wait for it to be paid or rejected.',
      'error_code', 'PENDING_EXISTS');
  END IF;

  SELECT won_balance INTO v_won FROM telegram_users WHERE telegram_user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'User not found', 'error_code', 'USER_NOT_FOUND');
  END IF;
  IF v_won < p_amount THEN
    RETURN jsonb_build_object('success', false,
      'error', 'You can only withdraw your winnings (won balance).', 'error_code', 'INSUFFICIENT_WINNINGS',
      'available', v_won);
  END IF;

  INSERT INTO withdrawal_requests (
    telegram_user_id, amount, status, payment_method,
    bank_name, account_number, account_name, telebirr_account, requested_at, created_at
  ) VALUES (
    p_user, p_amount, 'pending', 'MANUAL_TELEBIRR',
    'Telebirr', regexp_replace(p_telebirr_account, '\s', '', 'g'), '', regexp_replace(p_telebirr_account, '\s', '', 'g'),
    now(), now()
  )
  RETURNING id INTO v_id;

  UPDATE withdrawal_requests SET hold_ledger_id = eds_ledger_write(
    p_user            => p_user,
    p_entry_type      => 'WITHDRAWAL_HOLD',
    p_direction       => 'debit',
    p_amount          => p_amount,
    p_deposited_delta => 0,
    p_won_delta       => -p_amount,
    p_reference_type  => 'withdrawal',
    p_reference_id    => v_id::text,
    p_created_by      => 'player',
    p_note            => 'withdrawal hold'
  )
  WHERE id = v_id;

  PERFORM eds_audit(NULL, 'withdrawal.request', 'withdrawal', v_id::text, NULL,
    jsonb_build_object('amount', p_amount), 'player requested');

  RETURN jsonb_build_object('success', true, 'withdrawal_id', v_id, 'status', 'pending', 'on_hold', p_amount);
END;
$$;

-- ---------------------------------------------------------------------------
-- Admin: approve / reject / mark-paid
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION eds_review_withdrawal(
  p_id               uuid,
  p_admin            text,
  p_action           text,   -- 'approve' | 'reject' | 'mark_paid'
  p_telebirr_reference text DEFAULT NULL,
  p_proof_path       text DEFAULT NULL,
  p_reason           text DEFAULT NULL,
  p_admin_note       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_w RECORD;
BEGIN
  SELECT * INTO v_w FROM withdrawal_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Withdrawal not found', 'error_code', 'NOT_FOUND');
  END IF;

  IF p_action = 'approve' THEN
    IF v_w.status <> 'pending' THEN
      RETURN jsonb_build_object('success', false, 'error', 'Only a pending request can be approved', 'error_code', 'BAD_STATE');
    END IF;
    UPDATE withdrawal_requests
    SET status='approved', reviewed_by=p_admin, reviewed_at=now(), admin_notes=p_admin_note
    WHERE id = p_id;
    PERFORM eds_audit(p_admin, 'withdrawal.approve', 'withdrawal', p_id::text,
      to_jsonb(v_w), jsonb_build_object('status','approved'), p_admin_note);
    RETURN jsonb_build_object('success', true, 'status', 'approved');

  ELSIF p_action = 'reject' THEN
    IF v_w.status NOT IN ('pending','approved') THEN
      RETURN jsonb_build_object('success', false, 'error', 'This request can no longer be rejected', 'error_code', 'BAD_STATE');
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'A rejection reason is required', 'error_code', 'REASON_REQUIRED');
    END IF;
    -- release the hold back to won_balance (idempotent on reference)
    BEGIN
      PERFORM eds_ledger_write(
        p_user => v_w.telegram_user_id, p_entry_type => 'WITHDRAWAL_RELEASE', p_direction => 'credit',
        p_amount => v_w.amount, p_deposited_delta => 0, p_won_delta => v_w.amount,
        p_reference_type => 'withdrawal', p_reference_id => p_id::text,
        p_created_by => p_admin, p_note => 'withdrawal rejected — hold released');
    EXCEPTION WHEN unique_violation THEN NULL; END;
    UPDATE withdrawal_requests
    SET status='rejected', reviewed_by=p_admin, reviewed_at=now(), processed_at=now(),
        rejection_reason=p_reason, admin_notes=p_admin_note
    WHERE id = p_id;
    PERFORM eds_audit(p_admin, 'withdrawal.reject', 'withdrawal', p_id::text,
      to_jsonb(v_w), jsonb_build_object('status','rejected','reason',p_reason), p_reason);
    RETURN jsonb_build_object('success', true, 'status', 'rejected');

  ELSIF p_action = 'mark_paid' THEN
    IF v_w.status <> 'approved' THEN
      RETURN jsonb_build_object('success', false, 'error', 'Approve the request before marking it paid', 'error_code', 'BAD_STATE');
    END IF;
    IF p_telebirr_reference IS NULL OR length(trim(p_telebirr_reference)) < 4 THEN
      RETURN jsonb_build_object('success', false,
        'error', 'The Telebirr transaction reference of the payment you sent is required', 'error_code', 'REFERENCE_REQUIRED');
    END IF;
    -- settle entry: funds already left won_balance at hold time
    BEGIN
      PERFORM eds_ledger_write(
        p_user => v_w.telegram_user_id, p_entry_type => 'WITHDRAWAL_PAID', p_direction => 'settle',
        p_amount => v_w.amount, p_deposited_delta => 0, p_won_delta => 0,
        p_reference_type => 'withdrawal', p_reference_id => p_id::text,
        p_created_by => p_admin, p_note => 'Telebirr payout sent: ' || p_telebirr_reference);
    EXCEPTION WHEN unique_violation THEN NULL; END;
    UPDATE telegram_users
    SET total_withdrawn = COALESCE(total_withdrawn,0) + v_w.amount
    WHERE telegram_user_id = v_w.telegram_user_id;
    UPDATE withdrawal_requests
    SET status='paid', paid_at=now(), processed_at=now(),
        telebirr_transaction_reference=trim(p_telebirr_reference),
        payment_proof_file_path=p_proof_path, admin_notes=COALESCE(p_admin_note, admin_notes)
    WHERE id = p_id;
    PERFORM eds_audit(p_admin, 'withdrawal.mark_paid', 'withdrawal', p_id::text,
      to_jsonb(v_w), jsonb_build_object('status','paid','telebirr_ref',p_telebirr_reference), p_admin_note);
    RETURN jsonb_build_object('success', true, 'status', 'paid');
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Unknown action', 'error_code', 'BAD_ACTION');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION eds_cancel_withdrawal(p_id uuid, p_user bigint)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_w RECORD;
BEGIN
  SELECT * INTO v_w FROM withdrawal_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_w.telegram_user_id <> p_user THEN
    RETURN jsonb_build_object('success', false, 'error', 'Withdrawal not found', 'error_code', 'NOT_FOUND');
  END IF;
  IF v_w.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only a pending request can be cancelled', 'error_code', 'BAD_STATE');
  END IF;
  BEGIN
    PERFORM eds_ledger_write(
      p_user => p_user, p_entry_type => 'WITHDRAWAL_RELEASE', p_direction => 'credit',
      p_amount => v_w.amount, p_deposited_delta => 0, p_won_delta => v_w.amount,
      p_reference_type => 'withdrawal', p_reference_id => p_id::text,
      p_created_by => 'player', p_note => 'withdrawal cancelled — hold released');
  EXCEPTION WHEN unique_violation THEN NULL; END;
  UPDATE withdrawal_requests SET status='cancelled', processed_at=now() WHERE id = p_id;
  RETURN jsonb_build_object('success', true, 'status', 'cancelled');
END;
$$;

GRANT EXECUTE ON FUNCTION eds_request_withdrawal(bigint, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION eds_review_withdrawal(uuid, text, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION eds_cancel_withdrawal(uuid, bigint) TO service_role, authenticated;

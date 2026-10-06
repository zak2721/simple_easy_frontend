/*
  # የኛ — final hardening

  1. payout_winners(): distribute the winner-pool rounding remainder TO WINNERS
     (deterministic largest-remainder), so total paid to winners == the 80% pool
     EXACTLY and the house keeps EXACTLY 20%. Also record per-winner amounts in
     games.winner_payouts for the winner screen.
       (Pot is always a multiple of 5 -> pot*80/100 and pot*20/100 are exact
        integers; the only rounding is the split between N winners.)

  2. handle_referral_bonus(): route referral credits through the wallet ledger
     (ADJUSTMENT entries, idempotent per (referrer, referred)). No more direct
     balance writes. Amounts + the 20-referral cap come from `settings`.

  3. transfer_balance(): DISABLED for production. Player-to-player balance
     transfers bypass the deposit/withdrawal controls and enable collusion in a
     Bingo context. The function stays (so the bot never 500s) but always refuses.

  After this migration there is no live code path that changes a player balance
  outside eds_ledger_write().
*/

-- ---------------------------------------------------------------------------
-- 1. Winner payout — remainder to winners, exact 20% house
-- ---------------------------------------------------------------------------
ALTER TABLE games ADD COLUMN IF NOT EXISTS winner_payouts jsonb;

CREATE OR REPLACE FUNCTION payout_winners()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_winner_pct integer := (SELECT value::int FROM settings WHERE id = 'WINNER_PERCENTAGE');
  v_pot        numeric := COALESCE(NEW.total_pot, 0);
  v_pool       numeric := FLOOR(v_pot * v_winner_pct / 100.0);   -- the 80% winner pool (exact for pot % 5 = 0)
  v_ids        uuid[];
  v_n          integer;
  v_base       numeric;
  v_remainder  integer;
  v_i          integer := 0;
  v_amount     numeric;
  v_paid       numeric := 0;
  v_winner     uuid;
  v_uid        bigint;
  v_payouts    jsonb := '{}'::jsonb;
BEGIN
  IF NOT (NEW.status = 'finished' AND COALESCE(NEW.winners_paid, false) = false) THEN
    RETURN NEW;
  END IF;

  NEW.game_pot := v_pot;
  NEW.winner_prize_amount := v_pool;

  IF NEW.winner_ids IS NULL OR array_length(NEW.winner_ids, 1) IS NULL OR array_length(NEW.winner_ids, 1) = 0 THEN
    NEW.house_share_amount := 0;   -- no winner: stakes refunded elsewhere, house takes nothing
    NEW.winner_payouts := '{}'::jsonb;
    NEW.winners_paid := true;
    RETURN NEW;
  END IF;

  -- deterministic winner order (stable across retries)
  SELECT array_agg(w ORDER BY w) INTO v_ids FROM unnest(NEW.winner_ids) AS w;
  v_n := array_length(v_ids, 1);
  v_base := FLOOR(v_pool / v_n);
  v_remainder := (v_pool - v_base * v_n)::int;   -- 0 .. n-1, distributed 1 ETB each to the first `remainder` winners

  FOREACH v_winner IN ARRAY v_ids LOOP
    v_i := v_i + 1;
    v_amount := v_base + CASE WHEN v_i <= v_remainder THEN 1 ELSE 0 END;

    SELECT telegram_user_id INTO v_uid FROM players WHERE id = v_winner;
    IF v_uid IS NULL THEN CONTINUE; END IF;

    BEGIN
      PERFORM eds_ledger_write(
        p_user            => v_uid,
        p_entry_type      => 'WINNING_CREDIT',
        p_direction       => 'credit',
        p_amount          => v_amount,
        p_deposited_delta => 0,
        p_won_delta       => v_amount,
        p_reference_type  => 'game',
        p_reference_id    => NEW.id::text || ':' || v_winner::text,
        p_game_id         => NEW.id,
        p_player_id       => v_winner,
        p_created_by      => 'system',
        p_note            => format('Bingo winnings (80%% pool, %s winner(s))', v_n)
      );
      UPDATE telegram_users
      SET total_won = COALESCE(total_won, 0) + v_amount,
          win_count = COALESCE(win_count, 0) + 1
      WHERE telegram_user_id = v_uid;
    EXCEPTION WHEN unique_violation THEN
      NULL; -- already paid for this game+player
    END;

    v_paid := v_paid + v_amount;
    v_payouts := v_payouts || jsonb_build_object(v_winner::text, v_amount);
  END LOOP;

  -- winners got the whole pool; house is exactly pot - pool (== 20% for pot % 5 = 0)
  NEW.winner_prize_each := v_base;   -- informational base; winner_payouts has the exact per-winner values
  NEW.winner_payouts := v_payouts;
  NEW.house_share_amount := v_pot - v_pool;

  IF NEW.house_share_amount > 0 THEN
    BEGIN
      PERFORM eds_ledger_write(
        p_user            => NULL,
        p_entry_type      => 'HOUSE_REVENUE',
        p_direction       => 'credit',
        p_amount          => NEW.house_share_amount,
        p_deposited_delta => 0,
        p_won_delta       => 0,
        p_reference_type  => 'game',
        p_reference_id    => NEW.id::text,
        p_game_id         => NEW.id,
        p_created_by      => 'system',
        p_note            => 'የኛ house share (20%)'
      );
    EXCEPTION WHEN unique_violation THEN NULL; END;
  END IF;

  -- integrity guard: winners must never exceed the pool
  IF v_paid > v_pool THEN
    RAISE EXCEPTION 'payout_winners: paid % exceeds winner pool % for game %', v_paid, v_pool, NEW.id;
  END IF;

  NEW.winners_paid := true;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payout_on_game_finish ON games;
CREATE TRIGGER payout_on_game_finish
  BEFORE UPDATE ON games
  FOR EACH ROW
  WHEN (NEW.status = 'finished' AND OLD.status <> 'finished')
  EXECUTE FUNCTION payout_winners();

-- ---------------------------------------------------------------------------
-- 2. Referral bonus through the ledger
-- ---------------------------------------------------------------------------
INSERT INTO settings (id, value, description) VALUES
  ('REFERRAL_BONUS_REFERRER', '10', 'ETB credited to the referrer per new player'),
  ('REFERRAL_BONUS_NEW_USER', '10', 'ETB credited to the new player who used a referral code'),
  ('REFERRAL_MAX', '20', 'Maximum referrals rewarded per user')
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION handle_referral_bonus(
  new_user_telegram_id bigint,
  referrer_code text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ref_id   bigint;
  v_count    integer;
  v_max      integer := (SELECT value::int FROM settings WHERE id = 'REFERRAL_MAX');
  v_b_ref    numeric := (SELECT value::numeric FROM settings WHERE id = 'REFERRAL_BONUS_REFERRER');
  v_b_new    numeric := (SELECT value::numeric FROM settings WHERE id = 'REFERRAL_BONUS_NEW_USER');
BEGIN
  SELECT telegram_user_id INTO v_ref_id FROM telegram_users WHERE referral_code = referrer_code LIMIT 1;
  IF v_ref_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Invalid referral code');
  END IF;
  IF v_ref_id = new_user_telegram_id THEN
    RETURN json_build_object('success', false, 'error', 'Cannot refer yourself');
  END IF;

  SELECT COALESCE(total_referrals, 0) INTO v_count FROM telegram_users WHERE telegram_user_id = v_ref_id;
  IF v_count >= v_max THEN
    RETURN json_build_object('success', false, 'error', format('Referrer reached the %s-referral limit', v_max));
  END IF;

  IF EXISTS (SELECT 1 FROM referral_bonuses WHERE referrer_id = v_ref_id AND referred_id = new_user_telegram_id) THEN
    RETURN json_build_object('success', false, 'error', 'Referral bonus already claimed');
  END IF;

  UPDATE telegram_users SET referred_by = v_ref_id WHERE telegram_user_id = new_user_telegram_id;

  IF v_b_new > 0 THEN
    BEGIN
      PERFORM eds_ledger_write(
        p_user => new_user_telegram_id, p_entry_type => 'ADJUSTMENT', p_direction => 'credit',
        p_amount => v_b_new, p_deposited_delta => v_b_new, p_won_delta => 0,
        p_reference_type => 'referral', p_reference_id => format('%s:new:%s', v_ref_id, new_user_telegram_id),
        p_created_by => 'system', p_note => 'referral welcome bonus');
    EXCEPTION WHEN unique_violation THEN NULL; END;
  END IF;

  IF v_b_ref > 0 THEN
    BEGIN
      PERFORM eds_ledger_write(
        p_user => v_ref_id, p_entry_type => 'ADJUSTMENT', p_direction => 'credit',
        p_amount => v_b_ref, p_deposited_delta => v_b_ref, p_won_delta => 0,
        p_reference_type => 'referral', p_reference_id => format('%s:ref:%s', v_ref_id, new_user_telegram_id),
        p_created_by => 'system', p_note => 'referral bonus');
    EXCEPTION WHEN unique_violation THEN NULL; END;
  END IF;

  UPDATE telegram_users SET total_referrals = COALESCE(total_referrals, 0) + 1 WHERE telegram_user_id = v_ref_id;
  INSERT INTO referral_bonuses (referrer_id, referred_id, bonus_amount) VALUES (v_ref_id, new_user_telegram_id, v_b_ref);

  PERFORM eds_audit('system', 'referral.bonus', 'telegram_user', new_user_telegram_id::text, NULL,
    json_build_object('referrer', v_ref_id, 'referrer_bonus', v_b_ref, 'new_user_bonus', v_b_new)::jsonb, NULL);

  RETURN json_build_object('success', true, 'referrer_bonus', v_b_ref, 'new_user_bonus', v_b_new);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Disable player-to-player balance transfer
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION transfer_balance(
  from_telegram_id bigint,
  transfer_amount integer,
  to_telegram_id bigint,
  balance_type_param text DEFAULT 'won'
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN json_build_object(
    'success', false,
    'error', 'Balance transfers are disabled. Deposit and withdraw via Telebirr instead.',
    'error_code', 'FEATURE_DISABLED'
  );
END;
$$;
COMMENT ON FUNCTION transfer_balance(bigint, integer, bigint, text) IS
  'DISABLED for የኛ production — always refuses. Kept only so the bot does not error.';

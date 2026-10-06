/*
  # የኛ — refund stakes when a game finishes with NO winner

  The original project refunded all stakes if a round ended with nobody
  completing a pattern (the "No Winners — stakes refunded" screen). When the
  legacy stake triggers were removed (20260906130000) that refund was lost.

  This restores it inside payout_winners(): if a game flips to 'finished' with
  an empty winner_ids, every participating cartela's entry_price is refunded to
  the player's deposited_balance via a REFUND ledger row (idempotent per
  game+player), and the house takes nothing.

  Games WITH winners are unchanged (winners split the 80% pool, house keeps 20%).
*/

CREATE OR REPLACE FUNCTION payout_winners()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_winner_pct integer := (SELECT value::int FROM settings WHERE id = 'WINNER_PERCENTAGE');
  v_pot        numeric := COALESCE(NEW.total_pot, 0);
  v_pool       numeric := FLOOR(v_pot * v_winner_pct / 100.0);
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
  v_row        RECORD;
BEGIN
  IF NOT (NEW.status = 'finished' AND COALESCE(NEW.winners_paid, false) = false) THEN
    RETURN NEW;
  END IF;

  NEW.game_pot := v_pot;

  -- ---- NO WINNER: refund every participating cartela ----
  IF NEW.winner_ids IS NULL OR array_length(NEW.winner_ids, 1) IS NULL OR array_length(NEW.winner_ids, 1) = 0 THEN
    NEW.winner_prize_amount := 0;
    NEW.house_share_amount := 0;
    NEW.winner_prize_each := 0;
    NEW.winner_payouts := '{}'::jsonb;

    FOR v_row IN
      SELECT id, telegram_user_id, entry_price, room_type, selected_number
      FROM players WHERE game_id = NEW.id AND stake_paid = true
    LOOP
      BEGIN
        PERFORM eds_ledger_write(
          p_user            => v_row.telegram_user_id,
          p_entry_type      => 'REFUND',
          p_direction       => 'credit',
          p_amount          => v_row.entry_price,
          p_deposited_delta => v_row.entry_price,
          p_won_delta       => 0,
          p_reference_type  => 'game_refund',
          p_reference_id    => NEW.id::text || ':' || v_row.id::text,
          p_game_id         => NEW.id,
          p_player_id       => v_row.id,
          p_created_by      => 'system',
          p_note            => format('no-winner refund — %s cartela #%s', v_row.room_type, v_row.selected_number)
        );
        UPDATE telegram_users
        SET total_spent = GREATEST(0, COALESCE(total_spent, 0) - v_row.entry_price)
        WHERE telegram_user_id = v_row.telegram_user_id;
      EXCEPTION WHEN unique_violation THEN
        NULL; -- already refunded
      END;
    END LOOP;

    NEW.winners_paid := true;
    RETURN NEW;
  END IF;

  -- ---- WINNER(S): 80% pool to winners (remainder to first winners), house exactly 20% ----
  NEW.winner_prize_amount := v_pool;

  SELECT array_agg(w ORDER BY w) INTO v_ids FROM unnest(NEW.winner_ids) AS w;
  v_n := array_length(v_ids, 1);
  v_base := FLOOR(v_pool / v_n);
  v_remainder := (v_pool - v_base * v_n)::int;

  FOREACH v_winner IN ARRAY v_ids LOOP
    v_i := v_i + 1;
    v_amount := v_base + CASE WHEN v_i <= v_remainder THEN 1 ELSE 0 END;

    SELECT telegram_user_id INTO v_uid FROM players WHERE id = v_winner;
    IF v_uid IS NULL THEN CONTINUE; END IF;

    BEGIN
      PERFORM eds_ledger_write(
        p_user => v_uid, p_entry_type => 'WINNING_CREDIT', p_direction => 'credit',
        p_amount => v_amount, p_deposited_delta => 0, p_won_delta => v_amount,
        p_reference_type => 'game', p_reference_id => NEW.id::text || ':' || v_winner::text,
        p_game_id => NEW.id, p_player_id => v_winner, p_created_by => 'system',
        p_note => format('Bingo winnings (80%% pool, %s winner(s))', v_n));
      UPDATE telegram_users
      SET total_won = COALESCE(total_won, 0) + v_amount, win_count = COALESCE(win_count, 0) + 1
      WHERE telegram_user_id = v_uid;
    EXCEPTION WHEN unique_violation THEN NULL; END;

    v_paid := v_paid + v_amount;
    v_payouts := v_payouts || jsonb_build_object(v_winner::text, v_amount);
  END LOOP;

  NEW.winner_prize_each := v_base;
  NEW.winner_payouts := v_payouts;
  NEW.house_share_amount := v_pot - v_pool;

  IF NEW.house_share_amount > 0 THEN
    BEGIN
      PERFORM eds_ledger_write(
        p_user => NULL, p_entry_type => 'HOUSE_REVENUE', p_direction => 'credit',
        p_amount => NEW.house_share_amount, p_deposited_delta => 0, p_won_delta => 0,
        p_reference_type => 'game', p_reference_id => NEW.id::text,
        p_game_id => NEW.id, p_created_by => 'system', p_note => 'የኛ house share (20%)');
    EXCEPTION WHEN unique_violation THEN NULL; END;
  END IF;

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

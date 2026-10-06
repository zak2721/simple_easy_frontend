/*
  # የኛ — 80/20 prize payout through the ledger

  The original `payout_winners()` trigger credited `won_balance` directly on game
  finish with no ledger row and no house-revenue record. This migration replaces
  it so that:

    - each winner is credited via eds_ledger_write('WINNING_CREDIT') — idempotent
      on (game_id:player_id), so a duplicate finish can never double-pay
    - the house 20% is recorded as a HOUSE_REVENUE ledger row (no player balance)
    - games.winner_prize_amount / house_share_amount / game_pot are stamped

  Prize math (authoritative, backend only):
    game_pot            = SUM(players.entry_price) for the game  (== total_pot)
    winner_prize_amount = FLOOR(game_pot * WINNER_PERCENTAGE / 100)   [the 80% pool]
    house_share_amount  = game_pot - winner_prize_amount
    winner_prize_each   = FLOOR(winner_prize_amount / number_of_winners)
    (any rounding remainder stays with the house)
*/

ALTER TABLE games ADD COLUMN IF NOT EXISTS game_pot numeric(14,2);
ALTER TABLE games ADD COLUMN IF NOT EXISTS winner_prize_amount numeric(14,2);
ALTER TABLE games ADD COLUMN IF NOT EXISTS house_share_amount numeric(14,2);

CREATE OR REPLACE FUNCTION payout_winners()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_winner_pct  integer := (SELECT value::int FROM settings WHERE id = 'WINNER_PERCENTAGE');
  v_pot         numeric := COALESCE(NEW.total_pot, 0);
  v_prize_pool  numeric := FLOOR(v_pot * v_winner_pct / 100.0);
  v_n           integer;
  v_each        numeric;
  v_paid_total  numeric := 0;
  v_winner      uuid;
  v_uid         bigint;
BEGIN
  IF NOT (NEW.status = 'finished' AND COALESCE(NEW.winners_paid, false) = false) THEN
    RETURN NEW;
  END IF;

  NEW.game_pot := v_pot;
  NEW.winner_prize_amount := v_prize_pool;

  IF NEW.winner_ids IS NULL OR array_length(NEW.winner_ids, 1) IS NULL OR array_length(NEW.winner_ids, 1) = 0 THEN
    -- No winner: stakes are refunded elsewhere; house takes nothing.
    NEW.house_share_amount := 0;
    NEW.winners_paid := true;
    RETURN NEW;
  END IF;

  v_n := array_length(NEW.winner_ids, 1);
  v_each := FLOOR(v_prize_pool / v_n);
  NEW.winner_prize_each := v_each;

  FOREACH v_winner IN ARRAY NEW.winner_ids LOOP
    SELECT telegram_user_id INTO v_uid FROM players WHERE id = v_winner;
    IF v_uid IS NULL THEN CONTINUE; END IF;
    BEGIN
      PERFORM eds_ledger_write(
        p_user            => v_uid,
        p_entry_type      => 'WINNING_CREDIT',
        p_direction       => 'credit',
        p_amount          => v_each,
        p_deposited_delta => 0,
        p_won_delta       => v_each,
        p_reference_type  => 'game',
        p_reference_id    => NEW.id::text || ':' || v_winner::text,
        p_game_id         => NEW.id,
        p_player_id       => v_winner,
        p_created_by      => 'system',
        p_note            => 'Bingo winnings (80% pool split ' || v_n || ' way(s))'
      );
      UPDATE telegram_users
      SET total_won = COALESCE(total_won,0) + v_each,
          win_count = COALESCE(win_count,0) + 1
      WHERE telegram_user_id = v_uid;
      v_paid_total := v_paid_total + v_each;
    EXCEPTION WHEN unique_violation THEN
      -- already paid for this game+player
      v_paid_total := v_paid_total + v_each;
    END;
  END LOOP;

  -- Everything not paid to winners is house revenue (20% + rounding remainder).
  NEW.house_share_amount := v_pot - v_paid_total;
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

  NEW.winners_paid := true;
  RETURN NEW;
END;
$$;

-- keep the trigger definition from 20251218160619 (BEFORE UPDATE, status->finished)
DROP TRIGGER IF EXISTS payout_on_game_finish ON games;
CREATE TRIGGER payout_on_game_finish
  BEFORE UPDATE ON games
  FOR EACH ROW
  WHEN (NEW.status = 'finished' AND OLD.status <> 'finished')
  EXECUTE FUNCTION payout_winners();

COMMENT ON FUNCTION payout_winners() IS
  'የኛ: credits winners (WINNING_CREDIT) and records house 20% (HOUSE_REVENUE) via wallet_ledger on game finish. Idempotent per game+player.';

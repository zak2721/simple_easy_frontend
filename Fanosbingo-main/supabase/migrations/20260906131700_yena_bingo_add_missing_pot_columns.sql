/*
  # የኛ — add games.pot_amount / house_pot_amount

  Audit finding (caught by running every migration + eds_select_cartela on a real
  Postgres): `eds_select_cartela()` / `eds_refund_cartela()` (migration
  20260906130200) write `games.pot_amount` and `games.house_pot_amount`, but
  those columns were never actually added to the table — several LEGACY functions
  (`payout_winners` v1, `refund_player_stake`) referenced them too, on code paths
  that apparently never ran. `eds_select_cartela` returned
  {error_code: INTERNAL_ERROR, error: 'column "pot_amount" does not exist'}.

  Fix: add the columns (integer running totals, kept in sync alongside
  `total_pot`). Cheaper and lower-risk than re-pasting the 100-line functions;
  also makes the legacy references valid.

  Authoritative money columns remain `total_pot` (running), and
  `game_pot` / `winner_prize_amount` / `house_share_amount` / `winner_payouts`
  (stamped by payout_winners() at finish).
*/

ALTER TABLE games ADD COLUMN IF NOT EXISTS pot_amount       integer NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN IF NOT EXISTS house_pot_amount integer NOT NULL DEFAULT 0;

-- backfill from total_pot for any in-flight rows
UPDATE games SET pot_amount = COALESCE(total_pot, 0) WHERE pot_amount = 0 AND COALESCE(total_pot,0) <> 0;

COMMENT ON COLUMN games.pot_amount IS 'Running pot total (kept in sync with total_pot by eds_select_cartela / eds_refund_cartela).';
COMMENT ON COLUMN games.house_pot_amount IS 'Running estimate of the 20% house share while the game is open; the final value is house_share_amount (set at finish).';

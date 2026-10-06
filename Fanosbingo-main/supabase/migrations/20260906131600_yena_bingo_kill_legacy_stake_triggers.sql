/*
  # የኛ — remove EVERY legacy money-moving trigger on `players`

  Audit finding: `20260906130000` dropped `deduct_stake_on_join`,
  `deduct_stake_on_player_insert`, `update_pot_on_player_join`,
  `refund_on_player_delete` — but it MISSED `deduct_stake_on_player_join`
  (created in `20251213125251_add_spending_tracking`, never dropped by any
  original migration). That trigger runs `deduct_stake_from_balance()` on every
  INSERT into `players`, which would DOUBLE-charge the player when
  `eds_select_cartela()` inserts a cartela (it already debits the wallet + writes
  the ledger itself), and the trigger's deduction is not ledgered.

  This migration drops every known legacy stake/pot/refund trigger on `players`
  by name (idempotent), then hard-asserts that no trigger on `players` still
  touches `telegram_users` or `games`. The only trigger that should remain on
  `players` is `player_changes_trigger` (Realtime broadcast — no money).

  After this migration `eds_select_cartela()` / `eds_refund_cartela()` +
  `payout_winners()` are the ONLY code that changes a balance or a game pot.
*/

DROP TRIGGER IF EXISTS deduct_stake_on_player_join   ON players;
DROP TRIGGER IF EXISTS deduct_stake_on_player_insert ON players;
DROP TRIGGER IF EXISTS deduct_stake_on_join          ON players;
DROP TRIGGER IF EXISTS deduct_stake_on_join_trigger  ON players;
DROP TRIGGER IF EXISTS deduct_balance_on_join        ON players;
DROP TRIGGER IF EXISTS update_pot_on_player_join     ON players;
DROP TRIGGER IF EXISTS update_game_pot_on_join       ON players;
DROP TRIGGER IF EXISTS refund_on_player_delete       ON players;
DROP TRIGGER IF EXISTS refund_stake_on_player_delete ON players;
DROP TRIGGER IF EXISTS refund_player_stake_trigger   ON players;

-- The legacy functions can stay (harmless once no trigger calls them), but make
-- the intent explicit.
COMMENT ON FUNCTION deduct_stake_from_balance() IS
  'DEAD — no trigger calls this. የኛ money flows through eds_select_cartela / eds_ledger_write.';

-- Hard guard: fail the migration if any BEFORE/AFTER trigger on `players`
-- (other than the Realtime broadcast) still references telegram_users or games.
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(t.tgname, ', ')
  INTO v_bad
  FROM pg_trigger t
  JOIN pg_class c   ON c.oid = t.tgrelid AND c.relname = 'players'
  JOIN pg_proc  p   ON p.oid = t.tgfoid
  WHERE NOT t.tgisinternal
    AND t.tgname <> 'player_changes_trigger'
    AND pg_get_functiondef(p.oid) ~* '(telegram_users|UPDATE games|games\s+SET)';

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Legacy money trigger(s) still on players: %', v_bad;
  END IF;
END $$;

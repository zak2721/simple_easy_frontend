/*
  የኛ — SQL verification script.

  Run against a STAGING database that already has every migration applied:

      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/yena_bingo_verification.sql

  The whole script runs in one transaction and ROLLS BACK at the end, so it
  leaves no data behind. Any failed ASSERT aborts with a clear message.

  Covers implementation-plan phases 51-56: cartela limit, both rooms, deposits,
  withdrawals, winner payout, and no-double-credit.
*/
BEGIN;
SET LOCAL client_min_messages = warning;

DO $$
DECLARE
  v_uid   bigint := 999000001;
  v_uid2  bigint := 999000002;
  v_game  uuid;
  r       jsonb;
  v_dep   uuid;
  v_wd    uuid;
  v_won   numeric;
  v_ledger_count int;
BEGIN
  ---------------------------------------------------------------------------
  RAISE NOTICE '1. config invariants';
  ASSERT (eds_config()->>'standard_total_cartelas')::int = 600, 'total cartelas != 600';
  ASSERT (eds_config()->>'etb5_capacity')::int = 400 AND (eds_config()->>'etb10_capacity')::int = 200, 'room capacities wrong';
  ASSERT (eds_config()->>'winner_percentage')::int + (eds_config()->>'house_percentage')::int = 100, 'split != 100';
  ASSERT (eds_config()->>'max_cartelas_per_player')::int = 4, 'limit != 4';

  ---------------------------------------------------------------------------
  RAISE NOTICE '2. test players with balance';
  INSERT INTO telegram_users (telegram_user_id, telegram_first_name, balance, deposited_balance, won_balance)
  VALUES (v_uid, 'Tester', 1000, 1000, 0), (v_uid2, 'Tester2', 1000, 1000, 0)
  ON CONFLICT (telegram_user_id) DO UPDATE SET deposited_balance = 1000, won_balance = 0, balance = 1000;

  RAISE NOTICE '3. fresh waiting game';
  INSERT INTO games (status, host_id, called_numbers, game_number, starts_at, winner_ids, stake_amount, total_pot, winner_prize, winner_prize_each)
  VALUES ('waiting', 'test', '{}', (SELECT COALESCE(MAX(game_number),0)+1 FROM games), now() + interval '10 minutes', '{}', 5, 0, 0, 0)
  RETURNING id INTO v_game;
  UPDATE games SET selection_closed_at = starts_at - interval '5 seconds' WHERE id = v_game;

  ---------------------------------------------------------------------------
  RAISE NOTICE '4. cartela range enforcement';
  r := eds_select_cartela(v_game, 'etb10', 201, v_uid, 'Tester');
  ASSERT r->>'error_code' = 'CARTELA_OUT_OF_RANGE', 'ETB10 #201 should be rejected';
  r := eds_select_cartela(v_game, 'etb5', 401, v_uid, 'Tester');
  ASSERT r->>'error_code' = 'CARTELA_OUT_OF_RANGE', 'ETB5 #401 should be rejected';

  RAISE NOTICE '5. buy 4 across BOTH rooms -> ok';
  ASSERT (eds_select_cartela(v_game, 'etb5',  10, v_uid, 'Tester')->>'success')::bool, 'etb5 #10 failed';
  ASSERT (eds_select_cartela(v_game, 'etb5',  11, v_uid, 'Tester')->>'success')::bool, 'etb5 #11 failed';
  ASSERT (eds_select_cartela(v_game, 'etb10',  8, v_uid, 'Tester')->>'success')::bool, 'etb10 #8 failed';
  ASSERT (eds_select_cartela(v_game, 'etb10',  9, v_uid, 'Tester')->>'success')::bool, 'etb10 #9 failed';
  ASSERT (eds_player_cartela_count(v_game, v_uid)->>'total')::int = 4, 'count != 4';

  RAISE NOTICE '6. the 5th (either room) -> LIMIT_REACHED';
  ASSERT eds_select_cartela(v_game, 'etb5',  12, v_uid, 'Tester')->>'error_code' = 'LIMIT_REACHED', '5th etb5 not blocked';
  ASSERT eds_select_cartela(v_game, 'etb10', 10, v_uid, 'Tester')->>'error_code' = 'LIMIT_REACHED', '5th etb10 not blocked';

  RAISE NOTICE '7. balance was debited (deposited-first): 2*5 + 2*10 = 30';
  SELECT deposited_balance INTO v_won FROM telegram_users WHERE telegram_user_id = v_uid;
  ASSERT v_won = 970, format('expected deposited 970, got %s', v_won);
  ASSERT (SELECT COUNT(*) FROM wallet_ledger WHERE telegram_user_id = v_uid AND entry_type = 'GAME_ENTRY') = 4, 'ledger GAME_ENTRY count != 4';

  RAISE NOTICE '8. pot = 30, winner_prize = 24 (80 pct)';
  ASSERT (SELECT total_pot FROM games WHERE id = v_game) = 30, 'pot != 30';
  ASSERT (SELECT winner_prize FROM games WHERE id = v_game) = 24, 'winner_prize != 24';

  RAISE NOTICE '9. cartela taken by someone else';
  ASSERT eds_select_cartela(v_game, 'etb5', 10, v_uid2, 'Tester2')->>'error_code' = 'CARTELA_TAKEN', 'shared cartela not blocked';
  -- but ETB10 #10 (different room, same number) is fine
  ASSERT (eds_select_cartela(v_game, 'etb10', 10, v_uid2, 'Tester2')->>'success')::bool, 'etb10 #10 should be free for uid2';

  ---------------------------------------------------------------------------
  RAISE NOTICE '10. manual deposit: submit -> approve credits ONCE';
  r := eds_submit_deposit(v_uid, 100, 'TESTREF123', 'x/y.png', 'image/png');
  ASSERT (r->>'success')::bool, 'deposit submit failed';
  v_dep := (r->>'deposit_id')::uuid;
  r := eds_review_deposit(v_dep, 'tester-admin', 'approve');
  ASSERT (r->>'success')::bool, 'deposit approve failed';
  -- second approve must NOT double-credit
  r := eds_review_deposit(v_dep, 'tester-admin', 'approve');
  ASSERT (r->>'error_code') = 'ALREADY_REVIEWED' OR (r->>'note') = 'already credited', 'double approve not guarded';
  SELECT COUNT(*) INTO v_ledger_count FROM wallet_ledger
    WHERE entry_type = 'MANUAL_TELEBIRR_DEPOSIT' AND reference_id = v_dep::text;
  ASSERT v_ledger_count = 1, format('expected 1 deposit ledger row, got %s', v_ledger_count);

  ---------------------------------------------------------------------------
  RAISE NOTICE '11. withdrawal hold / release';
  UPDATE telegram_users SET won_balance = 200, balance = deposited_balance + 200 WHERE telegram_user_id = v_uid;
  r := eds_request_withdrawal(v_uid, 150, '0912345678');
  ASSERT (r->>'success')::bool, 'withdrawal request failed';
  v_wd := (r->>'withdrawal_id')::uuid;
  SELECT won_balance INTO v_won FROM telegram_users WHERE telegram_user_id = v_uid;
  ASSERT v_won = 50, format('hold not applied, won=%s', v_won);
  -- a second concurrent request is refused
  ASSERT eds_request_withdrawal(v_uid, 25, '0912345678')->>'error_code' = 'PENDING_EXISTS', 'second withdrawal not blocked';
  -- reject -> release
  r := eds_review_withdrawal(v_wd, 'tester-admin', 'reject', NULL, NULL, 'test reject');
  ASSERT (r->>'success')::bool, 'reject failed';
  SELECT won_balance INTO v_won FROM telegram_users WHERE telegram_user_id = v_uid;
  ASSERT v_won = 200, format('hold not released, won=%s', v_won);

  RAISE NOTICE '12. withdrawal approve -> mark_paid requires reference';
  r := eds_request_withdrawal(v_uid, 100, '0912345678');
  v_wd := (r->>'withdrawal_id')::uuid;
  ASSERT (eds_review_withdrawal(v_wd, 'tester-admin', 'approve')->>'success')::bool, 'approve failed';
  ASSERT eds_review_withdrawal(v_wd, 'tester-admin', 'mark_paid', NULL)->>'error_code' = 'REFERENCE_REQUIRED', 'mark_paid without ref not blocked';
  ASSERT (eds_review_withdrawal(v_wd, 'tester-admin', 'mark_paid', 'TELEBIRR-OUT-1')->>'success')::bool, 'mark_paid failed';
  SELECT won_balance INTO v_won FROM telegram_users WHERE telegram_user_id = v_uid;
  ASSERT v_won = 100, format('paid balance wrong, won=%s', v_won);

  ---------------------------------------------------------------------------
  RAISE NOTICE '13. single-winner 80/20 through the ledger';
  UPDATE games SET status = 'playing', started_at = now() WHERE id = v_game;
  UPDATE games SET winner_ids = ARRAY[(SELECT id FROM players WHERE game_id = v_game AND telegram_user_id = v_uid LIMIT 1)]
   WHERE id = v_game;
  UPDATE games SET status = 'finished', finished_at = now() WHERE id = v_game;  -- fires payout_winners()
  -- pot here is 40 (uid: 2x5 + 2x10 = 30, uid2: 1x10 = 10). 80% = 32, house = 8.
  ASSERT (SELECT winners_paid FROM games WHERE id = v_game), 'winners_paid not set';
  ASSERT (SELECT total_pot FROM games WHERE id = v_game) = 40, format('pot != 40 (got %s)', (SELECT total_pot FROM games WHERE id = v_game));
  ASSERT (SELECT winner_prize_amount FROM games WHERE id = v_game) = 32, format('winner pool != 32, got %s', (SELECT winner_prize_amount FROM games WHERE id = v_game));
  ASSERT (SELECT house_share_amount FROM games WHERE id = v_game) = 8, format('house != 8 (exactly 20 pct of 40), got %s', (SELECT house_share_amount FROM games WHERE id = v_game));
  ASSERT (SELECT COALESCE(SUM(amount),0) FROM wallet_ledger WHERE entry_type='WINNING_CREDIT' AND related_game_id=v_game) = 32, 'winner not paid the full pool';
  ASSERT (SELECT COUNT(*) FROM wallet_ledger WHERE entry_type = 'WINNING_CREDIT' AND related_game_id = v_game) = 1, 'winner not credited once';
  ASSERT (SELECT COUNT(*) FROM wallet_ledger WHERE entry_type = 'HOUSE_REVENUE'  AND related_game_id = v_game) = 1, 'house revenue not recorded';

  RAISE NOTICE '13b. re-finish must not double pay';
  UPDATE games SET status = 'playing' WHERE id = v_game;
  UPDATE games SET status = 'finished' WHERE id = v_game;
  ASSERT (SELECT COALESCE(SUM(amount),0) FROM wallet_ledger WHERE entry_type='WINNING_CREDIT' AND related_game_id=v_game) = 32, 'winner double-paid on re-finish';

  ---------------------------------------------------------------------------
  RAISE NOTICE '14. multi-winner split — remainder to winners, house EXACTLY 20 pct';
  DECLARE
    v_game2 uuid;
    v_p1 uuid; v_p2 uuid; v_p3 uuid;
    v_paid numeric; v_house numeric; v_pool numeric;
  BEGIN
    -- fresh game, 3 ETB5 cartelas by 3 users => pot 15, pool 12, house 3
    INSERT INTO telegram_users (telegram_user_id, telegram_first_name, deposited_balance, won_balance, balance)
    VALUES (999000003,'W3',100,0,100) ON CONFLICT (telegram_user_id) DO UPDATE SET deposited_balance=100;
    INSERT INTO games (status, host_id, called_numbers, game_number, starts_at, winner_ids, stake_amount, total_pot, winner_prize, winner_prize_each)
    VALUES ('waiting','test','{}',(SELECT COALESCE(MAX(game_number),0)+1 FROM games), now()+interval '10 min','{}',5,0,0,0)
    RETURNING id INTO v_game2;
    UPDATE games SET selection_closed_at = starts_at - interval '5 seconds' WHERE id = v_game2;

    v_p1 := (eds_select_cartela(v_game2,'etb5',101,v_uid, 'W1')->>'player_id')::uuid;
    v_p2 := (eds_select_cartela(v_game2,'etb5',102,v_uid2,'W2')->>'player_id')::uuid;
    v_p3 := (eds_select_cartela(v_game2,'etb5',103,999000003,'W3')->>'player_id')::uuid;
    ASSERT (SELECT total_pot FROM games WHERE id=v_game2) = 15, 'multi pot != 15';

    UPDATE games SET status='playing', started_at=now() WHERE id=v_game2;
    UPDATE games SET winner_ids = ARRAY[v_p1, v_p2, v_p3] WHERE id=v_game2;
    UPDATE games SET status='finished', finished_at=now() WHERE id=v_game2;

    SELECT winner_prize_amount, house_share_amount INTO v_pool, v_house FROM games WHERE id=v_game2;
    SELECT COALESCE(SUM(amount),0) INTO v_paid FROM wallet_ledger WHERE entry_type='WINNING_CREDIT' AND related_game_id=v_game2;
    ASSERT v_pool = 12,  format('pool != 12 (got %s)', v_pool);
    ASSERT v_paid = 12,  format('winners got %s, expected the whole 12 pool', v_paid);
    ASSERT v_house = 3,  format('house != 3 (exactly 20%% of 15), got %s', v_house);
    -- 12 / 3 = 4 each, no remainder
    ASSERT (SELECT bool_and(amount = 4) FROM wallet_ledger WHERE entry_type='WINNING_CREDIT' AND related_game_id=v_game2), 'equal split of 12/3 failed';
    ASSERT (SELECT COUNT(*) FROM wallet_ledger WHERE entry_type='WINNING_CREDIT' AND related_game_id=v_game2) = 3, 'not 3 winner credits';

    -- pot 20, 3 winners: pool 16, 16/3 = 5 r1 -> payouts 6,5,5 ; house exactly 4
    DECLARE v_game3 uuid; v_amts numeric[];
    BEGIN
      INSERT INTO games (status, host_id, called_numbers, game_number, starts_at, winner_ids, stake_amount, total_pot, winner_prize, winner_prize_each)
      VALUES ('waiting','test','{}',(SELECT COALESCE(MAX(game_number),0)+1 FROM games), now()+interval '10 min','{}',5,0,0,0)
      RETURNING id INTO v_game3;
      UPDATE games SET selection_closed_at = starts_at - interval '5 seconds' WHERE id=v_game3;
      v_p1 := (eds_select_cartela(v_game3,'etb10',1,v_uid, 'W1')->>'player_id')::uuid;
      v_p2 := (eds_select_cartela(v_game3,'etb5', 1,v_uid2,'W2')->>'player_id')::uuid;
      v_p3 := (eds_select_cartela(v_game3,'etb5', 2,999000003,'W3')->>'player_id')::uuid;
      ASSERT (SELECT total_pot FROM games WHERE id=v_game3) = 20, 'pot != 20';
      UPDATE games SET status='playing' WHERE id=v_game3;
      UPDATE games SET winner_ids = ARRAY[v_p1,v_p2,v_p3] WHERE id=v_game3;
      UPDATE games SET status='finished' WHERE id=v_game3;
      SELECT winner_prize_amount, house_share_amount INTO v_pool, v_house FROM games WHERE id=v_game3;
      SELECT COALESCE(SUM(amount),0) INTO v_paid FROM wallet_ledger WHERE entry_type='WINNING_CREDIT' AND related_game_id=v_game3;
      SELECT array_agg(amount ORDER BY amount DESC) INTO v_amts FROM wallet_ledger WHERE entry_type='WINNING_CREDIT' AND related_game_id=v_game3;
      ASSERT v_pool = 16, format('pool != 16 (got %s)', v_pool);
      ASSERT v_paid = 16, format('winners got %s, expected the whole 16 pool', v_paid);
      ASSERT v_house = 4, format('house != 4 (exactly 20%% of 20), got %s', v_house);
      ASSERT v_amts = ARRAY[6,5,5]::numeric[], format('remainder not distributed as 6,5,5 (got %s)', v_amts);
    END;

    ---------------------------------------------------------------------------
    RAISE NOTICE '15. NO-winner game refunds every stake';
    DECLARE
      v_g4 uuid; v_before numeric; v_after numeric;
    BEGIN
      INSERT INTO games (status, host_id, called_numbers, game_number, starts_at, winner_ids, stake_amount, total_pot, winner_prize, winner_prize_each)
      VALUES ('waiting','test','{}',(SELECT COALESCE(MAX(game_number),0)+1 FROM games), now()+interval '10 min','{}',5,0,0,0)
      RETURNING id INTO v_g4;
      UPDATE games SET selection_closed_at = starts_at - interval '5 seconds' WHERE id = v_g4;

      SELECT deposited_balance INTO v_before FROM telegram_users WHERE telegram_user_id = 999000003;
      PERFORM eds_select_cartela(v_g4,'etb10',5,999000003,'NW');   -- costs 10
      PERFORM eds_select_cartela(v_g4,'etb5', 5,999000003,'NW');   -- costs 5
      ASSERT (SELECT deposited_balance FROM telegram_users WHERE telegram_user_id = 999000003) = v_before - 15, 'entry not debited';

      UPDATE games SET status='playing' WHERE id = v_g4;
      UPDATE games SET status='finished' WHERE id = v_g4;   -- winner_ids empty -> refund

      SELECT deposited_balance INTO v_after FROM telegram_users WHERE telegram_user_id = 999000003;
      ASSERT v_after = v_before, format('no-winner refund failed: before %s, after %s', v_before, v_after);
      ASSERT (SELECT COUNT(*) FROM wallet_ledger WHERE entry_type='REFUND' AND related_game_id = v_g4) = 2, 'expected 2 REFUND rows';
      ASSERT (SELECT COALESCE(house_share_amount,-1) FROM games WHERE id = v_g4) = 0, 'house took money on a no-winner game';
    END;
  END;

  RAISE NOTICE 'ALL የኛ CHECKS PASSED';
END $$;

ROLLBACK;

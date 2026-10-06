/*
  # የኛ — authoritative cartela selection (rooms + 4-cartela TOTAL limit)

  `eds_select_cartela()` is the ONLY sanctioned way to buy/reserve a cartela.
  It is atomic and concurrency-safe and it is the source of truth for:
    - room + price (never trusted from the client)
    - cartela number in range for the room (ETB5 1..400, ETB10 1..200)
    - cartela not already taken (FOR UPDATE SKIP LOCKED)
    - MAX_CARTELAS_PER_PLAYER = 4, counted GLOBALLY across BOTH rooms for the game
    - sufficient balance, deducted deposited-first then won
    - wallet_ledger GAME_ENTRY row + game pot / 80-20 update

  One cartela per call. The client calls it once per cartela; concurrent calls
  that would push the player past 4 are rejected because the user row is locked
  FOR UPDATE for the duration of each call, so the count is always consistent.

  Errors are returned as `{ success:false, error, error_code }`, never thrown,
  so the edge function can map them to HTTP status codes:
    GAME_NOT_FOUND, GAME_NOT_WAITING, SELECTION_CLOSED, UNKNOWN_ROOM,
    CARTELA_OUT_OF_RANGE, CARTELA_TAKEN, USER_NOT_FOUND, LIMIT_REACHED,
    INSUFFICIENT_BALANCE, INTERNAL_ERROR
*/

CREATE OR REPLACE FUNCTION eds_player_cartela_count(p_game_id uuid, p_user bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'etb5',  COALESCE(SUM(CASE WHEN room_type = 'etb5'  THEN 1 ELSE 0 END), 0),
    'etb10', COALESCE(SUM(CASE WHEN room_type = 'etb10' THEN 1 ELSE 0 END), 0),
    'total', COALESCE(COUNT(*), 0)
  )
  FROM players
  WHERE game_id = p_game_id AND telegram_user_id = p_user;
$$;
GRANT EXECUTE ON FUNCTION eds_player_cartela_count(uuid, bigint) TO anon, authenticated;


CREATE OR REPLACE FUNCTION eds_select_cartela(
  p_game_id             uuid,
  p_room                text,
  p_cartela_number      integer,
  p_telegram_user_id    bigint,
  p_player_name         text,
  p_telegram_username   text DEFAULT NULL,
  p_telegram_first_name text DEFAULT NULL,
  p_telegram_last_name  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_game        RECORD;
  v_now         timestamptz := now();
  v_price       integer := eds_room_price(p_room);
  v_cap         integer := eds_room_capacity(p_room);
  v_max         integer := (SELECT value::int FROM settings WHERE id = 'MAX_CARTELAS_PER_PLAYER');
  v_winner_pct  integer := (SELECT value::int FROM settings WHERE id = 'WINNER_PERCENTAGE');
  v_dep         numeric;
  v_won         numeric;
  v_current     integer;
  v_taken       uuid;
  v_layout      jsonb;
  v_marked      jsonb;
  v_player_id   uuid;
  v_deduct_dep  numeric;
  v_deduct_won  numeric;
  v_new_pot     numeric;
BEGIN
  IF v_price IS NULL OR v_cap IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown room', 'error_code', 'UNKNOWN_ROOM');
  END IF;
  IF p_cartela_number < 1 OR p_cartela_number > v_cap THEN
    RETURN jsonb_build_object('success', false,
      'error', format('Cartela %s is not valid for the %s room (1-%s)', p_cartela_number, p_room, v_cap),
      'error_code', 'CARTELA_OUT_OF_RANGE');
  END IF;

  -- Lock the game
  SELECT id, status, selection_closed_at, starts_at, allow_late_joins, total_pot
  INTO v_game
  FROM games WHERE id = p_game_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Game not found', 'error_code', 'GAME_NOT_FOUND');
  END IF;
  IF v_game.status <> 'waiting' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Game is no longer accepting cartelas', 'error_code', 'GAME_NOT_WAITING');
  END IF;
  IF v_game.selection_closed_at IS NOT NULL THEN
    IF (v_game.allow_late_joins AND v_now > v_game.selection_closed_at + interval '2 seconds')
       OR (NOT v_game.allow_late_joins AND v_now > v_game.selection_closed_at) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Selection window has closed',
        'error_code', 'SELECTION_CLOSED', 'closed_at', v_game.selection_closed_at, 'current_time', v_now);
    END IF;
  END IF;

  -- Lock the user (serialises the per-player 4-cartela check)
  SELECT deposited_balance, won_balance INTO v_dep, v_won
  FROM telegram_users WHERE telegram_user_id = p_telegram_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'User not found', 'error_code', 'USER_NOT_FOUND');
  END IF;

  -- 4-cartela TOTAL limit (both rooms)
  SELECT COUNT(*) INTO v_current
  FROM players WHERE game_id = p_game_id AND telegram_user_id = p_telegram_user_id;
  IF v_current + 1 > v_max THEN
    RETURN jsonb_build_object('success', false,
      'error', format('Maximum %s cartelas per player (you already have %s)', v_max, v_current),
      'error_code', 'LIMIT_REACHED', 'owned', v_current, 'max', v_max);
  END IF;

  -- Cartela availability (room-scoped)
  SELECT id INTO v_taken
  FROM players
  WHERE game_id = p_game_id AND room_type = p_room AND selected_number = p_cartela_number
  FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cartela already taken', 'error_code', 'CARTELA_TAKEN');
  END IF;

  -- Balance
  IF (v_dep + v_won) < v_price THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance',
      'error_code', 'INSUFFICIENT_BALANCE', 'required', v_price, 'available', v_dep + v_won);
  END IF;

  -- Layout (never trusted from client)
  v_layout := eds_get_or_create_cartela_layout(p_room, p_cartela_number);
  v_marked := '[[false,false,false,false,false],[false,false,false,false,false],[false,false,true,false,false],[false,false,false,false,false],[false,false,false,false,false]]'::jsonb;

  -- Insert the cartela (stake_paid = true: money handled here, not by legacy triggers)
  INSERT INTO players (
    game_id, name, card, card_numbers, marked_cells, selected_number,
    room_type, entry_price, stake_paid,
    telegram_user_id, telegram_username, telegram_first_name, telegram_last_name
  ) VALUES (
    p_game_id, p_player_name, v_layout, v_layout, v_marked, p_cartela_number,
    p_room, v_price, true,
    p_telegram_user_id, p_telegram_username, p_telegram_first_name, p_telegram_last_name
  )
  RETURNING id INTO v_player_id;

  -- Deduct deposited-first, then won
  IF v_dep >= v_price THEN
    v_deduct_dep := v_price; v_deduct_won := 0;
  ELSE
    v_deduct_dep := v_dep;   v_deduct_won := v_price - v_dep;
  END IF;

  PERFORM eds_ledger_write(
    p_user            => p_telegram_user_id,
    p_entry_type      => 'GAME_ENTRY',
    p_direction       => 'debit',
    p_amount          => v_price,
    p_deposited_delta => -v_deduct_dep,
    p_won_delta       => -v_deduct_won,
    p_reference_type  => 'player',
    p_reference_id    => v_player_id::text,
    p_game_id         => p_game_id,
    p_player_id       => v_player_id,
    p_created_by      => 'player',
    p_note            => format('%s room cartela #%s', p_room, p_cartela_number)
  );

  UPDATE telegram_users
  SET total_spent = COALESCE(total_spent, 0) + v_price
  WHERE telegram_user_id = p_telegram_user_id;

  -- Pot + 80/20 (authoritative; frontend never computes prize)
  v_new_pot := COALESCE(v_game.total_pot, 0) + v_price;
  UPDATE games
  SET total_pot         = v_new_pot,
      pot_amount        = COALESCE(pot_amount, 0) + v_price,
      winner_prize      = FLOOR(v_new_pot * v_winner_pct / 100.0),
      house_pot_amount  = v_new_pot - FLOOR(v_new_pot * v_winner_pct / 100.0)
  WHERE id = p_game_id;

  RETURN jsonb_build_object(
    'success', true,
    'player_id', v_player_id,
    'room', p_room,
    'cartela_number', p_cartela_number,
    'price', v_price,
    'card', v_layout,
    'cartelas', eds_player_cartela_count(p_game_id, p_telegram_user_id),
    'max', v_max,
    'selection_closed_at', v_game.selection_closed_at,
    'starts_at', v_game.starts_at
  );

EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cartela already taken', 'error_code', 'CARTELA_TAKEN');
  WHEN check_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance', 'error_code', 'INSUFFICIENT_BALANCE');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'error_code', 'INTERNAL_ERROR');
END;
$$;
GRANT EXECUTE ON FUNCTION eds_select_cartela(uuid, text, integer, bigint, text, text, text, text) TO anon, authenticated;


/*
  Release a cartela BEFORE the game starts. Refunds entry_price to
  deposited_balance (the balance deducted first), with a REFUND ledger row,
  and rolls the game pot back.
*/
CREATE OR REPLACE FUNCTION eds_refund_cartela(p_player_id uuid, p_telegram_user_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player     RECORD;
  v_game       RECORD;
  v_winner_pct integer := (SELECT value::int FROM settings WHERE id = 'WINNER_PERCENTAGE');
  v_new_pot    numeric;
BEGIN
  SELECT id, game_id, telegram_user_id, entry_price, room_type, selected_number
  INTO v_player
  FROM players WHERE id = p_player_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cartela not found', 'error_code', 'NOT_FOUND');
  END IF;
  IF v_player.telegram_user_id <> p_telegram_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not your cartela', 'error_code', 'FORBIDDEN');
  END IF;

  SELECT id, status, total_pot INTO v_game FROM games WHERE id = v_player.game_id FOR UPDATE;
  IF v_game.status <> 'waiting' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Game already started', 'error_code', 'GAME_NOT_WAITING');
  END IF;

  DELETE FROM players WHERE id = p_player_id;

  PERFORM eds_ledger_write(
    p_user            => p_telegram_user_id,
    p_entry_type      => 'REFUND',
    p_direction       => 'credit',
    p_amount          => v_player.entry_price,
    p_deposited_delta => v_player.entry_price,
    p_won_delta       => 0,
    p_reference_type  => 'player',
    p_reference_id    => p_player_id::text,
    p_game_id         => v_player.game_id,
    p_player_id       => p_player_id,
    p_created_by      => 'player',
    p_note            => format('refund %s room cartela #%s', v_player.room_type, v_player.selected_number)
  );

  UPDATE telegram_users
  SET total_spent = GREATEST(0, COALESCE(total_spent, 0) - v_player.entry_price)
  WHERE telegram_user_id = p_telegram_user_id;

  v_new_pot := GREATEST(0, COALESCE(v_game.total_pot, 0) - v_player.entry_price);
  UPDATE games
  SET total_pot        = v_new_pot,
      pot_amount       = GREATEST(0, COALESCE(pot_amount, 0) - v_player.entry_price),
      winner_prize     = FLOOR(v_new_pot * v_winner_pct / 100.0),
      house_pot_amount = v_new_pot - FLOOR(v_new_pot * v_winner_pct / 100.0)
  WHERE id = v_player.game_id;

  RETURN jsonb_build_object('success', true,
    'cartelas', eds_player_cartela_count(v_player.game_id, p_telegram_user_id));
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'error_code', 'INTERNAL_ERROR');
END;
$$;
GRANT EXECUTE ON FUNCTION eds_refund_cartela(uuid, bigint) TO anon, authenticated;

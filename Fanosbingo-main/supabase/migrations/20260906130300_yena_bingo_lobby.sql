/*
  # የኛ — lobby snapshot RPC

  `eds_lobby(p_user)` returns everything the Mini App lobby needs in one call:
  the single active game (waiting/playing), server time, both room definitions
  with their taken cartela numbers, and — for the given player — their wallet and
  the cartelas they already hold in this game (split by room, with the total vs
  the 4-cartela limit).

  This replaces the crypto-era `get_lobby_data_instant` for the የኛ lobby.
  The old function is left in place for backward compatibility.
*/

CREATE OR REPLACE FUNCTION eds_lobby(p_user bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_game        RECORD;
  v_etb5_taken  integer[];
  v_etb10_taken integer[];
  v_mine        jsonb := '[]'::jsonb;
  v_counts      jsonb := jsonb_build_object('etb5', 0, 'etb10', 0, 'total', 0);
  v_wallet      jsonb := NULL;
BEGIN
  SELECT id, status, game_number, starts_at, selection_closed_at, started_at,
         finished_at, return_to_lobby_at, called_numbers, current_number,
         total_pot, winner_prize, winner_ids, allow_late_joins
  INTO v_game
  FROM games
  WHERE status IN ('waiting','playing')
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    SELECT COALESCE(array_agg(selected_number ORDER BY selected_number), '{}')
    INTO v_etb5_taken
    FROM players WHERE game_id = v_game.id AND room_type = 'etb5' AND selected_number IS NOT NULL;

    SELECT COALESCE(array_agg(selected_number ORDER BY selected_number), '{}')
    INTO v_etb10_taken
    FROM players WHERE game_id = v_game.id AND room_type = 'etb10' AND selected_number IS NOT NULL;

    IF p_user IS NOT NULL THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'player_id', id, 'room', room_type, 'number', selected_number,
               'card', card_numbers, 'is_disqualified', is_disqualified
             ) ORDER BY room_type, selected_number), '[]')
      INTO v_mine
      FROM players
      WHERE game_id = v_game.id AND telegram_user_id = p_user;

      v_counts := eds_player_cartela_count(v_game.id, p_user);
    END IF;
  END IF;

  IF p_user IS NOT NULL THEN
    v_wallet := eds_wallet(p_user);
  END IF;

  RETURN jsonb_build_object(
    'server_time_ms', (extract(epoch from now()) * 1000)::bigint,
    'config', eds_config(),
    'game', CASE WHEN v_game.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_game.id,
      'status', v_game.status,
      'game_number', v_game.game_number,
      'starts_at', v_game.starts_at,
      'selection_closed_at', v_game.selection_closed_at,
      'started_at', v_game.started_at,
      'finished_at', v_game.finished_at,
      'return_to_lobby_at', v_game.return_to_lobby_at,
      'called_numbers', v_game.called_numbers,
      'current_number', v_game.current_number,
      'total_pot', v_game.total_pot,
      'winner_prize', v_game.winner_prize,
      'winner_ids', v_game.winner_ids
    ) END,
    'rooms', jsonb_build_object(
      'etb5',  jsonb_build_object('price', eds_room_price('etb5'),  'capacity', eds_room_capacity('etb5'),  'taken', to_jsonb(v_etb5_taken)),
      'etb10', jsonb_build_object('price', eds_room_price('etb10'), 'capacity', eds_room_capacity('etb10'), 'taken', to_jsonb(v_etb10_taken))
    ),
    'my_cartelas', v_mine,
    'my_counts', v_counts,
    'wallet', v_wallet
  );
END;
$$;
GRANT EXECUTE ON FUNCTION eds_lobby(bigint) TO anon, authenticated;

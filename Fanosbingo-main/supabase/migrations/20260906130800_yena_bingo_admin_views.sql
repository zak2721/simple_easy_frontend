/*
  # የኛ — admin dashboard / cartela / revenue aggregates
*/

CREATE OR REPLACE FUNCTION eds_admin_dashboard()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_game_id uuid;
  v_result  jsonb;
BEGIN
  SELECT id INTO v_game_id FROM games WHERE status IN ('waiting','playing') ORDER BY created_at DESC LIMIT 1;

  SELECT jsonb_build_object(
    'total_players',        (SELECT count(*) FROM telegram_users),
    'pending_deposits',     (SELECT count(*) FROM manual_deposits WHERE status = 'pending'),
    'pending_deposit_etb',  (SELECT COALESCE(SUM(amount),0) FROM manual_deposits WHERE status = 'pending'),
    'pending_withdrawals',  (SELECT count(*) FROM withdrawal_requests WHERE status IN ('pending','approved')),
    'pending_withdrawal_etb',(SELECT COALESCE(SUM(amount),0) FROM withdrawal_requests WHERE status IN ('pending','approved')),
    'active_games',         (SELECT count(*) FROM games WHERE status IN ('waiting','playing')),
    'active_game_id',       v_game_id,
    'cartelas', eds_room_stats(v_game_id)->'rooms',
    'house_revenue_total',  (SELECT COALESCE(SUM(amount),0) FROM wallet_ledger WHERE entry_type = 'HOUSE_REVENUE'),
    'house_revenue_today',  (SELECT COALESCE(SUM(amount),0) FROM wallet_ledger
                             WHERE entry_type = 'HOUSE_REVENUE' AND created_at >= CURRENT_DATE),
    'winner_payouts_total', (SELECT COALESCE(SUM(amount),0) FROM wallet_ledger WHERE entry_type = 'WINNING_CREDIT'),
    'deposits_approved_total', (SELECT COALESCE(SUM(amount),0) FROM manual_deposits WHERE status = 'approved'),
    'withdrawals_paid_total',  (SELECT COALESCE(SUM(amount),0) FROM withdrawal_requests WHERE status = 'paid'),
    'recent_ledger', (SELECT COALESCE(jsonb_agg(t), '[]') FROM (
        SELECT id, telegram_user_id, entry_type, direction, amount, created_at, note
        FROM wallet_ledger ORDER BY created_at DESC LIMIT 20
      ) t)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION eds_admin_cartelas(p_game_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_game_id uuid := p_game_id;
  v_violations jsonb;
BEGIN
  IF v_game_id IS NULL THEN
    SELECT id INTO v_game_id FROM games WHERE status IN ('waiting','playing') ORDER BY created_at DESC LIMIT 1;
  END IF;

  SELECT COALESCE(jsonb_agg(v), '[]') INTO v_violations FROM (
    SELECT telegram_user_id, count(*) AS cartelas
    FROM players
    WHERE game_id = v_game_id
    GROUP BY telegram_user_id
    HAVING count(*) > (SELECT value::int FROM settings WHERE id = 'MAX_CARTELAS_PER_PLAYER')
  ) v;

  RETURN jsonb_build_object(
    'game_id', v_game_id,
    'total_capacity', (SELECT value::int FROM settings WHERE id = 'MAX_STANDARD_CARTELAS'),
    'rooms', eds_room_stats(v_game_id)->'rooms',
    'max_per_player', (SELECT value::int FROM settings WHERE id = 'MAX_CARTELAS_PER_PLAYER'),
    'limit_violations', v_violations
  );
END;
$$;

-- per-player ownership for the active game (admin drill-down)
CREATE OR REPLACE FUNCTION eds_admin_player_cartelas(p_user bigint, p_game_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_game_id uuid := p_game_id;
BEGIN
  IF v_game_id IS NULL THEN
    SELECT id INTO v_game_id FROM games WHERE status IN ('waiting','playing') ORDER BY created_at DESC LIMIT 1;
  END IF;
  RETURN jsonb_build_object(
    'user', p_user,
    'game_id', v_game_id,
    'counts', eds_player_cartela_count(v_game_id, p_user),
    'cartelas', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'player_id', id, 'room', room_type, 'number', selected_number,
        'entry_price', entry_price, 'is_disqualified', is_disqualified))
      FROM players WHERE game_id = v_game_id AND telegram_user_id = p_user), '[]')
  );
END;
$$;

GRANT EXECUTE ON FUNCTION eds_admin_dashboard()               TO service_role;
GRANT EXECUTE ON FUNCTION eds_admin_cartelas(uuid)            TO service_role;
GRANT EXECUTE ON FUNCTION eds_admin_player_cartelas(bigint, uuid) TO service_role;

/*
  # የኛ — player bootstrap from the Mini App

  When a verified Telegram user opens the Mini App we upsert their
  telegram_users row (the Telegram bot's /start does the same). First-time
  creation grants the signup bonus and records it in the ledger.

  SIGNUP_BONUS_ETB is configurable; set to 0 to disable.
*/

INSERT INTO settings (id, value, description) VALUES
  ('SIGNUP_BONUS_ETB', '10', 'One-time signup bonus credited to deposited_balance')
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION eds_ensure_player(
  p_user       bigint,
  p_username   text DEFAULT NULL,
  p_first_name text DEFAULT NULL,
  p_last_name  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_existing telegram_users%ROWTYPE;
  v_bonus    numeric := (SELECT value::numeric FROM settings WHERE id = 'SIGNUP_BONUS_ETB');
  v_new      boolean := false;
BEGIN
  SELECT * INTO v_existing FROM telegram_users WHERE telegram_user_id = p_user;

  IF NOT FOUND THEN
    INSERT INTO telegram_users (
      telegram_user_id, telegram_username, telegram_first_name, telegram_last_name,
      balance, deposited_balance, won_balance, last_active_at
    ) VALUES (
      p_user, p_username, COALESCE(p_first_name, 'Player'), p_last_name,
      0, 0, 0, now()
    );
    v_new := true;

    IF v_bonus > 0 THEN
      PERFORM eds_ledger_write(
        p_user => p_user, p_entry_type => 'ADJUSTMENT', p_direction => 'credit',
        p_amount => v_bonus, p_deposited_delta => v_bonus, p_won_delta => 0,
        p_reference_type => 'signup', p_reference_id => p_user::text,
        p_created_by => 'system', p_note => 'signup bonus');
    END IF;
  ELSE
    UPDATE telegram_users
    SET telegram_username   = COALESCE(p_username, telegram_username),
        telegram_first_name = COALESCE(p_first_name, telegram_first_name),
        telegram_last_name  = COALESCE(p_last_name, telegram_last_name),
        last_active_at       = now()
    WHERE telegram_user_id = p_user;
  END IF;

  RETURN jsonb_build_object(
    'is_new', v_new,
    'user', jsonb_build_object(
      'telegram_user_id', p_user,
      'first_name', COALESCE(p_first_name, v_existing.telegram_first_name, 'Player'),
      'username', COALESCE(p_username, v_existing.telegram_username)
    ),
    'wallet', eds_wallet(p_user),
    'config', eds_config()
  );
END;
$$;
GRANT EXECUTE ON FUNCTION eds_ensure_player(bigint, text, text, text) TO service_role;

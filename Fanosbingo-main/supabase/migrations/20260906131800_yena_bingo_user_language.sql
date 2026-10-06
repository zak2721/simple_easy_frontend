/*
  # የኛ — per-user language preference (en / am / om)

  Adds telegram_users.language_code. Default 'am' (Amharic) — new users AND every
  existing user (the NOT NULL DEFAULT backfills existing rows to 'am').
  Constrained to the three supported codes.

    en  English
    am  አማርኛ (Amharic)   <- default
    om  Afaan Oromoo (Oromo)

  eds_set_language() is the only writer; eds_ensure_player() returns the code so
  the Mini App + bot render in the right language on first load.
*/

ALTER TABLE telegram_users
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'am';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'telegram_users_language_code_check') THEN
    ALTER TABLE telegram_users
      ADD CONSTRAINT telegram_users_language_code_check CHECK (language_code IN ('en','am','om'));
  END IF;
END $$;

-- any legacy NULLs (defensive) -> Amharic
UPDATE telegram_users SET language_code = 'am' WHERE language_code IS NULL OR language_code NOT IN ('en','am','om');

COMMENT ON COLUMN telegram_users.language_code IS 'UI language: en | am | om. Default am. Presentation only — never affects money, ids, or business logic.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION eds_set_language(p_user bigint, p_lang text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_lang NOT IN ('en','am','om') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unsupported language', 'error_code', 'BAD_LANG');
  END IF;
  UPDATE telegram_users SET language_code = p_lang, last_active_at = now()
  WHERE telegram_user_id = p_user;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'User not found', 'error_code', 'USER_NOT_FOUND');
  END IF;
  RETURN jsonb_build_object('success', true, 'language_code', p_lang);
END;
$$;
GRANT EXECUTE ON FUNCTION eds_set_language(bigint, text) TO service_role, authenticated;

-- ---------------------------------------------------------------------------
-- eds_ensure_player: also return language_code (falls back to 'am').
-- ---------------------------------------------------------------------------
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
  v_lang     text;
BEGIN
  SELECT * INTO v_existing FROM telegram_users WHERE telegram_user_id = p_user;

  IF NOT FOUND THEN
    INSERT INTO telegram_users (
      telegram_user_id, telegram_username, telegram_first_name, telegram_last_name,
      balance, deposited_balance, won_balance, language_code, last_active_at
    ) VALUES (
      p_user, p_username, COALESCE(p_first_name, 'Player'), p_last_name,
      0, 0, 0, 'am', now()
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

  SELECT COALESCE(language_code, 'am') INTO v_lang FROM telegram_users WHERE telegram_user_id = p_user;

  RETURN jsonb_build_object(
    'is_new', v_new,
    'user', jsonb_build_object(
      'telegram_user_id', p_user,
      'first_name', COALESCE(p_first_name, v_existing.telegram_first_name, 'Player'),
      'username', COALESCE(p_username, v_existing.telegram_username),
      'language_code', v_lang
    ),
    'wallet', eds_wallet(p_user),
    'config', eds_config()
  );
END;
$$;
GRANT EXECUTE ON FUNCTION eds_ensure_player(bigint, text, text, text) TO service_role;

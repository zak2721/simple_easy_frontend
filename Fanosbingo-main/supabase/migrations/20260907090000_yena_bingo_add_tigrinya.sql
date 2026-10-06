/*
  # የኛ — add Tigrinya (ti) as a fourth UI language

  Extends telegram_users.language_code to accept 'ti' (ትግርኛ) alongside the
  existing en / am / om. Default stays 'am' (Amharic). Presentation only —
  never affects money, ids, or business logic.

    en  English
    am  አማርኛ (Amharic)   <- default
    om  Afaan Oromoo (Oromo)
    ti  ትግርኛ (Tigrinya)   <- new

  eds_set_language() is the only writer; its whitelist is widened to match.
*/

-- widen the CHECK constraint to include 'ti'
ALTER TABLE telegram_users
  DROP CONSTRAINT IF EXISTS telegram_users_language_code_check;

ALTER TABLE telegram_users
  ADD CONSTRAINT telegram_users_language_code_check CHECK (language_code IN ('en','am','om','ti'));

COMMENT ON COLUMN telegram_users.language_code IS 'UI language: en | am | om | ti. Default am. Presentation only — never affects money, ids, or business logic.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION eds_set_language(p_user bigint, p_lang text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_lang NOT IN ('en','am','om','ti') THEN
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

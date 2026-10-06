/*
  # የኛ — settings table lockdown

  ## Problem found during the owner-setup audit
  1. The original `settings` table has a public SELECT RLS policy
     ("Anyone can read settings" — FOR SELECT TO public USING (true)).
     The anon key is public, so ANY visitor could read the WHOLE table,
     including `telegram_bot_token`. That is a credential leak.
  2. Migration 20251213115718 seeds `telegram_bot_token` with a real-looking
     Telegram bot token from the original project. Applying migrations would
     re-seed that leaked value.

  ## Fix
  - Remove public read on `settings`. Nothing legitimate needs it:
      * the Mini App reads config only through SECURITY DEFINER RPCs
        (eds_config, eds_lobby, eds_telebirr_account) that expose a safe subset;
      * every edge function reads `settings` with the service role (bypasses RLS).
  - Blank any seeded bot token. The owner sets their own token as a Supabase
    Edge Function secret (TELEGRAM_BOT_TOKEN) and/or via the admin panel.

  ## ACTION REQUIRED BY THE OWNER
  The leaked token is in git history. REVOKE it in @BotFather (/revoke) and
  issue a fresh token. See docs/YENA_BINGO_OWNER_SETUP_REQUIREMENTS.md.
*/

-- 1. Remove public read; keep service-role full access.
DROP POLICY IF EXISTS "Anyone can read settings" ON settings;
DROP POLICY IF EXISTS "Public can read settings" ON settings;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'settings' AND policyname = 'Service role manages settings') THEN
    CREATE POLICY "Service role manages settings" ON settings
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 2. Blank any seeded Telegram bot token (owner provides their own).
UPDATE settings SET value = '' WHERE id = 'telegram_bot_token' AND value LIKE '%:%';

-- 3. A read helper for the (few) player-safe settings, in case anything needs
--    them without going through eds_config/eds_lobby.
CREATE OR REPLACE FUNCTION eds_public_settings()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(jsonb_object_agg(id, value), '{}'::jsonb)
  FROM settings
  WHERE id IN (
    'YENA_BINGO_NAME',
    'ETB5_ROOM_PRICE','ETB5_ROOM_CAPACITY','ETB10_ROOM_PRICE','ETB10_ROOM_CAPACITY',
    'MAX_STANDARD_CARTELAS','MAX_CARTELAS_PER_PLAYER',
    'WINNER_PERCENTAGE','HOUSE_PERCENTAGE',
    'DEPOSIT_MIN_ETB','DEPOSIT_MAX_ETB','WITHDRAWAL_MIN_ETB','WITHDRAWAL_MAX_ETB',
    'TELEBIRR_ACCOUNT_NAME','TELEBIRR_ACCOUNT_NUMBER','TELEBIRR_INSTRUCTIONS',
    'user_instructions'
  );
$$;
GRANT EXECUTE ON FUNCTION eds_public_settings() TO anon, authenticated;

COMMENT ON TABLE settings IS
  'Runtime config. NOT publicly readable (contains secrets like telegram_bot_token). Player-safe values are exposed via eds_config() / eds_public_settings().';

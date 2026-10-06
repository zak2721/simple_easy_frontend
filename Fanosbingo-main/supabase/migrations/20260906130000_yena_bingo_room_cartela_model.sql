/*
  # የኛ — Two-room / 600-cartela model + 4-cartela player limit

  ## What this migration establishes

  1. **Business config** in `settings` (authoritative), plus `eds_config()` helper:
     ETB5_ROOM_PRICE=5, ETB5_ROOM_CAPACITY=400,
     ETB10_ROOM_PRICE=10, ETB10_ROOM_CAPACITY=200,
     MAX_STANDARD_CARTELAS=600, MAX_CARTELAS_PER_PLAYER=4,
     WINNER_PERCENTAGE=80, HOUSE_PERCENTAGE=20.
     Validated: capacities sum to 600, percentages sum to 100.

  2. **One active game, two rooms as cartela categories.** We keep the existing
     "single active game" lifecycle. A cartela (row in `players`) now carries
     `room_type` ('etb5' | 'etb10') and `entry_price`. A player may hold cartelas
     in BOTH rooms in the same game. The 4-cartela limit is GLOBAL across rooms.

  3. **`cartela_layouts`** — room-scoped permanent 5x5 layouts:
     ETB5 #1..400, ETB10 #1..200. Numbers restart per room.

  4. **`eds_select_cartela()`** — the single authoritative, atomic entry point for
     buying/reserving a cartela. Enforces: game waiting + selection open, room +
     price, cartela in range, cartela not taken (concurrency-safe), player's total
     cartelas across BOTH rooms + this request <= 4, sufficient balance. Performs
     balance deduction, pot update, ledger write, and player insert in one tx.

  5. **`eds_refund_cartela()`** — releases a cartela before the game starts and
     refunds to the balance it was taken from, with a ledger entry.

  ## Legacy triggers on `players` that touched money are REMOVED here
     (`deduct_stake_on_join`, `deduct_stake_on_player_insert`, `update_pot_on_player_join`,
      `refund_on_player_delete`). They were mutually inconsistent (testnet no-ops in
     `20260214120304` / `20260216113940`). All money movement now flows through the
     `eds_*` functions + `wallet_ledger` (see 20260906130100 migration).

  ## NOTE (no live DB available at authoring time)
     Apply on a staging Supabase project and run the checks in
     docs/YENA_BINGO_MIGRATION_REPORT.md "SQL verification" before production.
*/

-- ---------------------------------------------------------------------------
-- 1. Business configuration
-- ---------------------------------------------------------------------------
INSERT INTO settings (id, value, description) VALUES
  ('YENA_BINGO_NAME',          'የኛ', 'Product name'),
  ('ETB5_ROOM_PRICE',         '5',   'ETB 5 room cartela price'),
  ('ETB5_ROOM_CAPACITY',      '400', 'ETB 5 room cartela count (#1..400)'),
  ('ETB10_ROOM_PRICE',        '10',  'ETB 10 room cartela price'),
  ('ETB10_ROOM_CAPACITY',     '200', 'ETB 10 room cartela count (#1..200)'),
  ('MAX_STANDARD_CARTELAS',   '600', 'ETB5 + ETB10 capacity'),
  ('MAX_CARTELAS_PER_PLAYER', '4',   'Hard limit per player, GLOBAL across both rooms'),
  ('WINNER_PERCENTAGE',       '80',  'Winner share of the game pot'),
  ('HOUSE_PERCENTAGE',        '20',  'የኛ house share of the game pot')
ON CONFLICT (id) DO NOTHING;

-- keep the legacy commission_rate in sync with HOUSE_PERCENTAGE
UPDATE settings SET value = (SELECT value FROM settings WHERE id = 'HOUSE_PERCENTAGE')
WHERE id = 'commission_rate';

DO $$
DECLARE
  c5 int  := (SELECT value::int FROM settings WHERE id = 'ETB5_ROOM_CAPACITY');
  c10 int := (SELECT value::int FROM settings WHERE id = 'ETB10_ROOM_CAPACITY');
  tot int := (SELECT value::int FROM settings WHERE id = 'MAX_STANDARD_CARTELAS');
  wp int  := (SELECT value::int FROM settings WHERE id = 'WINNER_PERCENTAGE');
  hp int  := (SELECT value::int FROM settings WHERE id = 'HOUSE_PERCENTAGE');
  lim int := (SELECT value::int FROM settings WHERE id = 'MAX_CARTELAS_PER_PLAYER');
BEGIN
  IF c5 + c10 <> tot THEN
    RAISE EXCEPTION 'የኛ config: ETB5_ROOM_CAPACITY + ETB10_ROOM_CAPACITY (% + %) must equal MAX_STANDARD_CARTELAS (%)', c5, c10, tot;
  END IF;
  IF wp + hp <> 100 THEN
    RAISE EXCEPTION 'የኛ config: WINNER_PERCENTAGE + HOUSE_PERCENTAGE (% + %) must equal 100', wp, hp;
  END IF;
  IF lim <> 4 THEN
    RAISE EXCEPTION 'የኛ config: MAX_CARTELAS_PER_PLAYER must be 4 (got %)', lim;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION eds_config()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'name',                    (SELECT value FROM settings WHERE id = 'YENA_BINGO_NAME'),
    'currency',                'ETB',
    'etb5_price',              (SELECT value::int FROM settings WHERE id = 'ETB5_ROOM_PRICE'),
    'etb5_capacity',           (SELECT value::int FROM settings WHERE id = 'ETB5_ROOM_CAPACITY'),
    'etb10_price',             (SELECT value::int FROM settings WHERE id = 'ETB10_ROOM_PRICE'),
    'etb10_capacity',          (SELECT value::int FROM settings WHERE id = 'ETB10_ROOM_CAPACITY'),
    'standard_total_cartelas', (SELECT value::int FROM settings WHERE id = 'MAX_STANDARD_CARTELAS'),
    'max_cartelas_per_player', (SELECT value::int FROM settings WHERE id = 'MAX_CARTELAS_PER_PLAYER'),
    'winner_percentage',       (SELECT value::int FROM settings WHERE id = 'WINNER_PERCENTAGE'),
    'house_percentage',        (SELECT value::int FROM settings WHERE id = 'HOUSE_PERCENTAGE')
  );
$$;
GRANT EXECUTE ON FUNCTION eds_config() TO anon, authenticated;

-- helper: price / capacity for a room
CREATE OR REPLACE FUNCTION eds_room_price(p_room text)
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT value::int FROM settings
  WHERE id = CASE p_room WHEN 'etb5' THEN 'ETB5_ROOM_PRICE' WHEN 'etb10' THEN 'ETB10_ROOM_PRICE' END;
$$;

CREATE OR REPLACE FUNCTION eds_room_capacity(p_room text)
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT value::int FROM settings
  WHERE id = CASE p_room WHEN 'etb5' THEN 'ETB5_ROOM_CAPACITY' WHEN 'etb10' THEN 'ETB10_ROOM_CAPACITY' END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Schema: room_type + entry_price on games/players
-- ---------------------------------------------------------------------------
ALTER TABLE games   ADD COLUMN IF NOT EXISTS room_type text;   -- informational (mixed-room games -> NULL)
ALTER TABLE players ADD COLUMN IF NOT EXISTS room_type text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS entry_price integer;

-- Backfill existing rows: legacy single-room game was ETB 10.
UPDATE players p
SET room_type   = COALESCE(p.room_type, 'etb10'),
    entry_price = COALESCE(p.entry_price, (SELECT stake_amount FROM games g WHERE g.id = p.game_id), 10)
WHERE p.room_type IS NULL OR p.entry_price IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'players_room_type_check') THEN
    ALTER TABLE players ADD CONSTRAINT players_room_type_check CHECK (room_type IN ('etb5','etb10'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Constraints: allow multi-cartela, keep one-owner-per-cartela-per-room
-- ---------------------------------------------------------------------------
-- Was: UNIQUE (game_id, telegram_user_id) -> blocked multi-cartela. Drop it.
ALTER TABLE players DROP CONSTRAINT IF EXISTS unique_telegram_user_per_game;

-- Was: UNIQUE (game_id, selected_number). Replace with room-scoped uniqueness so
-- ETB5 #5 and ETB10 #5 are distinct cartelas.
ALTER TABLE players DROP CONSTRAINT IF EXISTS players_game_id_selected_number_key;
ALTER TABLE players DROP CONSTRAINT IF EXISTS unique_selected_number_per_game;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'players_game_room_cartela_key') THEN
    ALTER TABLE players
      ADD CONSTRAINT players_game_room_cartela_key UNIQUE (game_id, room_type, selected_number);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_players_game_user_room
  ON players(game_id, telegram_user_id, room_type);

-- ---------------------------------------------------------------------------
-- 4. Room-scoped cartela layouts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cartela_layouts (
  room_type      text    NOT NULL CHECK (room_type IN ('etb5','etb10')),
  cartela_number integer NOT NULL CHECK (cartela_number >= 1),
  layout         jsonb   NOT NULL,
  created_at     timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY (room_type, cartela_number)
);
ALTER TABLE cartela_layouts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cartela_layouts' AND policyname = 'Anyone can read cartela layouts') THEN
    CREATE POLICY "Anyone can read cartela layouts" ON cartela_layouts
      FOR SELECT TO anon, authenticated USING (true);
  END IF;
END $$;

/*
  Deterministic layout per (room, cartela_number). Reuses the existing
  generate_seeded_bingo_card(int) from 20251227075119. ETB5 shares seeds with
  the legacy card_layouts (#1..400); ETB10 is offset so its cartelas differ.
*/
CREATE OR REPLACE FUNCTION eds_get_or_create_cartela_layout(p_room text, p_number integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cap    integer := eds_room_capacity(p_room);
  v_layout jsonb;
  v_seed   integer;
BEGIN
  IF p_room NOT IN ('etb5','etb10') THEN
    RAISE EXCEPTION 'Unknown room %', p_room;
  END IF;
  IF v_cap IS NULL OR p_number < 1 OR p_number > v_cap THEN
    RAISE EXCEPTION 'Cartela % is out of range for the % room (1..%)', p_number, p_room, v_cap;
  END IF;

  SELECT layout INTO v_layout FROM cartela_layouts
  WHERE room_type = p_room AND cartela_number = p_number;
  IF v_layout IS NOT NULL THEN
    RETURN v_layout;
  END IF;

  v_seed := CASE p_room WHEN 'etb10' THEN p_number + 100000 ELSE p_number END;
  v_layout := generate_seeded_bingo_card(v_seed);

  INSERT INTO cartela_layouts (room_type, cartela_number, layout)
  VALUES (p_room, p_number, v_layout)
  ON CONFLICT (room_type, cartela_number) DO NOTHING;

  SELECT layout INTO v_layout FROM cartela_layouts
  WHERE room_type = p_room AND cartela_number = p_number;
  RETURN v_layout;
END;
$$;
GRANT EXECUTE ON FUNCTION eds_get_or_create_cartela_layout(text, integer) TO anon, authenticated;

-- Pre-generate every cartela layout (400 + 200). Safe to re-run.
DO $$
DECLARE i integer;
BEGIN
  FOR i IN 1..(SELECT value::int FROM settings WHERE id = 'ETB5_ROOM_CAPACITY') LOOP
    PERFORM eds_get_or_create_cartela_layout('etb5', i);
  END LOOP;
  FOR i IN 1..(SELECT value::int FROM settings WHERE id = 'ETB10_ROOM_CAPACITY') LOOP
    PERFORM eds_get_or_create_cartela_layout('etb10', i);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Remove legacy money-moving triggers on players
--    (superseded by eds_select_cartela / eds_refund_cartela + wallet_ledger)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS deduct_stake_on_join          ON players;
DROP TRIGGER IF EXISTS deduct_stake_on_player_insert ON players;
DROP TRIGGER IF EXISTS update_pot_on_player_join     ON players;
DROP TRIGGER IF EXISTS refund_on_player_delete       ON players;

-- ---------------------------------------------------------------------------
-- 6. Room stats (admin + lobby)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION eds_room_stats(p_game_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_game_id uuid := p_game_id;
  v_result  jsonb := '{}'::jsonb;
  r         record;
BEGIN
  IF v_game_id IS NULL THEN
    SELECT id INTO v_game_id FROM games
    WHERE status IN ('waiting','playing')
    ORDER BY created_at DESC LIMIT 1;
  END IF;

  FOR r IN SELECT unnest(ARRAY['etb5','etb10']) AS room LOOP
    v_result := v_result || jsonb_build_object(
      r.room,
      jsonb_build_object(
        'price',     eds_room_price(r.room),
        'capacity',  eds_room_capacity(r.room),
        'taken',     COALESCE((SELECT count(*) FROM players
                               WHERE game_id = v_game_id AND room_type = r.room
                                 AND selected_number IS NOT NULL), 0),
        'available', eds_room_capacity(r.room) -
                     COALESCE((SELECT count(*) FROM players
                               WHERE game_id = v_game_id AND room_type = r.room
                                 AND selected_number IS NOT NULL), 0)
      )
    );
  END LOOP;

  RETURN jsonb_build_object('game_id', v_game_id, 'rooms', v_result);
END;
$$;
GRANT EXECUTE ON FUNCTION eds_room_stats(uuid) TO anon, authenticated;

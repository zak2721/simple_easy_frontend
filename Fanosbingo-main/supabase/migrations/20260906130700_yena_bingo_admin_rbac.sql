/*
  # የኛ — admin users, roles (RBAC), sessions, audit-ready

  Replaces the single shared ADMIN_KEY with named admin accounts + roles.
  The ADMIN_KEY is kept ONLY as a bootstrap secret to create the first owner
  and as a break-glass fallback for the edge functions.

  Roles and permissions:
    owner    — everything, including managing admins & settings
    finance  — deposits, withdrawals, wallets, transactions, house revenue, receipts
    support  — view players/games/cartelas/audit; NO financial actions
    viewer   — read-only dashboards

  Every financial admin action still writes an audit_logs row (see 20260906130100).
*/

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS admin_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','finance','support','viewer')),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token       text PRIMARY KEY,
  admin_id    uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id);

ALTER TABLE admin_users    ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;
-- no public policies: reached only via SECURITY DEFINER functions / service role

-- permission matrix
CREATE OR REPLACE FUNCTION eds_role_can(p_role text, p_permission text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE p_role
    WHEN 'owner'   THEN true
    WHEN 'finance' THEN p_permission IN (
      'deposits.view','deposits.review','withdrawals.view','withdrawals.review',
      'withdrawals.mark_paid','receipts.view','wallets.view','transactions.view',
      'house.view','players.view','games.view','cartelas.view','audit.view','dashboard.view')
    WHEN 'support' THEN p_permission IN (
      'players.view','games.view','cartelas.view','audit.view','dashboard.view',
      'deposits.view','withdrawals.view')
    WHEN 'viewer'  THEN p_permission LIKE '%.view'
    ELSE false
  END;
$$;

-- bootstrap the first owner (only when no admins exist yet)
CREATE OR REPLACE FUNCTION eds_admin_bootstrap(p_username text, p_password text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE v_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM admin_users) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Admin users already exist', 'error_code', 'ALREADY_BOOTSTRAPPED');
  END IF;
  IF length(coalesce(p_password,'')) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Password must be at least 10 characters', 'error_code', 'WEAK_PASSWORD');
  END IF;
  INSERT INTO admin_users (username, password_hash, role)
  VALUES (lower(trim(p_username)), crypt(p_password, gen_salt('bf', 12)), 'owner')
  RETURNING id INTO v_id;
  PERFORM eds_audit(lower(trim(p_username)), 'admin.bootstrap', 'admin_user', v_id::text, NULL,
    jsonb_build_object('role','owner'), 'first owner created');
  RETURN jsonb_build_object('success', true, 'admin_id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION eds_admin_login(p_username text, p_password text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_admin RECORD;
  v_token text;
BEGIN
  SELECT * INTO v_admin FROM admin_users
  WHERE username = lower(trim(p_username)) AND is_active = true;

  IF NOT FOUND OR v_admin.password_hash <> crypt(p_password, v_admin.password_hash) THEN
    PERFORM pg_sleep(0.3);  -- slow brute force
    RETURN jsonb_build_object('success', false, 'error', 'Invalid credentials', 'error_code', 'BAD_CREDENTIALS');
  END IF;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  INSERT INTO admin_sessions (token, admin_id, expires_at)
  VALUES (v_token, v_admin.id, now() + interval '12 hours');

  UPDATE admin_users SET last_login_at = now() WHERE id = v_admin.id;
  DELETE FROM admin_sessions WHERE expires_at < now();

  PERFORM eds_audit(v_admin.username, 'admin.login', 'admin_user', v_admin.id::text, NULL, NULL, NULL);

  RETURN jsonb_build_object('success', true, 'token', v_token,
    'admin', jsonb_build_object('username', v_admin.username, 'role', v_admin.role),
    'expires_at', (now() + interval '12 hours'));
END;
$$;

-- returns the admin for a token, or NULL; refreshes last_seen
CREATE OR REPLACE FUNCTION eds_admin_from_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_admin RECORD;
BEGIN
  SELECT a.id, a.username, a.role INTO v_admin
  FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_id
  WHERE s.token = p_token AND s.expires_at > now() AND a.is_active = true;

  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE admin_sessions SET last_seen_at = now() WHERE token = p_token;
  RETURN jsonb_build_object('id', v_admin.id, 'username', v_admin.username, 'role', v_admin.role);
END;
$$;

CREATE OR REPLACE FUNCTION eds_admin_logout(p_token text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$ DELETE FROM admin_sessions WHERE token = p_token; $$;

-- owner-only: create / update / deactivate admins
CREATE OR REPLACE FUNCTION eds_admin_upsert(
  p_actor_token text, p_username text, p_password text, p_role text, p_is_active boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor jsonb := eds_admin_from_token(p_actor_token);
  v_id uuid;
  v_prev RECORD;
BEGIN
  IF v_actor IS NULL OR v_actor->>'role' <> 'owner' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Owner role required', 'error_code', 'FORBIDDEN');
  END IF;
  IF p_role NOT IN ('owner','finance','support','viewer') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown role', 'error_code', 'BAD_ROLE');
  END IF;

  SELECT * INTO v_prev FROM admin_users WHERE username = lower(trim(p_username));
  IF FOUND THEN
    UPDATE admin_users
    SET role = p_role,
        is_active = p_is_active,
        password_hash = CASE WHEN coalesce(p_password,'') <> '' THEN crypt(p_password, gen_salt('bf', 12)) ELSE password_hash END
    WHERE id = v_prev.id
    RETURNING id INTO v_id;
    PERFORM eds_audit(v_actor->>'username', 'admin.update', 'admin_user', v_id::text,
      jsonb_build_object('role', v_prev.role, 'is_active', v_prev.is_active),
      jsonb_build_object('role', p_role, 'is_active', p_is_active), NULL);
  ELSE
    IF length(coalesce(p_password,'')) < 10 THEN
      RETURN jsonb_build_object('success', false, 'error', 'Password must be at least 10 characters', 'error_code', 'WEAK_PASSWORD');
    END IF;
    INSERT INTO admin_users (username, password_hash, role, is_active)
    VALUES (lower(trim(p_username)), crypt(p_password, gen_salt('bf', 12)), p_role, p_is_active)
    RETURNING id INTO v_id;
    PERFORM eds_audit(v_actor->>'username', 'admin.create', 'admin_user', v_id::text, NULL,
      jsonb_build_object('role', p_role), NULL);
  END IF;
  RETURN jsonb_build_object('success', true, 'admin_id', v_id);
END;
$$;

GRANT EXECUTE ON FUNCTION eds_admin_bootstrap(text, text)         TO service_role;
GRANT EXECUTE ON FUNCTION eds_admin_login(text, text)             TO service_role;
GRANT EXECUTE ON FUNCTION eds_admin_from_token(text)              TO service_role;
GRANT EXECUTE ON FUNCTION eds_admin_logout(text)                  TO service_role;
GRANT EXECUTE ON FUNCTION eds_admin_upsert(text, text, text, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION eds_role_can(text, text)                TO service_role;

/*
  የኛ — admin authentication.
  Actions:
    bootstrap  { username, password, adminKey }  -> create first owner (ADMIN_KEY gated)
    login      { username, password }            -> { token, admin, expires_at }
    logout     { token }
    me         { token }                         -> { admin }
*/
import { json, preflight, serviceClient } from '../_shared/yena_bingo.ts';

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  try {
    const body = await req.json();
    const action: string = body.action;
    const supabase = serviceClient();

    if (action === 'bootstrap') {
      const envKey = Deno.env.get('ADMIN_KEY');
      if (!envKey || body.adminKey !== envKey) return json({ error: 'Invalid bootstrap key' }, 401);
      const { data, error } = await supabase.rpc('eds_admin_bootstrap', {
        p_username: body.username,
        p_password: body.password,
      });
      if (error) return json({ error: error.message }, 500);
      return json(data, data?.success ? 200 : 400);
    }

    if (action === 'login') {
      const { data, error } = await supabase.rpc('eds_admin_login', {
        p_username: body.username,
        p_password: body.password,
      });
      if (error) return json({ error: error.message }, 500);
      return json(data, data?.success ? 200 : 401);
    }

    if (action === 'logout') {
      await supabase.rpc('eds_admin_logout', { p_token: body.token });
      return json({ success: true });
    }

    if (action === 'me') {
      const { data } = await supabase.rpc('eds_admin_from_token', { p_token: body.token });
      if (!data) return json({ error: 'Not authenticated' }, 401);
      return json({ success: true, admin: data });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Internal error' }, 500);
  }
});

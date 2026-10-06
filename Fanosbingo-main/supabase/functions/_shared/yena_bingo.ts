// Shared helpers for የኛ edge functions.
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, X-Client-Info, Apikey, apikey, X-Admin-Token, X-Player-Token',
};

export function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  return null;
}

let _client: SupabaseClient | null = null;
export function serviceClient(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    );
  }
  return _client;
}

export interface AdminIdentity {
  id: string;
  username: string;
  role: 'owner' | 'finance' | 'support' | 'viewer';
}

/**
 * Resolve the admin identity from the request:
 *  1. `X-Admin-Token` header or body.adminToken  -> eds_admin_from_token
 *  2. `X-Admin-Key` header or body.adminKey === ADMIN_KEY env -> break-glass owner
 * Then check the permission against eds_role_can. Returns the identity or a Response error.
 */
export async function requireAdmin(
  req: Request,
  body: Record<string, unknown>,
  permission: string,
): Promise<AdminIdentity | Response> {
  const supabase = serviceClient();
  const token =
    req.headers.get('X-Admin-Token') ??
    (typeof body.adminToken === 'string' ? body.adminToken : null);

  let identity: AdminIdentity | null = null;

  if (token) {
    const { data } = await supabase.rpc('eds_admin_from_token', { p_token: token });
    if (data) identity = data as AdminIdentity;
  }

  if (!identity) {
    const key =
      req.headers.get('X-Admin-Key') ??
      (typeof body.adminKey === 'string' ? body.adminKey : null);
    const envKey = Deno.env.get('ADMIN_KEY');
    if (key && envKey && key === envKey) {
      identity = { id: 'legacy-key', username: 'legacy-key', role: 'owner' };
    }
  }

  if (!identity) return json({ error: 'Not authenticated' }, 401);

  const { data: allowed } = await supabase.rpc('eds_role_can', {
    p_role: identity.role,
    p_permission: permission,
  });
  if (!allowed) return json({ error: `Your role (${identity.role}) cannot ${permission}` }, 403);

  return identity;
}

export function isResponse(x: unknown): x is Response {
  return x instanceof Response;
}

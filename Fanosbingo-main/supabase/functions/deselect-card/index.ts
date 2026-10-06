import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

/**
 * የኛ — release a cartela before the game starts.
 * Delegates to `eds_refund_cartela()` which deletes the player row, refunds
 * entry_price to the wallet with a REFUND ledger entry, and rolls back the pot.
 *
 * Body: { playerId, telegramUserId }
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, X-Client-Info, Apikey, apikey, X-Player-Token',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { playerId, telegramUserId } = await req.json();
    if (!playerId || !telegramUserId) {
      return json({ error: 'Missing required fields: playerId, telegramUserId' }, 400);
    }

    const { data: result, error } = await supabase.rpc('eds_refund_cartela', {
      p_player_id: playerId,
      p_telegram_user_id: telegramUserId,
    });

    if (error) {
      return json({ error: error.message || 'Failed to release cartela' }, 500);
    }
    if (!result?.success) {
      const code = result?.error_code ?? 'ERROR';
      const status = code === 'FORBIDDEN' ? 403 : code === 'NOT_FOUND' ? 404 : code === 'GAME_NOT_WAITING' ? 409 : 400;
      return json({ error: result?.error ?? 'Failed to release cartela', error_code: code }, status);
    }

    return json({ success: true, cartelas: result.cartelas }, 200);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  }

  function json(payload: unknown, status: number) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

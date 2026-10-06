import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

/**
 * የኛ — select (buy/reserve) a cartela.
 *
 * All validation and money movement happens inside the authoritative
 * `eds_select_cartela()` SQL function: room + price, cartela range, availability
 * (concurrency-safe), the GLOBAL 4-cartela-per-player limit across BOTH rooms,
 * balance, wallet ledger, and pot / 80-20 update. This function only maps the
 * structured result to an HTTP status.
 *
 * Body: { gameId, room: 'etb5'|'etb10', cartelaNumber, telegramUserId,
 *         playerName, telegramUsername?, telegramFirstName?, telegramLastName? }
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, X-Client-Info, Apikey, apikey, X-Player-Token',
};

let supabaseClient: ReturnType<typeof createClient> | null = null;
function getSupabaseClient() {
  if (!supabaseClient) {
    supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false }, db: { schema: 'public' } },
    );
  }
  return supabaseClient;
}

const STATUS_BY_CODE: Record<string, number> = {
  GAME_NOT_FOUND: 404,
  GAME_NOT_WAITING: 409,
  SELECTION_CLOSED: 423,
  UNKNOWN_ROOM: 400,
  CARTELA_OUT_OF_RANGE: 400,
  CARTELA_TAKEN: 409,
  USER_NOT_FOUND: 403,
  LIMIT_REACHED: 409,
  INSUFFICIENT_BALANCE: 402,
  INTERNAL_ERROR: 500,
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = getSupabaseClient();
    const body = await req.json();

    const gameId = body.gameId;
    const room: string = body.room ?? 'etb10';
    const cartelaNumber: number = body.cartelaNumber ?? body.cardNumber;
    const telegramUserId: number = body.telegramUserId;
    const playerName: string = body.playerName;

    if (!telegramUserId || telegramUserId <= 0) {
      return json(
        { error: 'Please open የኛ bingo from Telegram to play.', error_code: 'USER_REQUIRED' },
        403,
      );
    }
    if (!gameId || !cartelaNumber || (room !== 'etb5' && room !== 'etb10')) {
      return json({ error: 'gameId, room and cartelaNumber are required', error_code: 'BAD_REQUEST' }, 400);
    }

    const { data: result, error: rpcError } = await supabase.rpc('eds_select_cartela', {
      p_game_id: gameId,
      p_room: room,
      p_cartela_number: cartelaNumber,
      p_telegram_user_id: telegramUserId,
      p_player_name: playerName,
      p_telegram_username: body.telegramUsername ?? null,
      p_telegram_first_name: body.telegramFirstName ?? null,
      p_telegram_last_name: body.telegramLastName ?? null,
    });

    if (rpcError) {
      return json({ error: rpcError.message || 'Failed to select cartela', error_code: 'INTERNAL_ERROR' }, 500);
    }

    if (!result?.success) {
      const code = result?.error_code ?? 'INTERNAL_ERROR';
      return json({ error: result?.error ?? 'Failed to select cartela', error_code: code, ...result }, STATUS_BY_CODE[code] ?? 400);
    }

    return json(
      {
        success: true,
        playerId: result.player_id,
        room: result.room,
        cartelaNumber: result.cartela_number,
        price: result.price,
        card: result.card,
        cartelas: result.cartelas,
        max: result.max,
        selection_closed_at: result.selection_closed_at,
        starts_at: result.starts_at,
      },
      200,
    );
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Internal server error', error_code: 'INTERNAL_ERROR' }, 500);
  }

  function json(payload: unknown, status: number) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

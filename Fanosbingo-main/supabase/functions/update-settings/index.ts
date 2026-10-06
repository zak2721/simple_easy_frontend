/*
  የኛ — update a runtime `settings` row.

  OWNER-ONLY (RBAC `settings.manage`, or the ADMIN_KEY break-glass). Only an
  allow-listed set of keys can be written, and business invariants are
  re-checked so the panel can never put the room/prize config into an illegal
  state.

  Body: { key, value, adminToken? | adminKey? }   (legacy: { key, value, adminKey })
*/
import { json, preflight, serviceClient, requireAdmin, isResponse } from '../_shared/yena_bingo.ts';

// Keys an owner may set from the panel. Secrets + config invariants included, but
// invariants are validated after the write.
const ALLOWED = new Set([
  'telegram_bot_token',
  'telegram_bot_username',
  'game_url',
  'user_instructions',
  'support_contact',
  'TELEBIRR_ACCOUNT_NAME',
  'TELEBIRR_ACCOUNT_NUMBER',
  'TELEBIRR_INSTRUCTIONS',
  'DEPOSIT_MIN_ETB',
  'DEPOSIT_MAX_ETB',
  'WITHDRAWAL_MIN_ETB',
  'WITHDRAWAL_MAX_ETB',
  'SIGNUP_BONUS_ETB',
  'REFERRAL_BONUS_REFERRER',
  'REFERRAL_BONUS_NEW_USER',
  'REFERRAL_MAX',
  // room / prize config — allowed but invariant-checked below
  'ETB5_ROOM_PRICE',
  'ETB10_ROOM_PRICE',
  'ETB5_ROOM_CAPACITY',
  'ETB10_ROOM_CAPACITY',
  'MAX_STANDARD_CARTELAS',
  'MAX_CARTELAS_PER_PLAYER',
  'WINNER_PERCENTAGE',
  'HOUSE_PERCENTAGE',
]);

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  try {
    const body = await req.json();
    const key: string = body.key;
    const value: string = body.value;

    if (!key || value === undefined || value === null) {
      return json({ error: 'key and value are required' }, 400);
    }
    if (!ALLOWED.has(key)) {
      return json({ error: `Setting "${key}" cannot be changed here` }, 403);
    }

    const admin = await requireAdmin(req, body, 'settings.manage');
    if (isResponse(admin)) return admin;

    const supabase = serviceClient();

    const { data: prev } = await supabase.from('settings').select('value').eq('id', key).maybeSingle();

    const { error } = await supabase
      .from('settings')
      .upsert({ id: key, value: String(value), updated_at: new Date().toISOString(), updated_by: admin.username }, { onConflict: 'id' });
    if (error) return json({ error: error.message }, 500);

    // Re-check invariants; roll back this write if it broke them.
    const { data: cfg } = await supabase.rpc('eds_config');
    const c = cfg as Record<string, number>;
    const bad =
      c.etb5_capacity + c.etb10_capacity !== c.standard_total_cartelas ||
      c.winner_percentage + c.house_percentage !== 100 ||
      c.max_cartelas_per_player !== 4;

    if (bad) {
      await supabase.from('settings').upsert(
        { id: key, value: prev?.value ?? '', updated_at: new Date().toISOString(), updated_by: 'system-rollback' },
        { onConflict: 'id' },
      );
      return json({ error: 'Rejected: this change breaks a business invariant (room capacities must sum to 600, prize split to 100, max cartelas = 4).' }, 422);
    }

    // keep the legacy commission_rate mirror in sync
    if (key === 'HOUSE_PERCENTAGE') {
      await supabase.from('settings').upsert({ id: 'commission_rate', value: String(value) }, { onConflict: 'id' });
    }

    await supabase.rpc('eds_audit', {
      p_admin: admin.username, p_action: 'settings.update', p_entity_type: 'settings', p_entity_id: key,
      p_prev: prev ? { value: prev.value } : null, p_new: { value: String(value) }, p_reason: null,
    });

    return json({ success: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Internal error' }, 500);
  }
});

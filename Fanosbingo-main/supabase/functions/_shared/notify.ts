// የኛ — send a Telegram message to a player from the bot.
// Best-effort: never throws (a failed notification must not fail the action).
import { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

let cachedToken: string | null | undefined;

async function botToken(supabase: SupabaseClient): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken ?? null;
  const { data } = await supabase.from('settings').select('value').eq('id', 'telegram_bot_token').maybeSingle();
  cachedToken = data?.value || Deno.env.get('TELEGRAM_BOT_TOKEN') || null;
  return cachedToken;
}

export async function notifyPlayer(
  supabase: SupabaseClient,
  telegramUserId: number | string | null | undefined,
  message: string,
): Promise<void> {
  try {
    if (!telegramUserId) return;
    const token = await botToken(supabase);
    if (!token) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramUserId, text: message, parse_mode: 'HTML' }),
    });
  } catch (_e) {
    // swallow — notifications are best-effort
  }
}

// የኛ — persist a player's UI language (en | am | om | ti).
// Body: { language, telegramUserId } + player token
import { json, preflight, serviceClient } from '../_shared/yena_bingo.ts';
import { resolvePlayer } from '../_shared/telegram.ts';

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  try {
    const body = await req.json();
    const user = await resolvePlayer(req, body);
    const language: string = body.language;

    if (!user) return json({ error: 'Telegram session required' }, 403);
    if (language !== 'en' && language !== 'am' && language !== 'om' && language !== 'ti') {
      return json({ error: 'Unsupported language', error_code: 'BAD_LANG' }, 400);
    }

    const supabase = serviceClient();
    const { data, error } = await supabase.rpc('eds_set_language', { p_user: user, p_lang: language });
    if (error) return json({ error: error.message }, 500);
    return json(data, data?.success ? 200 : 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Internal error' }, 500);
  }
});

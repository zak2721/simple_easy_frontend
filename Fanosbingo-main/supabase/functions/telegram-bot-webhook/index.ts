import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { botT, playerLang, Lang, normalizeLang } from "../_shared/i18n.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: {
    id: number;
    type: string;
  };
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

async function sendTelegramMessage(
  botToken: string,
  chatId: number,
  text: string,
  replyMarkup?: unknown
) {
  const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: text,
    parse_mode: "HTML",
  };

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  const response = await fetch(telegramUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return response.json();
}

async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  text?: string
) {
  const telegramUrl = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;

  const body: Record<string, unknown> = {
    callback_query_id: callbackQueryId,
  };

  if (text) {
    body.text = text;
  }

  const response = await fetch(telegramUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return response.json();
}

/**
 * Build the "Play የኛ bingo" Mini App button. Telegram rejects web_app
 * buttons whose URL is empty or non-HTTPS, so return undefined when the game
 * URL has not been configured yet (admin sets it in Settings → game_url).
 */
function playKeyboard(appUrl: string, lang: Lang = 'am') {
  if (!appUrl || !/^https:\/\//i.test(appUrl)) return undefined;
  return {
    inline_keyboard: [[{ text: botT(lang, 'playButton'), web_app: { url: appUrl } }]],
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: settingData } = await supabaseClient
      .from("settings")
      .select("value")
      .eq("id", "telegram_bot_token")
      .single();

    const botToken = settingData?.value || Deno.env.get("TELEGRAM_BOT_TOKEN");

    if (!botToken) {
      return new Response(
        JSON.stringify({ error: "Bot token not configured" }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    const update: TelegramUpdate = await req.json();

    if (update.callback_query) {
      // የኛ has no inline-button actions (transfers were removed). Ack any
      // stale callback so the client stops showing a spinner.
      const callbackQuery = update.callback_query;
      const chatId = callbackQuery.message?.chat.id;
      await answerCallbackQuery(botToken, callbackQuery.id);
      if (chatId) {
        const lang = await playerLang(supabaseClient, callbackQuery.from?.id);
        await sendTelegramMessage(botToken, chatId, botT(lang, 'openWithPlay'));
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
    }

    if (!update.message || !update.message.text) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
    }

    const message = update.message;
    const chatId = message.chat.id;
    const text = message.text;
    const user = message.from;

    const { data: userState } = await supabaseClient
      .from("user_state")
      .select("*")
      .eq("telegram_user_id", user.id)
      .maybeSingle();

    if (userState && userState.current_action && userState.current_action.startsWith("transfer_")) {
      // Transfers are disabled for የኛ — clear any stale state and inform.
      await supabaseClient.from("user_state").delete().eq("telegram_user_id", user.id);
      await sendTelegramMessage(
        botToken, chatId,
        botT(await playerLang(supabaseClient, user.id), 'transfersDisabled'),
      );
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    if (text.startsWith("/start") || text.startsWith("/register")) {
      await supabaseClient
        .from("user_state")
        .delete()
        .eq("telegram_user_id", user.id);

      const referralCode = text.startsWith("/start ") ? text.split(" ")[1] : null;

      const { data: existingUser } = await supabaseClient
        .from("telegram_users")
        .select("*")
        .eq("telegram_user_id", user.id)
        .maybeSingle();

      let userData;
      let isNewUser = false;
      let referralBonus = 0;

      if (!existingUser) {
        // የኛ: create via eds_ensure_player so the signup bonus flows
        // through the wallet ledger and uses the configured amount.
        const { error: ensureErr } = await supabaseClient.rpc("eds_ensure_player", {
          p_user: user.id,
          p_username: user.username ?? null,
          p_first_name: user.first_name ?? null,
          p_last_name: user.last_name ?? null,
        });
        const { data: newUser } = await supabaseClient
          .from("telegram_users")
          .select("*")
          .eq("telegram_user_id", user.id)
          .single();
        const error = ensureErr;

        if (error) {
          console.error("Error creating user:", error);
          await sendTelegramMessage(
            botToken,
            chatId,
            botT(normalizeLang(user.language_code), 'registerError'),
          );
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          });
        }

        userData = newUser;
        isNewUser = true;

        if (referralCode) {
          const { data: bonusResult } = await supabaseClient.rpc(
            "handle_referral_bonus",
            {
              new_user_telegram_id: user.id,
              referrer_code: referralCode,
            }
          );

          if (bonusResult && bonusResult.success) {
            referralBonus = bonusResult.new_user_bonus;

            const { data: updatedUser } = await supabaseClient
              .from("telegram_users")
              .select("balance, deposited_balance")
              .eq("telegram_user_id", user.id)
              .single();

            userData = { ...userData, ...updatedUser };
          }
        }
      } else {
        await supabaseClient
          .from("telegram_users")
          .update({ last_active_at: new Date().toISOString() })
          .eq("telegram_user_id", user.id);

        userData = existingUser;
      }

      const lang = normalizeLang(userData?.language_code);

      if (text.startsWith("/register")) {
        if (isNewUser) {
          let message = botT(lang, 'registered', { bonus: 10 });
          if (referralBonus > 0) message += '\n' + botT(lang, 'referralBonus', { amount: referralBonus });
          await sendTelegramMessage(botToken, chatId, message);
        } else {
          await sendTelegramMessage(botToken, chatId, botT(lang, 'alreadyRegistered'));
        }
      } else {
        let welcomeMessage;
        if (isNewUser) {
          welcomeMessage = botT(lang, 'welcomeNew', { name: user.first_name, bonus: 10 });
          if (referralBonus > 0) welcomeMessage += '\n' + botT(lang, 'referralBonus', { amount: referralBonus });
          welcomeMessage += '\n\n' + botT(lang, 'tapToPlay');
        } else {
          welcomeMessage = botT(lang, 'welcomeBack', { name: user.first_name, balance: userData.balance }) +
            '\n\n' + botT(lang, 'readyToPlay');
        }

        const { data: gameUrlData } = await supabaseClient
          .from("settings").select("value").eq("id", "game_url").maybeSingle();

        const appUrl = gameUrlData?.value || Deno.env.get("YENA_BINGO_APP_URL") || "";
        const kb = playKeyboard(appUrl, lang);

        await sendTelegramMessage(
          botToken, chatId,
          kb ? welcomeMessage : welcomeMessage + botT(lang, 'gameUrlNotSet'),
          kb,
        );
      }
    } else if (text.startsWith("/play")) {
      await supabaseClient
        .from("user_state")
        .delete()
        .eq("telegram_user_id", user.id);

      const { data: existingUser } = await supabaseClient
        .from("telegram_users")
        .select("*")
        .eq("telegram_user_id", user.id)
        .maybeSingle();

      if (!existingUser) {
        await sendTelegramMessage(botToken, chatId, botT(normalizeLang(undefined), 'registerFirst'));
      } else {
        const lang = normalizeLang(existingUser.language_code);
        await supabaseClient
          .from("telegram_users")
          .update({ last_active_at: new Date().toISOString() })
          .eq("telegram_user_id", user.id);

        const { data: gameUrlData } = await supabaseClient
          .from("settings")
          .select("value")
          .eq("id", "game_url")
          .maybeSingle();

        const appUrl = gameUrlData?.value || Deno.env.get("YENA_BINGO_APP_URL") || "";
        const kb = playKeyboard(appUrl, lang);

        await sendTelegramMessage(
          botToken,
          chatId,
          kb ? botT(lang, 'goodLuck') : botT(lang, 'goodLuck') + botT(lang, 'gameUrlNotSet'),
          kb
        );
      }
    } else if (text.startsWith("/balance")) {
      await supabaseClient
        .from("user_state")
        .delete()
        .eq("telegram_user_id", user.id);

      const { data: existingUser } = await supabaseClient
        .from("telegram_users")
        .select("*")
        .eq("telegram_user_id", user.id)
        .maybeSingle();

      if (!existingUser) {
        await sendTelegramMessage(botToken, chatId, botT(normalizeLang(undefined), 'registerFirst'));
      } else {
        const lang = normalizeLang(existingUser.language_code);
        await supabaseClient
          .from("telegram_users")
          .update({ last_active_at: new Date().toISOString() })
          .eq("telegram_user_id", user.id);

        const { data: pendingWithdrawals } = await supabaseClient
          .from("withdrawal_requests")
          .select("amount")
          .eq("telegram_user_id", user.id)
          .in("status", ["pending", "processing"]);

        const pendingAmount = (pendingWithdrawals ?? []).reduce((sum: number, w: { amount: number | string }) => sum + Number(w.amount), 0) || 0;
        const availableWonBalance = Number(existingUser.won_balance || 0) - pendingAmount;

        let balanceMessage = `<b>${botT(lang, 'balanceTitle')}</b>\n\n`;
        balanceMessage += botT(lang, 'balanceTotal', { amount: existingUser.balance }) + '\n';
        balanceMessage += botT(lang, 'balanceWon', { amount: existingUser.won_balance || 0 }) + '\n';
        balanceMessage += botT(lang, 'balanceDeposited', { amount: existingUser.deposited_balance || 0 });

        if (pendingAmount > 0) {
          balanceMessage += '\n\n' + botT(lang, 'balancePending', { amount: pendingAmount });
        }
        balanceMessage += '\n' + botT(lang, 'balanceAvailable', { amount: availableWonBalance });
        balanceMessage += `\n\n<i>${botT(lang, 'balanceNote')}</i>`;

        await sendTelegramMessage(botToken, chatId, balanceMessage);
      }
    } else if (text.startsWith("/invite")) {
      await supabaseClient
        .from("user_state")
        .delete()
        .eq("telegram_user_id", user.id);

      const { data: existingUser } = await supabaseClient
        .from("telegram_users")
        .select("referral_code, total_referrals, language_code")
        .eq("telegram_user_id", user.id)
        .maybeSingle();

      if (!existingUser) {
        await sendTelegramMessage(botToken, chatId, botT(normalizeLang(undefined), 'registerFirst'));
      } else {
        const lang = normalizeLang(existingUser.language_code);
        const { data: botUsernameData } = await supabaseClient
          .from("settings")
          .select("value")
          .eq("id", "telegram_bot_username")
          .maybeSingle();

        const botUsername = botUsernameData?.value || Deno.env.get("TELEGRAM_BOT_USERNAME") || "your_bot";
        const inviteLink = `https://t.me/${botUsername}?start=${existingUser.referral_code}`;
        const referrals = existingUser.total_referrals || 0;

        await sendTelegramMessage(
          botToken,
          chatId,
          `<b>${botT(lang, 'inviteTitle')}</b>\n\n` +
            botT(lang, 'inviteBody', {
              perReferral: 5,
              link: `<code>${inviteLink}</code>`,
              count: referrals,
              earned: referrals * 5,
            }),
        );
      }
    } else if (text.startsWith("/instructions")) {
      await supabaseClient
        .from("user_state")
        .delete()
        .eq("telegram_user_id", user.id);

      const { data: existingUser } = await supabaseClient
        .from("telegram_users")
        .select("*")
        .eq("telegram_user_id", user.id)
        .maybeSingle();

      if (!existingUser) {
        await sendTelegramMessage(botToken, chatId, botT(normalizeLang(undefined), 'registerFirst'));
      } else {
        const lang = normalizeLang(existingUser.language_code);
        const { data: instructionsData } = await supabaseClient
          .from("settings")
          .select("value")
          .eq("id", "user_instructions")
          .maybeSingle();

        const instructions = instructionsData?.value || botT(lang, 'instructionsMissing');

        await sendTelegramMessage(
          botToken,
          chatId,
          `<b>${botT(lang, 'instructionsTitle')}</b>\n\n${instructions}`
        );
      }
    } else if (text.startsWith("/transfer")) {
      await sendTelegramMessage(
        botToken,
        chatId,
        botT(await playerLang(supabaseClient, user.id), 'transfersDisabled'),
      );
    } else if (text.startsWith("/deposit") || text.startsWith("/withdraw")) {
      const { data: existingUser } = await supabaseClient
        .from("telegram_users")
        .select("telegram_user_id, language_code")
        .eq("telegram_user_id", user.id)
        .maybeSingle();

      if (!existingUser) {
        await sendTelegramMessage(botToken, chatId, botT(normalizeLang(undefined), 'registerFirst'));
      } else {
        const lang = normalizeLang(existingUser.language_code);
        const { data: acct } = await supabaseClient.rpc("eds_telebirr_account");
        const { data: gameUrlData } = await supabaseClient
          .from("settings").select("value").eq("id", "game_url").maybeSingle();
        const appUrl = gameUrlData?.value || Deno.env.get("YENA_BINGO_APP_URL") || "";
        const kb = playKeyboard(appUrl, lang);

        if (text.startsWith("/deposit")) {
          const acctText = acct?.configured
            ? botT(lang, 'depositAccount', { name: acct.account_name, number: `<code>${acct.account_number}</code>` })
            : botT(lang, 'depositAccountMissing');
          await sendTelegramMessage(
            botToken, chatId,
            `<b>${botT(lang, 'depositTitle')}</b>${acctText}${botT(lang, 'depositSteps')}${kb ? "" : botT(lang, 'gameUrlNotSet')}`,
            kb,
          );
        } else {
          await sendTelegramMessage(
            botToken, chatId,
            botT(lang, 'withdrawInfo') + (kb ? "" : botT(lang, 'gameUrlNotSet')),
            kb,
          );
        }
      }
    } else {
      const { data: existingUser } = await supabaseClient
        .from("telegram_users")
        .select("telegram_user_id, language_code")
        .eq("telegram_user_id", user.id)
        .maybeSingle();

      if (!existingUser) {
        await sendTelegramMessage(botToken, chatId, botT(normalizeLang(undefined), 'registerFirst'));
      } else {
        await sendTelegramMessage(
          botToken,
          chatId,
          botT(normalizeLang(existingUser.language_code), 'commands'),
        );
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error processing webhook:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});
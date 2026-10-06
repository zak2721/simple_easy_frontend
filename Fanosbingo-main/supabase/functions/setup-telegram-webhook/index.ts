import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { botCommands, BOT_COMMAND_LANGS } from "../_shared/i18n.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface SetupWebhookRequest {
  adminKey: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { adminKey }: SetupWebhookRequest = await req.json();
    const validAdminKey = Deno.env.get("ADMIN_KEY");

    if (!validAdminKey || adminKey !== validAdminKey) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        {
          status: 401,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

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

    const webhookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-bot-webhook`;

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${botToken}/setWebhook`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: webhookUrl,
        }),
      }
    );

    const result = await telegramResponse.json();

    if (!telegramResponse.ok || !result.ok) {
      return new Response(
        JSON.stringify({ error: "Failed to set webhook", details: result }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    // Register the command menu once per supported language. Telegram falls
    // back to the default (English) list for any client whose language has no
    // dedicated list, so set 'en' as the default (no language_code) too.
    const setCommands = (body: Record<string, unknown>) =>
      fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());

    const commandsResult: Record<string, unknown> = {};
    commandsResult["default"] = await setCommands({ commands: botCommands("en") });
    for (const lang of BOT_COMMAND_LANGS) {
      commandsResult[lang] = await setCommands({
        commands: botCommands(lang),
        language_code: lang,
      });
    }

    return new Response(
      JSON.stringify({ success: true, webhookUrl, webhook: result, commands: commandsResult }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Error setting up webhook:", error);
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
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Operator } from '@prisma/client';
import * as crypto from 'crypto';
import { OperatorsService } from '../operators/operators.service';

export interface TgUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

/**
 * Finding SEC-10 (Medium): every message this service sends uses
 * `parse_mode: 'HTML'`. deposits.service.ts / withdrawals.service.ts build
 * the rejection message with a raw template literal embedding an admin's
 * free-text `rejectionReason` (no length/content restriction) straight into
 * that HTML-mode message, sent to the PLAYER being rejected. Unescaped, that
 * text could embed `<a href="...">` styled to look like an official
 * platform message — a phishing vector via a lower-privileged or
 * compromised admin account, not the player who receives it. Every call
 * site that builds an HTML-mode message from a non-hardcoded string should
 * escape through this first.
 */
export function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Verifies Telegram Mini App `initData` per Telegram's documented algorithm:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Ported 1:1 from the previous Supabase edge function
 * (supabase/functions/_shared/telegram.ts) — same HMAC-SHA256 construction,
 * just using Node's `crypto` instead of Web Crypto/Deno.
 */
/**
 * Every operator has its own bot (the default operator uses the platform bot
 * from env). Every method therefore takes the operator whose bot to use —
 * sending a player a message from the wrong operator's bot would leak one
 * operator's players to another.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly operators: OperatorsService,
  ) {}

  private get allowUnverified(): boolean {
    return this.config.get<string>('ALLOW_UNVERIFIED_TELEGRAM') === 'true';
  }

  private async tokenFor(operatorId: string): Promise<string> {
    try {
      return this.operators.botToken(await this.operators.get(operatorId));
    } catch (e) {
      this.logger.error(`Bot token unavailable for operator ${operatorId}`, e instanceof Error ? e.message : String(e));
      return '';
    }
  }

  /**
   * Audit finding BOT-1 (Critical): the webhook endpoint had no verification
   * that a request actually came from Telegram — anyone could POST a
   * fabricated update and have the bot process it as a real user (including
   * disclosing another user's wallet balance via /balance, see
   * TelegramBotController). Telegram signs every webhook delivery with this
   * header when a `secret_token` was registered via setWebhook — verify it
   * with a timing-safe comparison, same pattern as ADMIN_KEY in AuthService.
   */
  verifyWebhookSecret(operator: Operator, providedSecret: string | undefined): boolean {
    const expected = this.operators.webhookSecret(operator);
    if (!expected) return false; // fail closed if not configured — never silently accept
    const a = Buffer.from(providedSecret ?? '');
    const b = Buffer.from(expected);
    if (a.length !== b.length) {
      crypto.timingSafeEqual(b, b); // dummy compare, same timing-leak defence as constantTimeStringEquals
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Returns the verified Telegram user, or null if the signature/freshness
   * check fails. `botToken` must be the entered operator's own token: initData
   * signed by any other bot is rejected.
   */
  verifyInitData(initData: string, botToken: string, maxAgeSec = 86400): TgUser | null {
    if (!initData || !botToken) return null;

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');

    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    // Constant-time comparison — never use === on secrets derived from user input.
    const expectedBuf = Buffer.from(expected, 'hex');
    const hashBuf = Buffer.from(hash, 'hex');
    if (expectedBuf.length !== hashBuf.length || !crypto.timingSafeEqual(expectedBuf, hashBuf)) {
      return null;
    }

    const authDate = Number(params.get('auth_date') ?? 0);
    if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;

    try {
      const user = JSON.parse(params.get('user') ?? 'null');
      if (!user?.id) return null;
      return user as TgUser;
    } catch {
      return null;
    }
  }

  /**
   * DEV-ONLY escape hatch, mirrors the old edge function behaviour exactly:
   * only active when ALLOW_UNVERIFIED_TELEGRAM=true, so a real deployment
   * with that flag unset can never accept a spoofed identity.
   */
  resolveDevUser(rawTelegramUserId: unknown): number | null {
    if (!this.allowUnverified) return null;
    const raw = Number(rawTelegramUserId);
    return raw > 0 ? raw : null;
  }

  async sendMessage(operatorId: string, chatId: number | string, text: string): Promise<void> {
    const token = await this.tokenFor(operatorId);
    if (!token) return;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      });
    } catch {
      // Notifications are best-effort — never fail the caller's transaction over a Telegram outage.
    }
  }

  /** Sends a message with a single inline "open Mini App" button — used by /start and /play. */
  async sendMessageWithWebAppButton(operatorId: string, chatId: number | string, text: string, buttonText: string, webAppUrl: string): Promise<void> {
    const token = await this.tokenFor(operatorId);
    if (!token) return;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: buttonText, web_app: { url: webAppUrl } }]] },
        }),
      });
    } catch {
      // best-effort, see sendMessage
    }
  }

  /** Validates a bot token with Telegram. Returns the bot's username, or null if Telegram rejects the token. */
  async getMe(botToken: string): Promise<{ id: number; username: string } | null> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const body = (await res.json()) as { ok: boolean; result?: { id: number; username?: string; is_bot?: boolean } };
      if (!body.ok || !body.result?.is_bot || !body.result.username) return null;
      return { id: body.result.id, username: body.result.username };
    } catch {
      return null;
    }
  }

  /** Points the bot's chat menu button at the operator's Mini App. */
  async setMenuButton(operatorId: string, text: string, webAppUrl: string): Promise<void> {
    const token = await this.tokenFor(operatorId);
    if (!token || !webAppUrl) return;
    await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ menu_button: { type: 'web_app', text: text.slice(0, 64), web_app: { url: webAppUrl } } }),
    });
  }

  /**
   * Registers the operator's webhook + command list with Telegram. The default
   * operator keeps its original path (/telegram/webhook); every other operator
   * gets /telegram/webhook/<slug> with its own secret.
   */
  async setupWebhook(operatorId: string, publicApiUrl: string): Promise<{ webhookUrl: string; ok: boolean; description?: string }> {
    const operator = await this.operators.get(operatorId);
    const token = this.operators.botToken(operator);
    const secret = this.operators.webhookSecret(operator);
    if (!token) throw new Error('This operator has no Telegram bot token configured');
    if (!secret) throw new Error('This operator has no webhook secret configured — refusing to register an unverifiable webhook');
    const base = `${publicApiUrl.replace(/\/$/, '')}/telegram/webhook`;
    const webhookUrl = this.operators.isDefault(operator.id) ? base : `${base}/${operator.slug}`;

    const hookRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, secret_token: secret }),
    });
    const hookData = (await hookRes.json()) as { ok: boolean; description?: string };

    await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'play', description: 'Open the game' },
          { command: 'balance', description: 'Check your wallet' },
          { command: 'deposit', description: 'How to deposit via Telebirr' },
          { command: 'withdraw', description: 'How to withdraw your winnings' },
          { command: 'invite', description: 'Your referral link' },
          { command: 'instructions', description: 'Game rules' },
        ],
      }),
    });

    return { webhookUrl, ok: hookData.ok, description: hookData.description };
  }
}

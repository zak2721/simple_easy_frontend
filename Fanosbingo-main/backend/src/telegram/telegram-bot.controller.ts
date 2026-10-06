import { Body, Controller, Headers, NotFoundException, Param, Post, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Operator } from '@prisma/client';
import { Public } from '../common/decorators/public.decorator';
import { TelegramService } from './telegram.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { SettingsService } from '../settings/settings.service';
import { OperatorsService } from '../operators/operators.service';
import { DEFAULT_OPERATOR_ID, OPERATOR_SLUG_PATTERN } from '../common/operator.constants';
import { botT, normalizeLang } from './bot-i18n';
import { TelegramUpdateDto, TgMessageDto } from './dto/telegram-update.dto';

/** Audit finding SEC-7 (Medium): was left on the generic 120/min global limit — every command does a DB read, and (pre-BOT-1-fix) this was reachable by anyone, not just Telegram. Tighter but still generous enough for a real burst of user commands. */
const WEBHOOK_THROTTLE = { default: { limit: 30, ttl: 10_000 } };

type Lang = ReturnType<typeof normalizeLang>;

/**
 * Full bot command set. Each operator's bot posts to its own webhook
 * (/telegram/webhook for the default operator, /telegram/webhook/<slug> for
 * the rest) with its own secret, and every command answers with that
 * operator's data only: its player account, its Telebirr account, its links.
 */
@Controller('telegram')
export class TelegramBotController {
  constructor(
    private readonly telegram: TelegramService,
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly settings: SettingsService,
    private readonly operators: OperatorsService,
  ) {}

  /** Default operator's bot — path unchanged so the already-registered webhook keeps working. */
  @Public()
  @Throttle(WEBHOOK_THROTTLE)
  @Post('webhook')
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') secretToken: string | undefined,
    @Body() update: TelegramUpdateDto,
  ) {
    return this.handle(await this.operators.get(DEFAULT_OPERATOR_ID), secretToken, update);
  }

  @Public()
  @Throttle(WEBHOOK_THROTTLE)
  @Post('webhook/:slug')
  async operatorWebhook(
    @Param('slug') slug: string,
    @Headers('x-telegram-bot-api-secret-token') secretToken: string | undefined,
    @Body() update: TelegramUpdateDto,
  ) {
    if (!OPERATOR_SLUG_PATTERN.test(slug)) throw new NotFoundException();
    return this.handle(await this.operators.getBySlug(slug), secretToken, update);
  }

  /**
   * Audit finding BOT-1 (Critical): the secret Telegram echoes back on every
   * delivery is verified against THIS operator's secret before any business
   * logic runs, so one operator's bot can't be used to drive another's.
   */
  private async handle(operator: Operator, secretToken: string | undefined, update: TelegramUpdateDto) {
    if (!this.telegram.verifyWebhookSecret(operator, secretToken)) {
      throw new UnauthorizedException('Invalid webhook secret');
    }
    // A suspended operator's bot stays silent rather than erroring, so Telegram doesn't retry deliveries.
    if (operator.status !== 'active') return { ok: true };

    const msg = update.message;
    if (!msg?.text || !msg.from) return { ok: true };

    const [command] = msg.text.trim().split(/\s+/);
    const chatId = msg.chat.id;
    const tgUserId = msg.from.id;

    const user = await this.prisma.telegramUser.findUnique({
      where: { operatorId_telegramUserId: { operatorId: operator.id, telegramUserId: BigInt(tgUserId) } },
    });
    const lang = normalizeLang(user?.languageCode ?? msg.from.language_code);
    const appUrl = this.operators.appUrl(operator);

    switch (command) {
      case '/start':
        return this.handleStart(operator, chatId, user, msg.from, lang, appUrl);
      case '/play':
        return this.handlePlay(operator, chatId, lang, appUrl);
      case '/balance':
        return this.handleBalance(operator, chatId, user?.id, lang);
      case '/deposit':
        return this.handleDeposit(operator, chatId, lang);
      case '/withdraw':
        await this.telegram.sendMessage(operator.id, chatId, botT(lang, 'withdrawInfo'));
        return { ok: true };
      case '/invite':
        return this.handleInvite(operator, chatId, user?.referralCode, lang, appUrl);
      case '/instructions':
        return this.handleInstructions(operator, chatId, lang);
      case '/commands':
      case '/help':
        await this.telegram.sendMessage(operator.id, chatId, botT(lang, 'commands'));
        return { ok: true };
      default:
        return { ok: true };
    }
  }

  private async handleStart(
    operator: Operator,
    chatId: number,
    existing: { id: string } | null,
    from: NonNullable<TgMessageDto['from']>,
    lang: Lang,
    appUrl: string,
  ) {
    if (existing) {
      const w = await this.wallet.getWallet(existing.id);
      await this.telegram.sendMessage(operator.id, chatId, botT(lang, 'welcomeBack', { name: from.first_name ?? '', balance: w.total_balance }));
    } else {
      const bonusSetting = await this.settings.get('SIGNUP_BONUS_ETB', operator.id);
      await this.telegram.sendMessage(operator.id, chatId, botT(lang, 'welcomeNew', { name: from.first_name ?? '', bonus: bonusSetting ?? '0' }));
      // Actual user row + bonus grant happens on first real Mini App login
      // (AuthService.telegramLogin) — the bot message here is a preview,
      // without duplicating the signup-bonus-grant logic in two places.
    }

    await this.sendPlayButton(operator, chatId, lang, appUrl);
    return { ok: true };
  }

  private async handlePlay(operator: Operator, chatId: number, lang: Lang, appUrl: string) {
    await this.sendPlayButton(operator, chatId, lang, appUrl);
    return { ok: true };
  }

  private async sendPlayButton(operator: Operator, chatId: number, lang: Lang, appUrl: string) {
    if (!appUrl) {
      await this.telegram.sendMessage(operator.id, chatId, botT(lang, 'gameUrlNotSet'));
      return;
    }
    await this.telegram.sendMessageWithWebAppButton(operator.id, chatId, botT(lang, 'tapToPlay'), botT(lang, 'playButton'), appUrl);
  }

  private async handleBalance(operator: Operator, chatId: number, userId: string | undefined, lang: Lang) {
    if (!userId) {
      await this.telegram.sendMessage(operator.id, chatId, botT(lang, 'registerFirst'));
      return { ok: true };
    }
    const w = await this.wallet.getWallet(userId);
    const text = [
      botT(lang, 'balanceTitle'),
      botT(lang, 'balanceTotal', { amount: w.total_balance }),
      botT(lang, 'balanceWon', { amount: w.won_balance }),
      botT(lang, 'balanceDeposited', { amount: w.deposited_balance }),
      botT(lang, 'balanceAvailable', { amount: w.withdrawable }),
      '',
      botT(lang, 'balanceNote'),
    ].join('\n');
    await this.telegram.sendMessage(operator.id, chatId, text);
    return { ok: true };
  }

  private async handleDeposit(operator: Operator, chatId: number, lang: Lang) {
    const account = await this.settings.getTelebirrAccount(operator.id);
    const text = account.configured
      ? botT(lang, 'depositTitle') + botT(lang, 'depositAccount', { name: account.account_name, number: account.account_number }) + botT(lang, 'depositSteps')
      : botT(lang, 'depositTitle') + botT(lang, 'depositAccountMissing');
    await this.telegram.sendMessage(operator.id, chatId, text);
    return { ok: true };
  }

  private async handleInvite(operator: Operator, chatId: number, referralCode: string | undefined, lang: Lang, appUrl: string) {
    if (!referralCode) {
      await this.telegram.sendMessage(operator.id, chatId, botT(lang, 'registerFirst'));
      return { ok: true };
    }
    const botUsername = this.operators.botUsername(operator);
    const link = botUsername ? `https://t.me/${botUsername}?start=ref_${referralCode}` : appUrl;
    await this.telegram.sendMessage(operator.id, chatId, botT(lang, 'inviteTitle') + '\n\n' + botT(lang, 'inviteBody', { link, code: referralCode }));
    return { ok: true };
  }

  private async handleInstructions(operator: Operator, chatId: number, lang: Lang) {
    const text = await this.settings.get('USER_INSTRUCTIONS', operator.id);
    await this.telegram.sendMessage(operator.id, chatId, botT(lang, 'instructionsTitle') + '\n\n' + (text || botT(lang, 'instructionsMissing')));
    return { ok: true };
  }
}

/**
 * Bot-facing copy, ported from the frontend's src/i18n/{en,am,om,ti}.ts
 * `bot.*` keys (same wording, same {placeholder} interpolation). Duplicated
 * here rather than imported cross-package because the backend is a
 * separately-deployed Node process, not bundled with the Vite frontend —
 * this mirrors the same duplication pattern the previous Deno edge function
 * (supabase/functions/_shared/i18n.ts) already used for the same reason.
 *
 * Kept intentionally small: only the keys the bot actually sends. See
 * PRODUCTION_MIGRATION_REPORT.md for the full key set if extending.
 */
export type BotLang = 'am' | 'en' | 'om' | 'ti';
export const DEFAULT_BOT_LANG: BotLang = 'am';

export function normalizeLang(lang: string | null | undefined): BotLang {
  return lang === 'en' || lang === 'om' || lang === 'ti' ? lang : DEFAULT_BOT_LANG;
}

type BotDict = Record<string, string>;

const en: BotDict = {
  welcomeNew: '🎉 Welcome to {app}, {name}!\n\n💰 Welcome bonus: {bonus} ETB',
  welcomeBack: '👋 Welcome back, {name}!\n\n💰 Your balance: {balance} ETB',
  tapToPlay: '🎮 Tap the button below to start playing!',
  playButton: '🎮 Play {app}',
  gameUrlNotSet: "\n\n⚠️ The game link isn't configured yet. An admin must set it in the {app} admin panel (Settings → Mini App URL).",
  balanceTitle: '💰 Your Balance',
  balanceTotal: '🎮 Total balance: {amount} ETB',
  balanceWon: '🏆 Winnings: {amount} ETB',
  balanceDeposited: '💵 Deposited: {amount} ETB',
  balanceAvailable: '✅ Available to withdraw: {amount} ETB',
  balanceNote: '⚠️ Only winnings can be withdrawn. Deposited money is for playing games.',
  depositTitle: '💰 Deposit (manual Telebirr)',
  depositAccount: '\n\n{app} Telebirr account\n👤 {name}\n📱 {number}',
  depositAccountMissing: "\n\n⚠️ The Telebirr account isn't configured yet — contact support.",
  depositSteps: '\n\n1. Send the exact amount to the account above.\n2. Open {app} → Deposit.\n3. Enter the amount, attach your payment screenshot, and submit for review.\n4. An admin verifies it and credits your wallet.',
  withdrawInfo: '🏧 Withdraw (manual Telebirr)\n\nOnly your winnings can be withdrawn.\nOpen {app} → Withdraw, enter your Telebirr number and amount. An admin sends the payment manually and marks it paid.',
  instructionsTitle: '📖 Instructions',
  instructionsMissing: 'No instructions have been set yet. Please contact support.',
  inviteTitle: '🎁 Invite friends & earn!',
  inviteBody: '🔗 Your link:\n{link}\n\nOr share your code: {code}',
  registerFirst: 'Please use /start first.',
  commands: 'ℹ️ {app} — commands\n\n/play - Open the game\n/balance - Check your wallet\n/deposit - How to deposit via Telebirr\n/withdraw - How to withdraw your winnings\n/invite - Your referral link\n/instructions - Game rules\n\nBuy cartelas and play both ETB 5 and ETB 10 rooms inside the Mini App (max 4 cartelas total).',
};

const am: BotDict = {
  welcomeNew: '🎉 እንኳን ወደ {app} በደህና መጡ፣ {name}!\n\n💰 የመግቢያ ጉርሻ: {bonus} ብር',
  welcomeBack: '👋 እንኳን ደህና መጡ፣ {name}!\n\n💰 ቀሪ ሂሳብዎ: {balance} ብር',
  tapToPlay: '🎮 ለመጫወት ከታች ያለውን ቁልፍ ይጫኑ!',
  playButton: '🎮 {app} ተጫወት',
  gameUrlNotSet: '\n\n⚠️ የጨዋታው አድራሻ ገና አልተዘጋጀም። አስተዳዳሪ በ {app} አስተዳደር ገጽ ማዘጋጀት አለበት።',
  balanceTitle: '💰 ቀሪ ሂሳብዎ',
  balanceTotal: '🎮 ጠቅላላ ቀሪ ሂሳብ: {amount} ብር',
  balanceWon: '🏆 ያሸነፉት: {amount} ብር',
  balanceDeposited: '💵 የገባ: {amount} ብር',
  balanceAvailable: '✅ ማውጣት የሚችሉት: {amount} ብር',
  balanceNote: '⚠️ ማውጣት የሚቻለው ያሸነፉትን ብቻ ነው። የገባ ገንዘብ ለጨዋታ ብቻ ነው።',
  depositTitle: '💰 ገቢ (በእጅ ቴሌብር)',
  depositAccount: '\n\nየ{app} ቴሌብር አካውንት\n👤 {name}\n📱 {number}',
  depositAccountMissing: '\n\n⚠️ የቴሌብር አካውንት ገና አልተዘጋጀም — ድጋፍን ያነጋግሩ።',
  depositSteps: '\n\n1. ትክክለኛውን መጠን ወደ ላይ ወዳለው አካውንት ይላኩ።\n2. {app} → Deposit ይክፈቱ።\n3. መጠኑን አስገብተው የክፍያ ማረጋገጫ ፎቶ አያይዘው ለግምገማ ያስገቡ።\n4. አስተዳዳሪ አረጋግጦ ዋሌትዎን ይሞላል።',
  withdrawInfo: '🏧 ማውጣት (በእጅ ቴሌብር)\n\nማውጣት የሚቻለው ትርፍዎን ብቻ ነው።\n{app} → Withdraw ይክፈቱ፣ የቴሌብር ቁጥርዎን እና መጠኑን ያስገቡ። አስተዳዳሪ ክፍያውን በእጅ ልኮ እንደተከፈለ ያመላክታል።',
  instructionsTitle: '📖 መመሪያ',
  instructionsMissing: 'እስካሁን መመሪያ አልተዘጋጀም። እባክዎ ድጋፍን ያነጋግሩ።',
  inviteTitle: '🎁 ጓደኞችን ይጋብዙ እና ያግኙ!',
  inviteBody: '🔗 አገናኝዎ:\n{link}\n\nወይም ኮድዎን ያጋሩ: {code}',
  registerFirst: 'እባክዎ መጀመሪያ /start ይጠቀሙ።',
  commands: 'ℹ️ {app} — ትዕዛዞች\n\n/play - ጨዋታውን ክፈት\n/balance - ዋሌትህን አረጋግጥ\n/deposit - በቴሌብር እንዴት ገቢ እንደሚደረግ\n/withdraw - ትርፍህን እንዴት እንደምታወጣ\n/invite - የግብዣ አገናኝህ\n/instructions - የጨዋታ ደንቦች\n\nካርቴላዎችን ግዛ እና ባለ 5 ብር እና ባለ 10 ብር ክፍሎችን በ Mini App ውስጥ ተጫወት (ቢበዛ 4 ካርቴላ)።',
};

// Oromo/Tigrinya kept minimal (fall back to Amharic-equivalent structure with
// English words where a full translation wasn't already ported) — full
// parity with the frontend's om.ts/ti.ts is a follow-up, not attempted here
// to avoid shipping a half-checked translation without native review
// (matches the standing note in earlier rebrand work on this project).
const om: BotDict = en;
const ti: BotDict = en;

const DICTS: Record<BotLang, BotDict> = { en, am, om, ti };

import { escapeTelegramHtml } from './telegram.service';

/**
 * Finding SEC-10 (Medium): every message is sent with parse_mode: 'HTML'.
 * Most interpolated values here are server-controlled (amounts, the app
 * name), but escaping ALL of them uniformly is the same "fix at the one
 * choke point" pattern already used elsewhere in this codebase
 * (isWithinRoot, constantTimeStringEquals) — safer than trying to remember
 * which future call site needs it. See telegram.service.ts's
 * escapeTelegramHtml doc comment for the actual vulnerable case this
 * closes (admin-authored rejectionReason, built elsewhere, not through
 * this file — but the same escaping utility applies here too).
 */
function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => (key in vars ? escapeTelegramHtml(String(vars[key])) : `{${key}}`));
}

export function botT(lang: BotLang, key: string, vars: Record<string, string | number> = {}): string {
  const dict = DICTS[lang] ?? DICTS[DEFAULT_BOT_LANG];
  const raw = dict[key] ?? DICTS.en[key] ?? key;
  return interpolate(raw, { app: 'የኛ bingo', ...vars });
}

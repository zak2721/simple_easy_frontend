/*
 * የኛ — Telegram bot i18n (Deno).
 *
 * The Mini App's canonical dictionary lives in src/i18n/*.ts. The bot needs only
 * this small subset; the `bot.*` strings here MUST match the `bot.*` keys in
 * src/i18n/{en,am,om}.ts (test: src/i18n/__tests__/i18n.test.ts checks the app
 * side; keep this file in sync by hand when a bot string changes).
 *
 * Fallback: requested lang -> am (default) -> en -> key. Placeholders: {name}.
 */
export type Lang = 'en' | 'am' | 'om' | 'ti';
export const DEFAULT_LANG: Lang = 'am';
export function normalizeLang(x: unknown): Lang {
  return x === 'en' || x === 'am' || x === 'om' || x === 'ti' ? x : DEFAULT_LANG;
}

type Dict = Record<string, string>;

const en: Dict = {
  'app': 'የኛ bingo',
  'welcomeNew': '🎉 Welcome to {app}, {name}!\n\n💰 Welcome bonus: {bonus} ETB',
  'welcomeBack': '👋 Welcome back, {name}!\n\n💰 Your balance: {balance} ETB',
  'referralBonus': '🎁 Referral bonus: {amount} ETB',
  'tapToPlay': '🎮 Tap the button below to start playing!',
  'readyToPlay': '🎮 Ready to play? Tap the button below!',
  'playButton': '🎮 Play {app}',
  'registered': '✅ You are now registered!\n\n💰 Welcome bonus: {bonus} ETB',
  'alreadyRegistered': 'You are already registered. Use /play to open the game.',
  'registerFirst': 'Please use /start first.',
  'goodLuck': '🍀 Best of luck! 🎮',
  'openWithPlay': 'Use /play to open {app}.',
  'registerError': 'Sorry, there was an error registering your account. Please try again.',
  'gameUrlNotSet': "\n\n⚠️ The game link isn't configured yet. An admin must set it in the የኛ admin panel (Settings → Game Web App URL).",
  'balanceTitle': '💰 Your Balance',
  'balanceTotal': '🎮 Total balance: {amount} ETB',
  'balanceWon': '🏆 Winnings: {amount} ETB',
  'balanceDeposited': '💵 Deposited: {amount} ETB',
  'balancePending': '⏳ Pending withdrawals: {amount} ETB',
  'balanceAvailable': '✅ Available to withdraw: {amount} ETB',
  'balanceNote': '⚠️ Only winnings can be withdrawn. Deposited money is for playing games.',
  'depositTitle': '💰 Deposit (manual Telebirr)',
  'depositAccount': '\n\nየኛ Telebirr account\n👤 {name}\n📱 {number}',
  'depositAccountMissing': "\n\n⚠️ The Telebirr account isn't configured yet — contact support.",
  'depositSteps': '\n\n1. Send the exact amount to the account above.\n2. Open የኛ bingo → Deposit.\n3. Enter the Telebirr transaction reference and upload your receipt.\n4. An admin verifies it and credits your wallet.',
  'withdrawInfo': '🏧 Withdraw (manual Telebirr)\n\nOnly your winnings can be withdrawn.\nOpen የኛ bingo → Withdraw, enter your Telebirr number and amount. An admin sends the payment manually and marks it paid.',
  'inviteTitle': '🎁 Invite friends & earn!',
  'inviteBody': '💰 Get {perReferral} ETB for every friend who joins with your link.\n\n🔗 Your link:\n{link}\n\n📊 Referrals: {count}   💵 Earned: {earned} ETB',
  'instructionsTitle': '📖 Instructions',
  'instructionsMissing': 'No instructions have been set yet. Please contact support.',
  'transfersDisabled': 'Player-to-player transfers are disabled on የኛ bingo.\n\nUse /deposit and /withdraw (manual Telebirr) to move money.',
  'commands': 'ℹ️ የኛ bingo — commands\n\n/play - Open the game\n/balance - Check your wallet\n/deposit - How to deposit via Telebirr\n/withdraw - How to withdraw your winnings\n/invite - Your referral link\n/instructions - Game rules\n\nBuy cartelas and play both ETB 5 and ETB 10 rooms inside the Mini App (max 4 cartelas total).',
  'notify.depositApproved': '✅ Your deposit of {amount} ETB was approved and added to your wallet.',
  'notify.depositRejected': '❌ Your deposit of {amount} ETB was rejected.\nReason: {reason}',
  'notify.withdrawalApproved': '⏳ Your withdrawal of {amount} ETB was approved. We are sending your Telebirr payment.',
  'notify.withdrawalPaid': '✅ Your withdrawal of {amount} ETB has been PAID via Telebirr.\nRef: {reference}',
  'notify.withdrawalRejected': '❌ Your withdrawal of {amount} ETB was rejected and the amount returned to your winnings.\nReason: {reason}',
  'notify.winner': '🏆 BINGO! You won {amount} ETB. Open የኛ bingo → Withdraw to cash out via Telebirr.',
};

const am: Dict = {
  'app': 'የኛ bingo',
  'welcomeNew': '🎉 እንኳን ወደ {app} በደህና መጡ፣ {name}!\n\n💰 የመግቢያ ጉርሻ: {bonus} ብር',
  'welcomeBack': '👋 እንኳን ደህና ተመለሱ፣ {name}!\n\n💰 ቀሪ ሂሳብዎ: {balance} ብር',
  'referralBonus': '🎁 የግብዣ ጉርሻ: {amount} ብር',
  'tapToPlay': '🎮 ለመጫወት ከታች ያለውን ቁልፍ ይጫኑ!',
  'readyToPlay': '🎮 ለመጫወት ዝግጁ ነዎት? ከታች ያለውን ቁልፍ ይጫኑ!',
  'playButton': '🎮 {app} ተጫወት',
  'registered': '✅ ተመዝግበዋል!\n\n💰 የመግቢያ ጉርሻ: {bonus} ብር',
  'alreadyRegistered': 'አስቀድመው ተመዝግበዋል። ጨዋታውን ለመክፈት /play ይጠቀሙ።',
  'registerFirst': 'እባክዎ መጀመሪያ /start ይጠቀሙ።',
  'goodLuck': '🍀 መልካም ዕድል! 🎮',
  'openWithPlay': '{app} ን ለመክፈት /play ይጠቀሙ።',
  'registerError': 'ይቅርታ፣ አካውንትዎን በማስመዝገብ ላይ ስህተት ተፈጥሯል። እባክዎ እንደገና ይሞክሩ።',
  'gameUrlNotSet': '\n\n⚠️ የጨዋታው አድራሻ ገና አልተዘጋጀም። አስተዳዳሪ በ የኛ አስተዳደር ገጽ (Settings → Game Web App URL) ማዘጋጀት አለበት።',
  'balanceTitle': '💰 ቀሪ ሂሳብዎ',
  'balanceTotal': '🎮 ጠቅላላ ቀሪ ሂሳብ: {amount} ብር',
  'balanceWon': '🏆 ትርፍ: {amount} ብር',
  'balanceDeposited': '💵 ያስገቡት: {amount} ብር',
  'balancePending': '⏳ በመጠበቅ ላይ ያሉ ወጪዎች: {amount} ብር',
  'balanceAvailable': '✅ ሊወጣ የሚችል: {amount} ብር',
  'balanceNote': '⚠️ ማውጣት የሚቻለው ትርፍን ብቻ ነው። ያስገቡት ገንዘብ ለጨዋታ ነው።',
  'depositTitle': '💰 ገቢ ማድረግ (በእጅ ቴሌብር)',
  'depositAccount': '\n\nየኛ ቴሌብር አካውንት\n👤 {name}\n📱 {number}',
  'depositAccountMissing': '\n\n⚠️ የቴሌብር አካውንት ገና አልተዘጋጀም — ድጋፍን ያነጋግሩ።',
  'depositSteps': '\n\n1. ትክክለኛውን መጠን ወደ ላይ ወዳለው አካውንት ይላኩ።\n2. የኛ bingo → Deposit ይክፈቱ።\n3. የቴሌብር የግብይት ማጣቀሻ ያስገቡ እና ደረሰኝ ያያይዙ።\n4. አስተዳዳሪ አረጋግጦ ዋሌትዎን ይሞላል።',
  'withdrawInfo': '🏧 ማውጣት (በእጅ ቴሌብር)\n\nማውጣት የሚቻለው ትርፍዎን ብቻ ነው።\nየኛ bingo → Withdraw ይክፈቱ፣ የቴሌብር ቁጥርዎን እና መጠኑን ያስገቡ። አስተዳዳሪ ክፍያውን በእጅ ልኮ እንደተከፈለ ያመላክታል።',
  'inviteTitle': '🎁 ጓደኞችን ጋብዙ እና ያግኙ!',
  'inviteBody': '💰 በእርስዎ አገናኝ ለሚቀላቀል ለያንዳንዱ ጓደኛ {perReferral} ብር ያግኙ።\n\n🔗 የእርስዎ አገናኝ:\n{link}\n\n📊 ግብዣዎች: {count}   💵 ያገኙት: {earned} ብር',
  'instructionsTitle': '📖 መመሪያዎች',
  'instructionsMissing': 'ገና መመሪያ አልተዘጋጀም። እባክዎ ድጋፍን ያነጋግሩ።',
  'transfersDisabled': 'በ የኛ bingo ከተጫዋች ወደ ተጫዋች ማስተላለፍ ተዘግቷል።\n\nገንዘብ ለማንቀሳቀስ /deposit እና /withdraw (በእጅ ቴሌብር) ይጠቀሙ።',
  'commands': 'ℹ️ የኛ bingo — ትዕዛዞች\n\n/play - ጨዋታ ክፈት\n/balance - ዋሌትህን አረጋግጥ\n/deposit - በቴሌብር እንዴት ገቢ እንደሚደረግ\n/withdraw - ትርፍህን እንዴት እንደምታወጣ\n/invite - የግብዣ አገናኝህ\n/instructions - የጨዋታ ደንቦች\n\nካርቴላ ግዛ እና ባለ 5 ብር እና ባለ 10 ብር ክፍሎችን በ Mini App ተጫወት (ቢበዛ 4 ካርቴላ)።',
  'notify.depositApproved': '✅ የ{amount} ብር ገቢዎ ጸድቆ ወደ ዋሌትዎ ተጨምሯል።',
  'notify.depositRejected': '❌ የ{amount} ብር ገቢዎ ውድቅ ሆኗል።\nምክንያት: {reason}',
  'notify.withdrawalApproved': '⏳ የ{amount} ብር ወጪዎ ጸድቋል። የቴሌብር ክፍያዎን በመላክ ላይ ነን።',
  'notify.withdrawalPaid': '✅ የ{amount} ብር ወጪዎ በቴሌብር ተከፍሏል።\nማጣቀሻ: {reference}',
  'notify.withdrawalRejected': '❌ የ{amount} ብር ወጪዎ ውድቅ ሆኖ መጠኑ ወደ ትርፍዎ ተመልሷል።\nምክንያት: {reason}',
  'notify.winner': '🏆 ቢንጎ! {amount} ብር አሸንፈዋል። በቴሌብር ለማውጣት የኛ bingo → Withdraw ይክፈቱ።',
};

const om: Dict = {
  'app': 'የኛ bingo',
  'welcomeNew': '🎉 Baga gara {app} dhufte, {name}!\n\n💰 Badhaasa seensaa: ETB {bonus}',
  'welcomeBack': '👋 Baga nagaan deebite, {name}!\n\n💰 Hafteessi kee: ETB {balance}',
  'referralBonus': '🎁 Badhaasa afeerraa: ETB {amount}',
  'tapToPlay': '🎮 Taphachuu jalqabuuf qabduu gadii tuqi!',
  'readyToPlay': '🎮 Taphachuuf qophii dha? Qabduu gadii tuqi!',
  'playButton': '🎮 {app} taphadhu',
  'registered': '✅ Galmoofteetta!\n\n💰 Badhaasa seensaa: ETB {bonus}',
  'alreadyRegistered': 'Duraan galmoofteetta. Tapha banuuf /play fayyadami.',
  'registerFirst': 'Maaloo dursii /start fayyadami.',
  'goodLuck': '🍀 Milkii! 🎮',
  'openWithPlay': '{app} banuuf /play fayyadami.',
  'registerError': 'Dhiifama, herrega kee galmeessuu keessatti dogoggorri uumame. Maaloo irra deebi\'ii yaali.',
  'gameUrlNotSet': '\n\n⚠️ Liinkiin taphaa hin qophoofne. Bulchaan fuula bulchiinsa የኛ (Settings → Game Web App URL) irratti qopheessuu qaba.',
  'balanceTitle': '💰 Hafteessa kee',
  'balanceTotal': '🎮 Hafteessa waliigalaa: ETB {amount}',
  'balanceWon': '🏆 Mo’icha: ETB {amount}',
  'balanceDeposited': '💵 Kan galfame: ETB {amount}',
  'balancePending': '⏳ Baasii eegaa jiran: ETB {amount}',
  'balanceAvailable': '✅ Baasuun danda’amu: ETB {amount}',
  'balanceNote': '⚠️ Kan baasuu danda’amu mo’icha qofa. Maallaqni galfame taphaaf.',
  'depositTitle': '💰 Galii galchuu (Telebirr harkaan)',
  'depositAccount': '\n\nAkkaawuntii Telebirr የኛ\n👤 {name}\n📱 {number}',
  'depositAccountMissing': '\n\n⚠️ Akkaawuntiin Telebirr hin qophoofne — deeggarsa quunnami.',
  'depositSteps': '\n\n1. Hanga sirrii gara akkaawuntii olii ergi.\n2. የኛ bingo → Deposit bani.\n3. Wabii gochaa Telebirr galchiitii nagahee maxxansi.\n4. Bulchaan mirkaneessee boorsaa kee guuta.',
  'withdrawInfo': '🏧 Baasuu (Telebirr harkaan)\n\nKan baasuu dandeessu mo’icha kee qofa.\nየኛ bingo → Withdraw bani, lakkoofsa Telebirr fi hanga galchi. Bulchaan kaffaltii harkaan ergee akka kaffalame agarsiisa.',
  'inviteTitle': '🎁 Hiriyoota afeeri, argadhu!',
  'inviteBody': '💰 Hiriyaa liinkii keetiin galu tokkoof ETB {perReferral} argadhu.\n\n🔗 Liinkii kee:\n{link}\n\n📊 Afeerraa: {count}   💵 Argatte: ETB {earned}',
  'instructionsTitle': '📖 Qajeelfama',
  'instructionsMissing': 'Ammatti qajeelfamni hin qophoofne. Maaloo deeggarsa quunnami.',
  'transfersDisabled': 'የኛ bingo irratti dabarsi taphataa gara taphataatti cufameera.\n\nMaallaqa socho’suuf /deposit fi /withdraw (Telebirr harkaan) fayyadami.',
  'commands': 'ℹ️ የኛ bingo — ajajawwan\n\n/play - Tapha bani\n/balance - Boorsaa kee ilaali\n/deposit - Telebirriin akkamitti galii galchan\n/withdraw - Mo’icha kee akkamitti baasan\n/invite - Liinkii afeerraa kee\n/instructions - Seerota taphaa\n\nKaartelaa bitadhuutii kutaa ETB 5 fi ETB 10 Mini App keessatti taphadhu (yoo baay’ate kaartelaa 4).',
  'notify.depositApproved': '✅ Galiin kee ETB {amount} mirkanaa’ee boorsaa keetti dabalame.',
  'notify.depositRejected': '❌ Galiin kee ETB {amount} kufe.\nSababa: {reason}',
  'notify.withdrawalApproved': '⏳ Baasiin kee ETB {amount} mirkanaa’e. Kaffaltii Telebirr kee ergaa jirra.',
  'notify.withdrawalPaid': '✅ Baasiin kee ETB {amount} Telebirriin kaffalame.\nWabii: {reference}',
  'notify.withdrawalRejected': '❌ Baasiin kee ETB {amount} kufee hangi gara mo’icha keetti deebi’e.\nSababa: {reason}',
  'notify.winner': '🏆 Bingoo! ETB {amount} mo’atte. Telebirriin baasuuf የኛ bingo → Withdraw bani.',
};

const ti: Dict = {
  'app': 'የኛ bingo',
  'welcomeNew': '🎉 እንቋዕ ናብ {app} ብደሓን መጻእካ፣ {name}!\n\n💰 ናይ መእተዊ ጉርሻ: {bonus} ብር',
  'welcomeBack': '👋 እንቋዕ ብደሓን ተመለስካ፣ {name}!\n\n💰 ዝተረፈ ገንዘብካ: {balance} ብር',
  'referralBonus': '🎁 ናይ ዕድመ ጉርሻ: {amount} ብር',
  'tapToPlay': '🎮 ንምጽዋት ነቲ ኣብ ታሕቲ ዘሎ መልጎም ጠውቕ!',
  'readyToPlay': '🎮 ንምጽዋት ድሉው ዲኻ? ነቲ ኣብ ታሕቲ ዘሎ መልጎም ጠውቕ!',
  'playButton': '🎮 {app} ተጻወት',
  'registered': '✅ ተመዝጊብካ ኣለኻ!\n\n💰 ናይ መእተዊ ጉርሻ: {bonus} ብር',
  'alreadyRegistered': 'ድሮ ተመዝጊብካ ኣለኻ። ነቲ ጸወታ ንምኽፋት /play ተጠቐም።',
  'registerFirst': 'በጃኻ ቅድም /start ተጠቐም።',
  'goodLuck': '🍀 ሰናይ ዕድል! 🎮',
  'openWithPlay': '{app} ንምኽፋት /play ተጠቐም።',
  'registerError': 'ይቕሬታ፣ ኣካውንትካ ኣብ ምምዝጋብ ጌጋ ተፈጢሩ። በጃኻ እንደገና ፈትን።',
  'gameUrlNotSet': '\n\n⚠️ ናይቲ ጸወታ መላግቦ ክሳብ ሕጂ ኣይተዳለወን። ኣማሓዳሪ ኣብ ናይ የኛ ናይ ምሕደራ ገጽ (Settings → Game Web App URL) ከዳልዎ ኣለዎ።',
  'balanceTitle': '💰 ዝተረፈ ገንዘብካ',
  'balanceTotal': '🎮 ጠቕላላ ዝተረፈ ገንዘብ: {amount} ብር',
  'balanceWon': '🏆 ዓወት: {amount} ብር',
  'balanceDeposited': '💵 ዘእተኻዮ: {amount} ብር',
  'balancePending': '⏳ ኣብ ምጽባይ ዘለዉ መውጽኢታት: {amount} ብር',
  'balanceAvailable': '✅ ክውጻእ ዝኽእል: {amount} ብር',
  'balanceNote': '⚠️ ክውጻእ ዝኽእል ዓወት ጥራይ እዩ። ዘእተኻዮ ገንዘብ ንጸወታ እዩ።',
  'depositTitle': '💰 ገንዘብ ምእታው (ብኢድ ቴሌብር)',
  'depositAccount': '\n\nናይ የኛ ቴሌብር ኣካውንት\n👤 {name}\n📱 {number}',
  'depositAccountMissing': '\n\n⚠️ ናይ ቴሌብር ኣካውንት ክሳብ ሕጂ ኣይተዳለወን — ንደገፍ ኣዘራርብ።',
  'depositSteps': '\n\n1. ነቲ ልክዕ መጠን ናብቲ ኣብ ላዕሊ ዘሎ ኣካውንት ስደድ።\n2. የኛ bingo → Deposit ክፈት።\n3. ማጣቀሻ ልውውጥ ቴሌብር ኣእቱ ደረሰኝ እውን ኣተሓሒዝካ ስደድ።\n4. ኣማሓዳሪ ኣረጋጊጹ ቦርሳኻ ይመልኦ።',
  'withdrawInfo': '🏧 ገንዘብ ምውጻእ (ብኢድ ቴሌብር)\n\nክውጻእ ዝኽእል ዝተዓወትካዮ ጥራይ እዩ።\nየኛ bingo → Withdraw ክፈት፣ ቁጽሪ ቴሌብርካን መጠንን ኣእቱ። ኣማሓዳሪ ነቲ ክፍሊት ብኢድ ልኢኹ ከም ዝተኸፍለ የመልክት።',
  'inviteTitle': '🎁 ኣዕሩኽ ዓድም እሞ ረብሕ!',
  'inviteBody': '💰 ብመላግቦኻ ንዝጽንበር ነፍሲ ወከፍ ዓርኪ {perReferral} ብር ትረክብ።\n\n🔗 መላግቦኻ:\n{link}\n\n📊 ዕድመታት: {count}   💵 ዝረኸብካዮ: {earned} ብር',
  'instructionsTitle': '📖 መምርሒታት',
  'instructionsMissing': 'ክሳብ ሕጂ መምርሒ ኣይተዳለወን። በጃኻ ንደገፍ ኣዘራርብ።',
  'transfersDisabled': 'ኣብ የኛ bingo ካብ ተጻዋታይ ናብ ተጻዋታይ ምትሕልላፍ ተዓጽዩ።\n\nገንዘብ ንምንቅስቓስ /deposit ን /withdraw ን (ብኢድ ቴሌብር) ተጠቐም።',
  'commands': 'ℹ️ የኛ bingo — ትእዛዛት\n\n/play - ጸወታ ክፈት\n/balance - ቦርሳኻ ኣረጋግጽ\n/deposit - ብቴሌብር ብኸመይ ገንዘብ ከም እተእቱ\n/withdraw - ዓወትካ ብኸመይ ከም እተውጽእ\n/invite - መላግቦ ዕድመኻ\n/instructions - ሕግታት ጸወታ\n\nካርድታት ግዛእ እሞ ናይ 5 ብርን ናይ 10 ብርን ክፍልታት ኣብ ውሽጢ Mini App ተጻወት (ብዝበዝሐ 4 ካርድ)።',
  'notify.depositApproved': '✅ ናይ {amount} ብር መእተዊኻ ጸዲቑ ናብ ቦርሳኻ ተወሲኹ።',
  'notify.depositRejected': '❌ ናይ {amount} ብር መእተዊኻ ተነጺጉ።\nምኽንያት: {reason}',
  'notify.withdrawalApproved': '⏳ ናይ {amount} ብር መውጽኢኻ ጸዲቑ። ናይ ቴሌብር ክፍሊትካ ንሰድድ ኣለና።',
  'notify.withdrawalPaid': '✅ ናይ {amount} ብር መውጽኢኻ ብቴሌብር ተኸፊሉ።\nማጣቀሻ: {reference}',
  'notify.withdrawalRejected': '❌ ናይ {amount} ብር መውጽኢኻ ተነጺጉ እቲ መጠን ናብ ዓወትካ ተመሊሱ።\nምኽንያት: {reason}',
  'notify.winner': '🏆 ቢንጎ! {amount} ብር ተዓዊትካ። ብቴሌብር ንምውጻእ የኛ bingo → Withdraw ክፈት።',
};

/* Telegram command-menu descriptions (setMyCommands), per language. */
const CMD_DESCRIPTIONS: Record<Lang, Record<string, string>> = {
  en: {
    play: 'Play የኛ bingo',
    balance: 'Check your wallet',
    deposit: 'How to deposit via Telebirr',
    withdraw: 'How to withdraw your winnings',
    invite: 'Get your referral link',
    instructions: 'Game rules',
  },
  am: {
    play: 'የኛ bingo ተጫወት',
    balance: 'ዋሌትዎን ያረጋግጡ',
    deposit: 'በቴሌብር እንዴት ገቢ እንደሚያደርጉ',
    withdraw: 'ትርፍዎን እንዴት እንደሚያወጡ',
    invite: 'የግብዣ አገናኝዎን ያግኙ',
    instructions: 'የጨዋታ ደንቦች',
  },
  om: {
    play: 'የኛ bingo taphadhu',
    balance: 'Boorsaa kee ilaali',
    deposit: 'Telebirriin akkamitti galii galchan',
    withdraw: "Mo'icha kee akkamitti baasan",
    invite: 'Liinkii afeerraa kee argadhu',
    instructions: 'Seerota taphaa',
  },
  ti: {
    play: 'የኛ bingo ተጻወት',
    balance: 'ቦርሳኻ ኣረጋግጽ',
    deposit: 'ብቴሌብር ብኸመይ ገንዘብ ከም እተእቱ',
    withdraw: 'ዓወትካ ብኸመይ ከም እተውጽእ',
    invite: 'መላግቦ ዕድመኻ ርኸብ',
    instructions: 'ሕግታት ጸወታ',
  },
};

/** Command list for Telegram setMyCommands in the given language. */
export function botCommands(lang: Lang | string | null | undefined): Array<{ command: string; description: string }> {
  const l = normalizeLang(lang);
  return Object.entries(CMD_DESCRIPTIONS[l]).map(([command, description]) => ({ command, description }));
}

export const BOT_COMMAND_LANGS: Lang[] = ['en', 'am', 'om', 'ti'];

const DICTS: Record<Lang, Dict> = { en, am, om, ti };

export function botT(lang: Lang | string | null | undefined, key: string, vars?: Record<string, string | number>): string {
  const l = normalizeLang(lang);
  const raw = DICTS[l][key] ?? DICTS[DEFAULT_LANG][key] ?? DICTS.en[key] ?? key;
  const withApp = raw.replace(/\{app\}/g, DICTS[l].app);
  if (!vars) return withApp;
  return withApp.replace(/\{(\w+)\}/g, (_m, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

/** Look up a player's saved language. Defaults to 'am'. */
// deno-lint-ignore no-explicit-any
export async function playerLang(supabase: any, telegramUserId: number | string | null | undefined): Promise<Lang> {
  try {
    if (!telegramUserId) return DEFAULT_LANG;
    const { data } = await supabase
      .from('telegram_users').select('language_code').eq('telegram_user_id', telegramUserId).maybeSingle();
    return normalizeLang(data?.language_code);
  } catch {
    return DEFAULT_LANG;
  }
}

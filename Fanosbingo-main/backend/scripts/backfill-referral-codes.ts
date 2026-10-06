/**
 * One-time backfill: assigns a short referral_code to every TelegramUser row
 * that predates the column (see prisma/migrations/20260920113000_add_referral_code_column).
 * Idempotent — only ever touches rows still NULL, safe to re-run.
 *
 * Run with: npx tsx scripts/backfill-referral-codes.ts
 *
 * After this reports 0 remaining NULLs, apply the follow-up migration that
 * tightens the column to NOT NULL.
 */
import { PrismaClient } from '@prisma/client';
import { generateReferralCode } from '../src/referrals/referral-code.util';

const prisma = new PrismaClient();

const MAX_ATTEMPTS = 10;

async function assignCode(userId: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = generateReferralCode();
    try {
      await prisma.telegramUser.update({ where: { id: userId }, data: { referralCode: candidate } });
      return candidate;
    } catch (e: unknown) {
      const isUniqueViolation = e instanceof Object && 'code' in e && (e as { code: string }).code === 'P2002';
      if (!isUniqueViolation) throw e;
      // Collision — retry with a fresh candidate.
    }
  }
  throw new Error(`Could not generate a unique referral code for user ${userId} after ${MAX_ATTEMPTS} attempts`);
}

async function main() {
  const users = await prisma.telegramUser.findMany({ where: { referralCode: null }, select: { id: true, telegramUserId: true } });
  console.log(`Backfilling referral codes for ${users.length} user(s)...`);

  for (const user of users) {
    const code = await assignCode(user.id);
    console.log(`  telegram_user_id=${user.telegramUserId} -> referral_code=${code}`);
  }

  const remaining = await prisma.telegramUser.count({ where: { referralCode: null } });
  console.log(`Done. ${remaining} row(s) still NULL.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

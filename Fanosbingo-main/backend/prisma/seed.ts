import { PrismaClient } from '@prisma/client';
import { PERMISSIONS, PERMISSION_SCOPES } from '../src/common/rbac.constants';

const LEGACY_PLAN_ID = '00000000-0000-0000-0000-000000000010';
const STARTER_PLAN_ID = '00000000-0000-0000-0000-000000000011';
const PROFESSIONAL_PLAN_ID = '00000000-0000-0000-0000-000000000012';
const ENTERPRISE_PLAN_ID = '00000000-0000-0000-0000-000000000013';

const prisma = new PrismaClient();

async function main() {
  // Permission catalog. SUPER_ADMIN needs no rows here — it holds '*'
  // implicitly in code (see JwtAdminStrategy). Every ADMIN account's
  // capabilities come from its own direct AdminPermission grants, assigned
  // by the Super Admin via /admin-management — there is no role-preset
  // bundle to seed.
  // `scope` is always overwritten from code: rbac.constants.ts is the source of
  // truth for which permissions operator accounts may hold.
  for (const key of PERMISSIONS) {
    const scope = PERMISSION_SCOPES[key];
    await prisma.permission.upsert({ where: { key }, create: { key, scope }, update: { scope } });
  }

  // Prune stale keys from earlier permission-naming schemes (e.g. the
  // previous dot-case "deposits.approve" style) so the catalog an admin sees
  // in the UI never shows dead entries alongside the current canonical list.
  await prisma.permission.deleteMany({ where: { key: { notIn: [...PERMISSIONS] } } });

  // Default runtime settings — same keys/defaults as the previous `settings` table.
  const defaults: Record<string, string> = {
    YENA_BINGO_NAME: 'የኛ bingo',
    ETB5_ROOM_PRICE: '5',
    ETB5_ROOM_CAPACITY: '400',
    ETB10_ROOM_PRICE: '10',
    ETB10_ROOM_CAPACITY: '200',
    MAX_STANDARD_CARTELAS: '600',
    MAX_CARTELAS_PER_PLAYER: '4',
    WINNER_PERCENTAGE: '80',
    HOUSE_PERCENTAGE: '20',
    RESERVATION_EXPIRY_MINUTES: '10',
    PURCHASE_WINDOW_SECONDS: '60',
    DEPOSIT_MIN_ETB: '30',
    WITHDRAWAL_MIN_ETB: '200',
    SIGNUP_BONUS_ETB: '30',
    SIGNUP_BONUS_WAGERING_MULTIPLIER: '1',
    BONUS_EXPIRY_DAYS: '0',
    TELEBIRR_ACCOUNT_NAME: '',
    TELEBIRR_ACCOUNT_NUMBER: '',
    TELEBIRR_INSTRUCTIONS: '',
    GAME_URL: '',
    WELCOME_BONUS_ENABLED: 'true',
    CONTACT_TELEGRAM: '',
    CONTACT_PHONE: '',
    CONTACT_WHATSAPP: '',
    CONTACT_EMAIL: '',
    CONTACT_SUPPORT_HOURS: '',
    REFERRAL_ENABLED: 'true',
    REFERRAL_BONUS_REFERRER_ETB: '10',
    REFERRAL_BONUS_NEW_USER_ETB: '5',
    REFERRAL_MAX_PER_USER: '20',
  };
  for (const [id, value] of Object.entries(defaults)) {
    await prisma.setting.upsert({ where: { id }, create: { id, value }, update: {} });
  }

  // Default theme — colors copied verbatim from src/index.css's current
  // :root block, so every existing user (selectedThemeId is null on all of
  // them) sees zero visual change the moment this ships. isDefault:true +
  // isActive:true makes it the fallback ThemeService.getEffectiveTheme
  // resolves to for anyone without a personal selection.
  await prisma.theme.upsert({
    where: { slug: 'classic-bingo' },
    create: {
      name: 'Classic Bingo',
      slug: 'classic-bingo',
      primaryColor: '#12a150',
      secondaryColor: '#0b7d3e',
      backgroundColor: '#0b1220',
      textColor: '#e8edf6',
      surfaceColor: '#131c2e',
      surfaceAltColor: '#1b2740',
      mutedTextColor: '#93a1b8',
      accentColor: '#ffd166',
      buttonBackgroundColor: '#0b7d3e',
      buttonTextColor: '#ffffff',
      isActive: true,
      isDefault: true,
    },
    update: {},
  });

  // Subscription plans — same four rows as the migration seed, upserted so
  // re-running the seed is always safe (matches the migration's INSERT exactly).
  const plans = [
    {
      id: LEGACY_PLAN_ID,
      key: 'legacy',
      name: 'Legacy (Unlimited)',
      monthlyPriceMinor: null,
      currency: 'ETB',
      limits: { MAX_ROOMS: 100, MAX_TOTAL_CARTELAS: 100000, MAX_STAFF: 100, MAX_GAMES_PER_DAY: 9999, MAX_ACTIVE_PLAYERS: 99999 },
      features: ['REFERRALS', 'CUSTOM_DOMAIN', 'ADVANCED_REPORTS'],
      isActive: true,
    },
    {
      id: STARTER_PLAN_ID,
      key: 'starter',
      name: 'Starter',
      monthlyPriceMinor: 4900,
      currency: 'ETB',
      limits: { MAX_ROOMS: 2, MAX_TOTAL_CARTELAS: 1000, MAX_STAFF: 3, MAX_GAMES_PER_DAY: 50, MAX_ACTIVE_PLAYERS: 500 },
      features: [],
      isActive: true,
    },
    {
      id: PROFESSIONAL_PLAN_ID,
      key: 'professional',
      name: 'Professional',
      monthlyPriceMinor: 14900,
      currency: 'ETB',
      limits: { MAX_ROOMS: 5, MAX_TOTAL_CARTELAS: 5000, MAX_STAFF: 10, MAX_GAMES_PER_DAY: 200, MAX_ACTIVE_PLAYERS: 5000 },
      features: ['REFERRALS', 'ADVANCED_REPORTS'],
      isActive: true,
    },
    {
      id: ENTERPRISE_PLAN_ID,
      key: 'enterprise',
      name: 'Enterprise',
      monthlyPriceMinor: 49900,
      currency: 'ETB',
      limits: { MAX_ROOMS: 20, MAX_TOTAL_CARTELAS: 50000, MAX_STAFF: 50, MAX_GAMES_PER_DAY: 2000, MAX_ACTIVE_PLAYERS: 50000 },
      features: ['REFERRALS', 'CUSTOM_DOMAIN', 'ADVANCED_REPORTS'],
      isActive: true,
    },
  ];

  for (const plan of plans) {
    await prisma.subscriptionPlan.upsert({
      where: { key: plan.key },
      create: plan,
      update: { name: plan.name, limits: plan.limits, features: plan.features, isActive: plan.isActive },
    });
  }

  // Backfill: any operator not yet assigned to a plan gets the legacy plan.
  await prisma.operator.updateMany({
    where: { subscriptionPlanId: null },
    data: { subscriptionPlanId: LEGACY_PLAN_ID, subscriptionStatus: 'active' },
  });

  console.log('Seed complete: permission catalog, default settings, default theme, subscription plans.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

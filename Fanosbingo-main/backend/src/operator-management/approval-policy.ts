import { BadRequestException } from '@nestjs/common';
import { validatePatternList } from '../cards/bingo-card-generator';

/**
 * Changes the spec puts behind Super Admin approval when an OPERATOR account
 * makes them. Platform admins apply the same changes directly.
 */
export const APPROVAL_TYPES = {
  BRANDING_NAME: 'Bingo name change',
  BRANDING_LOGO: 'Logo change',
  BRANDING_THEME: 'Theme change',
  ROOM_CREATE: 'New room (adds cartelas)',
  ROOM_CAPACITY_INCREASE: 'Cartela quantity increase',
  SETTING_CHANGE: 'Rule change',
  // Phase 8c — legal/sensitive content pages route through approval; informational ones are direct
  CONTENT_PAGE_TERMS: 'Terms & Conditions update',
  CONTENT_PAGE_RESPONSIBLE_GAMING: 'Responsible Gaming page update',
  CONTENT_PAGE_ABOUT: 'About page update',
  CONTENT_PAGE_GAME_INSTRUCTIONS: 'Game Instructions update',
} as const;

export type ApprovalType = keyof typeof APPROVAL_TYPES;

/** Settings changed via SETTING_CHANGE, grouped the way the spec names them. */
export const RULE_SETTING_CATEGORIES: Record<string, 'withdrawal' | 'bonus' | 'referral' | 'game'> = {
  WINNING_PATTERNS: 'game',
  WITHDRAWAL_MIN_ETB: 'withdrawal',
  WELCOME_BONUS_ENABLED: 'bonus',
  SIGNUP_BONUS_ETB: 'bonus',
  SIGNUP_BONUS_WAGERING_MULTIPLIER: 'bonus',
  BONUS_EXPIRY_DAYS: 'bonus',
  REFERRAL_ENABLED: 'referral',
  REFERRAL_BONUS_REFERRER_ETB: 'referral',
  REFERRAL_BONUS_NEW_USER_ETB: 'referral',
  REFERRAL_MAX_PER_USER: 'referral',
};

const BOOLEAN_SETTINGS = new Set(['WELCOME_BONUS_ENABLED', 'REFERRAL_ENABLED']);

/** Legacy keys an operator account may not route through SETTING_CHANGE — they have dedicated flows. */
export const REROUTED_SETTINGS: Record<string, string> = {
  YENA_BINGO_NAME: 'Change the bingo name from Branding (it goes to approval there).',
  ETB5_ROOM_CAPACITY: 'Change cartela quantities from Rooms (increases go to approval there).',
  ETB10_ROOM_CAPACITY: 'Change cartela quantities from Rooms (increases go to approval there).',
  MAX_STANDARD_CARTELAS: 'The total is the sum of your rooms — change it from Rooms.',
};

export function validateRuleSetting(key: string, value: string): string {
  if (!(key in RULE_SETTING_CATEGORIES)) throw new BadRequestException(`${key} is not an approval-controlled rule setting`);
  const v = value.trim();
  if (key === 'WINNING_PATTERNS') {
    try {
      return validatePatternList(v.split(',')).join(',');
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }
  if (BOOLEAN_SETTINGS.has(key)) {
    if (v !== 'true' && v !== 'false') throw new BadRequestException(`${key} must be "true" or "false"`);
    return v;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new BadRequestException(`${key} must be a number between 0 and 1,000,000`);
  return String(n);
}

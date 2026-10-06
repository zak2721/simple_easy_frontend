/**
 * የኛ bingo — central brand + product constants.
 *
 * Keep every user-facing product name here so a future rename touches one file.
 * Business numbers (prices, capacities, limits, prize split) are the FRONTEND
 * MIRROR of the authoritative backend config in the `settings` table and the
 * `yena_bingo_config()` SQL function. The backend is always the source of truth;
 * these values exist only for rendering before the backend responds.
 */

export const BRAND = {
  /** Short product mark. */
  name: 'የኛ',
  /** Full product name. */
  fullName: 'የኛ bingo',
  /** One-line tagline for welcome / login screens. */
  tagline: 'Live 75-ball Bingo on Telegram',
  /** Currency shown throughout the app. */
  currency: 'ETB',
  /** Support handle / contact (overridden by settings.support_contact at runtime). */
  supportFallback: 'Contact the የኛ bingo team via the bot.',
  /**
   * Asset paths (see public/). PLACEHOLDER svg files ship in the repo;
   * drop the official የኛ artwork in at these exact names.
   * See docs/YENA_BINGO_LOGO_PLACEMENT.md.
   */
  assets: {
    logo: '/logo.svg',
    logoMark: '/logo-mark.svg',
    favicon: '/favicon.svg',
    icon192: '/icon-192.png',
    icon512: '/icon-512.png',
  },
} as const;

/**
 * Room + cartela model. MIRRORS backend `settings`:
 *   ETB5_ROOM_PRICE, ETB5_ROOM_CAPACITY, ETB10_ROOM_PRICE, ETB10_ROOM_CAPACITY,
 *   MAX_STANDARD_CARTELAS, MAX_CARTELAS_PER_PLAYER, WINNER_PERCENTAGE, HOUSE_PERCENTAGE
 */
export const ROOMS = {
  etb5: {
    key: 'etb5' as const,
    label: 'ETB 5 BINGO',
    price: 5,
    capacity: 400,
  },
  etb10: {
    key: 'etb10' as const,
    label: 'ETB 10 BINGO',
    price: 10,
    capacity: 200,
  },
};

export type RoomKey = keyof typeof ROOMS;

/**
 * Generic fallback used by dynamic-room screens before the backend's real
 * `room_list` has loaded. Operators can define any number of rooms with any
 * codes; this only covers the pre-load flash for the default operator.
 */
export const FALLBACK_ROOMS: Array<{ id: string; code: string; name: string; price: number; capacity: number; max_per_player: number | null; taken: number[]; unavailable: number[] }> = [
  { id: 'etb5', code: 'etb5', name: ROOMS.etb5.label, price: ROOMS.etb5.price, capacity: ROOMS.etb5.capacity, max_per_player: 4, taken: [], unavailable: [] },
  { id: 'etb10', code: 'etb10', name: ROOMS.etb10.label, price: ROOMS.etb10.price, capacity: ROOMS.etb10.capacity, max_per_player: 4, taken: [], unavailable: [] },
];

export const CARTELA = {
  /** Standard complete setup = 400 (ETB 5) + 200 (ETB 10). */
  standardTotal: 600,
  /** HARD limit — total cartelas a player may own across BOTH rooms in one game/session. */
  maxPerPlayer: 4,
};

export const PRIZE = {
  winnerPercentage: 80,
  housePercentage: 20,
};

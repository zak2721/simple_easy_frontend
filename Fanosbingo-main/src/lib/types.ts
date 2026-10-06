// Shared frontend types — backend-agnostic, ported unchanged from the
// previous src/lib/supabase.ts (only the Supabase client itself was removed;
// see api-client.ts for its replacement).

// Room codes are operator-defined (e.g. "etb5", "vip100") — any non-empty string.
export type RoomKey = string;

export interface RoomInfo {
  // Present on GET /games/lobby's room_list; absent on the login response's config.rooms.
  id?: string;
  code: RoomKey;
  name: string;
  price: number;
  capacity: number;
  max_per_player: number | null;
}

export interface Game {
  id: string;
  status: 'waiting' | 'playing' | 'finished';
  game_number: number;
  current_number: number | null;
  called_numbers: number[];
  winner_ids: string[] | null;
  winner_prize: number;
  winner_prize_each: number;
  winner_prize_amount?: number | null;
  house_share_amount?: number | null;
  winner_payouts?: Record<string, number> | null;
  total_pot: number;
  starts_at: string;
  selection_closed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  return_to_lobby_at: string | null;
  claim_window_start: string | null;
}

export interface Cartela {
  player_id: string;
  room: RoomKey;
  number: number;
  card?: number[][];
  card_numbers?: number[][];
  is_disqualified?: boolean;
}

export interface Player {
  id: string;
  game_id: string;
  name: string;
  card_numbers: number[][];
  marked_cells: boolean[][];
  selected_number: number;
  room_type: RoomKey;
  room_name?: string;
  entry_price: number;
  telegram_user_id: number;
  is_disqualified: boolean;
  stake_paid: boolean;
  joined_at: string;
  winning_pattern?: { type: string; description: string; cells: [number, number][] } | null;
}

export interface Wallet {
  deposited_balance: number;
  won_balance: number;
  total_balance: number;
  on_hold: number;
  withdrawable: number;
}

export interface YenaBingoConfig {
  name: string;
  currency: string;
  etb5_price: number;
  etb5_capacity: number;
  etb10_price: number;
  etb10_capacity: number;
  rooms: RoomInfo[];
  standard_total_cartelas: number;
  max_cartelas_per_player: number;
  winner_percentage: number;
  house_percentage: number;
  bot_username: string;
}

export interface ContactInfo {
  telegram: string;
  phone: string;
  whatsapp: string;
  email: string;
  support_hours: string;
  configured: boolean;
}

export interface EffectiveTheme {
  id: string | null;
  name: string;
  primaryColor: string;
  secondaryColor: string;
  backgroundColor: string;
  textColor: string;
  surfaceColor: string;
  surfaceAltColor: string;
  mutedTextColor: string;
  accentColor: string;
  buttonBackgroundColor: string | null;
  buttonTextColor: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
}

export interface Theme extends EffectiveTheme {
  id: string;
  slug: string;
  isActive: boolean;
  isDefault: boolean;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
}

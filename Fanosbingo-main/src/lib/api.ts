// Player-facing API surface — replaces the previous Supabase edge-function
// wrapper + direct `supabase.rpc(...)` calls with plain REST against the
// NestJS backend (see api-client.ts).
import { playerApi } from './api-client';
import { currentOperatorSlug } from './operator';
import type { RoomInfo, RoomKey, Theme } from './types';

export const api = {
  /** Lobby snapshot: active game, all of the operator's rooms, my cartelas, wallet. */
  async lobby() {
    const { data } = await playerApi.get('/games/lobby');
    return data as {
      server_time_ms: number;
      config: unknown;
      game: null | Record<string, unknown>;
      next_game: null | { id: string; starts_at: string; sales_open_at: string | null; winning_patterns: string[] | null };
      rooms: Record<RoomKey, { price: number; capacity: number; taken: number[]; unavailable?: number[] }>;
      room_list: Array<RoomInfo & { taken: number[]; unavailable: number[] }>;
      my_cartelas: Array<{ player_id: string; room: RoomKey; number: number; card: number[][]; is_disqualified: boolean }>;
      my_counts: Record<RoomKey, number> & { total: number };
      wallet: null | Record<string, number>;
    };
  },

  /** Fetches one specific game by id + the caller's own cartelas in it — replaces the previous direct `supabase.from('games')/'players'` reads in GameRoom.tsx. */
  async getGame(gameId: string) {
    const { data } = await playerApi.get(`/games/${gameId}`);
    return data as { game: Record<string, unknown> | null; my_cartelas: Record<string, unknown>[] };
  },

  async ensureWaitingGame() {
    // The backend lazily creates the next waiting game inside GET /games/lobby
    // itself (see GamesService.ensureWaitingGame), so this is a no-op kept
    // only so BingoScreen.tsx's existing call site doesn't need restructuring.
    await playerApi.get('/games/active');
  },

  selectCartela(p: { gameId: string; room: RoomKey; cartelaNumber: number }) {
    return playerApi
      .post('/cards/purchase', { gameId: p.gameId, room: p.room, cartelaNumber: p.cartelaNumber })
      .then((r) => r.data as { playerId: string; room: RoomKey; cartelaNumber: number; price: number; card: number[][]; cartelas: { total: number }; max: number });
  },

  releaseCartela(playerId: string) {
    return playerApi.post('/cards/release', { playerId }).then((r) => r.data as { cartelas: { total: number } });
  },

  claimBingo(playerId: string) {
    return playerApi.post('/bingo/claim', { playerId }).then((r) => r.data);
  },

  myFinance() {
    return playerApi.get('/users/me/finance').then(
      (r) =>
        r.data as {
          wallet: Record<string, number>;
          deposits: Array<Record<string, unknown>>;
          withdrawals: Array<Record<string, unknown>>;
          ledger: Array<Record<string, unknown>>;
          telebirr: { account_name: string; account_number: string; instructions: string; min_etb: number; max_etb: number; configured: boolean };
        },
    );
  },

  submitDeposit(p: { amount: number; receiptBase64: string; telebirrReference: string; notes?: string }) {
    return playerApi.post('/deposits', p).then((r) => r.data);
  },

  requestWithdrawal(p: { amount: number; telebirrAccount: string; notes?: string }) {
    return playerApi.post('/withdrawals', p).then((r) => r.data);
  },

  cancelRequest(kind: 'deposit' | 'withdrawal', id: string) {
    const path = kind === 'deposit' ? `/deposits/${id}/cancel` : `/withdrawals/${id}/cancel`;
    return playerApi.post(path).then((r) => r.data);
  },

  setLanguage(languageCode: string) {
    return playerApi.post('/users/language', { languageCode }).then((r) => r.data);
  },

  leaderboard() {
    return playerApi.get('/leaderboard').then((r) => r.data);
  },

  referralStats() {
    return playerApi.get('/referrals/me').then(
      (r) =>
        r.data as {
          link: string;
          web_link: string;
          referral_code: string;
          totalReferred: number;
          successfulReferred: number;
          earnedEtb: number;
        },
    );
  },

  referralHistory() {
    return playerApi.get('/referrals/me/history').then(
      (r) =>
        r.data as Array<{
          id: string;
          invited_name: string;
          joined_date: string;
          rewarded: boolean;
          reward_amount: number;
        }>,
    );
  },

  gameRules() {
    return playerApi.get('/game-rules').then(
      (r) => r.data as Array<{ id: string; title: string; body: string; category: string | null; sortOrder: number }>,
    );
  },

  contact() {
    return playerApi.get('/contact', { params: { operator: currentOperatorSlug() } }).then((r) => r.data as { telegram: string; phone: string; whatsapp: string; email: string; support_hours: string; configured: boolean });
  },

  themes() {
    return playerApi.get('/themes').then((r) => r.data as Theme[]);
  },

  setTheme(themeId: string | null) {
    return playerApi.post('/users/theme', { themeId }).then((r) => r.data);
  },
};

export { fileToBase64 } from './api-client';

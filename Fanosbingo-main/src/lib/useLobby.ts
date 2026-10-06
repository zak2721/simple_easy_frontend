import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { RoomInfo, RoomKey } from './types';

export interface LobbySnapshot {
  server_time_ms: number;
  game: null | {
    id: string;
    status: 'waiting' | 'playing' | 'finished';
    game_number: number;
    starts_at: string;
    selection_closed_at: string | null;
    called_numbers: number[];
    current_number: number | null;
    total_pot: number;
    winner_prize: number;
    winner_ids: string[] | null;
    winning_patterns?: string[] | null;
  };
  next_game: null | { id: string; starts_at: string; sales_open_at: string | null; winning_patterns: string[] | null };
  rooms: Record<RoomKey, { price: number; capacity: number; taken: number[]; unavailable?: number[] }>;
  room_list: Array<RoomInfo & { taken: number[]; unavailable: number[] }>;
  my_cartelas: Array<{ player_id: string; room: RoomKey; number: number; card: number[][]; is_disqualified: boolean }>;
  my_counts: Record<RoomKey, number> & { total: number };
  wallet: null | { deposited_balance: number; won_balance: number; total_balance: number; on_hold: number; withdrawable: number };
}

/**
 * Live lobby updates via polling only — Supabase Realtime (`postgres_changes`)
 * is gone, and per SUPABASE_MIGRATION_REPORT.md §3, this codebase already ran
 * this exact poll in parallel with Realtime as a defensive fallback, so
 * dropping Realtime and keeping only the poll is a proven, low-risk path
 * rather than new/untested behavior.
 */
export function useLobby(userId: number | undefined, pollMs = 4000) {
  const [data, setData] = useState<LobbySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const offsetRef = useRef(0);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const snap = (await api.lobby()) as unknown as LobbySnapshot;
      offsetRef.current = snap.server_time_ms - Date.now();
      setData(snap);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load lobby');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    load();
    const iv = setInterval(load, pollMs);
    return () => clearInterval(iv);
  }, [userId, load, pollMs]);

  const serverNow = useCallback(() => Date.now() + offsetRef.current, []);
  return { data, error, loading, reload: load, serverNow };
}

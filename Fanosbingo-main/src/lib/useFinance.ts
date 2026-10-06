import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useSession } from './session';

export interface FinanceData {
  wallet: { deposited_balance: number; won_balance: number; total_balance: number; on_hold: number; withdrawable: number };
  deposits: Array<{ id: string; amount: number; notes?: string; status: string; rejection_reason?: string; submitted_at: string }>;
  withdrawals: Array<{ id: string; amount: number; telebirr_account: string; notes?: string; status: string; rejection_reason?: string; requested_at: string; paid_at?: string }>;
  ledger: Array<{ id: string; entry_type: string; direction: string; amount: number; note?: string; created_at: string }>;
  telebirr: { account_name: string; account_number: string; instructions: string; min_etb: number; max_etb: number; configured: boolean };
}

export function useFinance() {
  const { user, setWallet } = useSession();
  const [data, setData] = useState<FinanceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const d = (await api.myFinance()) as unknown as FinanceData;
      setData(d);
      if (d.wallet) setWallet(d.wallet);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load wallet');
    } finally {
      setLoading(false);
    }
  }, [user, setWallet]);

  useEffect(() => { load(); }, [load]);

  return { data, error, loading, reload: load };
}

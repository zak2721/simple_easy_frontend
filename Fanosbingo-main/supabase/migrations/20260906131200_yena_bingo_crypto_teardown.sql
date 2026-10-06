/*
  # የኛ — retire the crypto (BSC/BNB) payment layer + SMS auto-credit

  Runs LAST, after the manual Telebirr flow is in place. Historical rows are
  PRESERVED (archived, not deleted). Only code paths and config are removed.

  See docs/YENA_BINGO_MIGRATION_AUDIT.md §6-7 for the inventory.
*/

-- 1. Archive historical crypto tables (keep the data)
ALTER TABLE IF EXISTS deposit_transactions     ADD COLUMN IF NOT EXISTS archived_at timestamptz DEFAULT now();
ALTER TABLE IF EXISTS bnb_withdrawal_requests  ADD COLUMN IF NOT EXISTS archived_at timestamptz DEFAULT now();
COMMENT ON TABLE deposit_transactions    IS 'ARCHIVED — legacy BSC/BNB deposits. Read-only history. የኛ uses manual_deposits.';
COMMENT ON TABLE bnb_withdrawal_requests IS 'ARCHIVED — legacy BSC/BNB withdrawals. Read-only history. የኛ uses withdrawal_requests.';

-- 2. Stop the crypto deposit auto-processing trigger
DROP TRIGGER IF EXISTS trigger_process_confirmed_deposit ON deposit_transactions;
DROP TRIGGER IF EXISTS trigger_update_deposit_transaction_timestamp ON deposit_transactions;

-- 3. Stop the SMS auto-credit path (የኛ deposits are ADMIN-verified only)
DROP TRIGGER IF EXISTS trigger_auto_credit_deposit ON user_sms_submissions;
DROP TRIGGER IF EXISTS trigger_match_user_sms ON user_sms_submissions;
COMMENT ON TABLE user_sms_submissions IS 'DEPRECATED — SMS auto-match deposits are disabled. የኛ uses manual_deposits + admin review.';

-- 4. Drop crypto-only functions
DROP FUNCTION IF EXISTS process_confirmed_deposit() CASCADE;
DROP FUNCTION IF EXISTS update_deposit_transaction_timestamp() CASCADE;
DROP FUNCTION IF EXISTS check_bnb_withdrawal_limits(bigint, numeric) CASCADE;
DROP FUNCTION IF EXISTS process_bnb_withdrawal_request(bigint, text, numeric, text, text) CASCADE;
DROP FUNCTION IF EXISTS refund_bnb_withdrawal(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS complete_bnb_withdrawal(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS get_bnb_withdrawal_stats() CASCADE;
DROP FUNCTION IF EXISTS auto_credit_matched_deposit() CASCADE;
DROP FUNCTION IF EXISTS match_user_sms() CASCADE;

-- 5. Remove crypto configuration rows
DELETE FROM settings WHERE id IN (
  'deposit_contract_address','deposit_bsc_rpc_url','deposit_conversion_rate',
  'deposit_minimum_bnb','deposit_minimum_deposit','deposit_required_confirmations',
  'deposit_contract_chain_id',
  'withdrawal_min_bnb','withdrawal_max_daily_bnb','withdrawal_max_weekly_bnb',
  'withdrawal_credits_to_bnb_rate','withdrawal_contract_address',
  'withdrawal_contract_private_key','withdrawal_low_balance_threshold'
);

-- 6. Drop the BNB per-user limit tracker (config only, no history value)
DROP TABLE IF EXISTS bnb_withdrawal_limits_tracking CASCADE;

-- 7. Make sure real balance checks are in force for the new cartela path.
--    (Legacy deduct_stake_* triggers were already removed in 20260906130000;
--     eds_select_cartela enforces balance authoritatively.)
COMMENT ON FUNCTION eds_select_cartela(uuid, text, integer, bigint, text, text, text, text) IS
  'የኛ authoritative cartela purchase: room+price, cartela range, availability, 4-cartela GLOBAL limit, balance, ledger, 80/20 pot. Replaces select_card_atomic.';

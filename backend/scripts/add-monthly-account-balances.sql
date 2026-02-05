-- Monthly Account Balances table for caching end-of-month balances per account
-- Used by the Net Worth report for accurate historical net worth computation

CREATE TABLE IF NOT EXISTS monthly_account_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  month DATE NOT NULL,                        -- first day of month (e.g., 2023-01-01)
  balance NUMERIC(20, 4) NOT NULL DEFAULT 0,  -- transaction-based end-of-month balance
  market_value NUMERIC(20, 4),                -- for INVESTMENT_BROKERAGE: holdings × prices
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (account_id, month)
);

CREATE INDEX IF NOT EXISTS idx_mab_user_month ON monthly_account_balances(user_id, month);

-- Composite indexes for common query patterns
-- Run: docker exec -i moneymate-postgres psql -U moneymate_user -d moneymate < backend/scripts/add-composite-indexes.sql

-- Main transactions listing: WHERE user_id = ? ORDER BY transaction_date DESC, created_at DESC, id DESC
-- Also covers date range filtering: WHERE user_id = ? AND transaction_date BETWEEN ? AND ?
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_user_date_created
  ON transactions(user_id, transaction_date DESC, created_at DESC, id DESC);

-- Account-specific date range queries (reconciliation, account transaction views)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_account_date
  ON transactions(account_id, transaction_date DESC);

-- Monthly account balance lookups by account (net worth calculations)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mab_account_month
  ON monthly_account_balances(account_id, month);

-- Security price lookups by security + date (portfolio valuations, chart data)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_security_prices_security_date
  ON security_prices(security_id, price_date DESC);

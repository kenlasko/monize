-- 019: Add missing indexes for frequently queried columns
-- investment_transactions.transaction_id is used on every transaction list page load
-- scheduled_transaction_overrides(scheduled_transaction_id, original_date) is queried on every scheduled transaction view

CREATE INDEX IF NOT EXISTS idx_investment_transactions_transaction
  ON investment_transactions(transaction_id);

CREATE INDEX IF NOT EXISTS idx_sched_txn_overrides_orig
  ON scheduled_transaction_overrides(scheduled_transaction_id, original_date);

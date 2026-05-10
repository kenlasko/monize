-- Recovery for two interim states this branch passed through:
--
-- (a) An earlier commit on this branch shipped 064 as a CREATE TABLE for a
--     separate scheduled_investment_transactions table. Some dev DBs applied
--     it. We have since pivoted to extending scheduled_transactions in-place
--     and rewrote 064 to ALTER it, but the migration tracker keys off the
--     filename -- so on those dev DBs, 064 is marked applied and the new
--     ALTER content never runs, leaving scheduled_transactions without the
--     investment columns the entity now expects.
--
-- (b) Fresh installs already get the columns from schema.sql, so the same
--     ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS guards make
--     this migration a no-op for them.
--
-- This file is fully idempotent: it brings every database (rewritten-064-not-run,
-- rewritten-064-already-run, fresh-install) to the same end state.

ALTER TABLE scheduled_transactions
  ADD COLUMN IF NOT EXISTS is_investment BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS investment_action VARCHAR(50),
  ADD COLUMN IF NOT EXISTS investment_security_id UUID REFERENCES securities(id),
  ADD COLUMN IF NOT EXISTS investment_funding_account_id UUID REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS investment_quantity NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS investment_price NUMERIC(20, 6),
  ADD COLUMN IF NOT EXISTS investment_commission NUMERIC(20, 4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS investment_total_amount NUMERIC(20, 4),
  ADD COLUMN IF NOT EXISTS investment_exchange_rate NUMERIC(20, 10);

CREATE INDEX IF NOT EXISTS idx_scheduled_transactions_inv_security
  ON scheduled_transactions(investment_security_id)
  WHERE investment_security_id IS NOT NULL;

ALTER TABLE scheduled_transactions
  DROP CONSTRAINT IF EXISTS chk_scheduled_transactions_kind_exclusive;

ALTER TABLE scheduled_transactions
  ADD CONSTRAINT chk_scheduled_transactions_kind_exclusive CHECK (
    NOT (is_transfer = TRUE AND is_investment = TRUE)
  );

-- Drop the orphaned separate table created by the rolled-back approach.
-- Safe: schema.sql no longer defines it; entity no longer maps it; nothing
-- in the running app references it.
DROP TABLE IF EXISTS scheduled_investment_transactions;

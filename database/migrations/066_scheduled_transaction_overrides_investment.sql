-- Per-occurrence investment overrides.
--
-- Investment scheduled transactions can be tweaked for a single occurrence
-- without altering the base template (e.g. a one-off DRIP buy with a different
-- quantity, or a SELL at a unique price). The override row carries the
-- per-occurrence quantity / price / total-amount; commission, security and
-- action stay on the base scheduled transaction.

ALTER TABLE scheduled_transaction_overrides
  ADD COLUMN IF NOT EXISTS investment_quantity NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS investment_price NUMERIC(20, 6),
  ADD COLUMN IF NOT EXISTS investment_total_amount NUMERIC(20, 4);

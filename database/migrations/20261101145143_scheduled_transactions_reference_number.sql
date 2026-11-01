-- Scheduled transactions: a stored reference number (cheque number,
-- confirmation number, biller account number) that each posted occurrence
-- inherits unless the post supplies its own. Mirrors
-- transactions.reference_number.
--
-- Pure expand: one nullable column, so the previous release keeps working
-- against this schema during a rolling deploy.

ALTER TABLE scheduled_transactions
  ADD COLUMN IF NOT EXISTS reference_number VARCHAR(100);

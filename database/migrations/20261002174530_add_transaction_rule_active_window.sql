-- Transaction rules: an optional active window per rule
-- (docs/specs/transaction-rules-structural-actions.md section 3.1, INV-RULE-004).
--
-- active_from / active_to are the first and last transaction date, both
-- inclusive, for which the rule is evaluated; NULL means open on that side.
-- The planner enforces the window on every path (create, import, test, run);
-- the CHECK only keeps a stored window from being empty.
--
-- Pure expand: two nullable columns, so the previous release keeps working
-- against this schema during a rolling deploy.

ALTER TABLE transaction_rules
  ADD COLUMN IF NOT EXISTS active_from DATE;
ALTER TABLE transaction_rules
  ADD COLUMN IF NOT EXISTS active_to DATE;

ALTER TABLE transaction_rules
  DROP CONSTRAINT IF EXISTS ck_transaction_rules_active_window;
ALTER TABLE transaction_rules
  ADD CONSTRAINT ck_transaction_rules_active_window
  CHECK (active_from IS NULL OR active_to IS NULL OR active_from <= active_to);

-- Transfer categories (docs/specs/transfer-categories.md section 6.6): a
-- closed period stores the Transfer Funding part of its income beside
-- actual_income (Total Budget Funding, unchanged). NULL on a period closed
-- before this column existed: its split is unknown, not zero (section 10).
-- Widening only, so a previous release keeps working during a rollout.
ALTER TABLE budget_periods
    ADD COLUMN IF NOT EXISTS transfer_funding NUMERIC(24, 8);

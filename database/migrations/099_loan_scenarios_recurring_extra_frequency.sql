-- Cadence of the recurring overpayment on saved loan scenarios: WEEKLY,
-- BIWEEKLY, MONTHLY, QUARTERLY or ANNUALLY. Nullable; a missing value means the
-- amount is applied on every loan payment (legacy "extra per payment"). One-off
-- overpayments do not use this column -- they are stored as a single entry in
-- the existing lump_sums JSONB.
ALTER TABLE loan_scenarios
  ADD COLUMN IF NOT EXISTS recurring_extra_frequency VARCHAR(16);

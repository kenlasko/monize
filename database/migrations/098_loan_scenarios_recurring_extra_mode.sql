-- Per-overpayment effect for saved loan scenarios: whether the recurring extra
-- shortens the term or lowers the installment. Nullable; a missing value is
-- treated as SHORTEN_TERM. One-off lump sums carry their own mode inside the
-- existing lump_sums JSONB, so only the recurring extra needs a column.
ALTER TABLE loan_scenarios
  ADD COLUMN IF NOT EXISTS recurring_extra_mode VARCHAR(16);

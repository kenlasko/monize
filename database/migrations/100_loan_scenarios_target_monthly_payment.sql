-- Fixed monthly-budget overpayment on saved loan scenarios: a total to spend on
-- the loan each period (installment + overpayment). The mode controls how the
-- installment/overpayment split is shown (SHORTEN_TERM / LOWER_INSTALLMENT); the
-- optional start/end dates bound the period over which the budget applies.
ALTER TABLE loan_scenarios
  ADD COLUMN IF NOT EXISTS target_monthly_payment DECIMAL(20,4),
  ADD COLUMN IF NOT EXISTS target_monthly_payment_mode VARCHAR(16),
  ADD COLUMN IF NOT EXISTS target_monthly_payment_start_date DATE,
  ADD COLUMN IF NOT EXISTS target_monthly_payment_end_date DATE;

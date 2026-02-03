-- Migration: Add mortgage-specific fields to accounts table
-- Date: 2026-02

-- Add mortgage-specific columns to accounts table
-- These extend the existing loan fields to support Canadian mortgages with semi-annual compounding

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_canadian_mortgage BOOLEAN DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_variable_rate BOOLEAN DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS term_months INTEGER;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS term_end_date DATE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS amortization_months INTEGER;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS original_principal NUMERIC(20, 4);

-- Add index for term end date queries (for renewal reminders)
CREATE INDEX IF NOT EXISTS idx_accounts_term_end_date ON accounts(term_end_date)
  WHERE account_type = 'MORTGAGE' AND term_end_date IS NOT NULL;

-- Add comments for documentation
COMMENT ON COLUMN accounts.is_canadian_mortgage IS 'Whether this mortgage uses Canadian semi-annual compounding (required by law for fixed-rate Canadian mortgages)';
COMMENT ON COLUMN accounts.is_variable_rate IS 'Whether this is a variable rate mortgage (uses monthly compounding even in Canada)';
COMMENT ON COLUMN accounts.term_months IS 'Mortgage term length in months (contract period, typically 6-120 months)';
COMMENT ON COLUMN accounts.term_end_date IS 'Date when the mortgage term ends (renewal date)';
COMMENT ON COLUMN accounts.amortization_months IS 'Total amortization period in months (typically 180-360 months / 15-30 years)';
COMMENT ON COLUMN accounts.original_principal IS 'Original mortgage principal amount for reporting purposes';

-- Migration: Add loan-specific fields to accounts table
-- Date: 2024

-- Add loan-specific columns to accounts table
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS payment_amount NUMERIC(20, 4);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS payment_frequency VARCHAR(20);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS payment_start_date DATE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS source_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS principal_category_id UUID REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS interest_category_id UUID REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS scheduled_transaction_id UUID REFERENCES scheduled_transactions(id) ON DELETE SET NULL;

-- Add indexes for the new foreign key columns
CREATE INDEX IF NOT EXISTS idx_accounts_source_account ON accounts(source_account_id);
CREATE INDEX IF NOT EXISTS idx_accounts_principal_category ON accounts(principal_category_id);
CREATE INDEX IF NOT EXISTS idx_accounts_interest_category ON accounts(interest_category_id);
CREATE INDEX IF NOT EXISTS idx_accounts_scheduled_transaction ON accounts(scheduled_transaction_id);

-- Add comment for documentation
COMMENT ON COLUMN accounts.payment_amount IS 'Payment amount per period for loan accounts';
COMMENT ON COLUMN accounts.payment_frequency IS 'Payment frequency: WEEKLY, BIWEEKLY, MONTHLY, QUARTERLY, YEARLY';
COMMENT ON COLUMN accounts.payment_start_date IS 'Date when loan payments begin';
COMMENT ON COLUMN accounts.source_account_id IS 'Account from which loan payments are drawn';
COMMENT ON COLUMN accounts.principal_category_id IS 'Category for tracking principal portion of loan payments';
COMMENT ON COLUMN accounts.interest_category_id IS 'Category for tracking interest portion of loan payments';
COMMENT ON COLUMN accounts.scheduled_transaction_id IS 'Linked scheduled transaction for automatic loan payments';

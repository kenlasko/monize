-- Migration: Add investment account fields
-- Description: Adds account_sub_type and linked_account_id columns to support linked investment account pairs

-- Add account_sub_type column
ALTER TABLE accounts
ADD COLUMN IF NOT EXISTS account_sub_type VARCHAR(50);

-- Add linked_account_id column with foreign key
ALTER TABLE accounts
ADD COLUMN IF NOT EXISTS linked_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

-- Create index on linked_account_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_accounts_linked_account_id ON accounts(linked_account_id);

-- Create index on account_sub_type for faster filtering
CREATE INDEX IF NOT EXISTS idx_accounts_account_sub_type ON accounts(account_sub_type);

-- Note: After running this migration, existing investment accounts will have NULL values
-- for account_sub_type and linked_account_id. New investment accounts created with
-- createInvestmentPair=true will have these fields populated automatically.

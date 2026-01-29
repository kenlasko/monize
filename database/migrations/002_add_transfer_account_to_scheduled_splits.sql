-- Migration: Add transfer_account_id to scheduled_transaction_splits table
-- Date: 2024
-- Purpose: Allow scheduled transaction splits to reference a target account for transfers

-- Add transfer_account_id column to scheduled_transaction_splits table
ALTER TABLE scheduled_transaction_splits
ADD COLUMN IF NOT EXISTS transfer_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

-- Add index for the new column
CREATE INDEX IF NOT EXISTS idx_scheduled_transaction_splits_transfer_account
ON scheduled_transaction_splits(transfer_account_id);

-- Add comment for documentation
COMMENT ON COLUMN scheduled_transaction_splits.transfer_account_id IS
'Target account for transfer splits - allows scheduled transaction splits to transfer money between accounts';

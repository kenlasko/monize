-- Migration: Add direct transfer support to scheduled_transactions table
-- Date: 2026-01-30
-- Description: Adds is_transfer and transfer_account_id columns for simple scheduled transfers
--              This allows scheduled transfers without requiring splits

-- Add is_transfer column (boolean flag to identify scheduled transfers)
ALTER TABLE scheduled_transactions
ADD COLUMN IF NOT EXISTS is_transfer BOOLEAN DEFAULT false;

-- Add transfer_account_id column (destination account for the transfer)
ALTER TABLE scheduled_transactions
ADD COLUMN IF NOT EXISTS transfer_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

-- Create index for transfer account lookup
CREATE INDEX IF NOT EXISTS idx_scheduled_transactions_transfer_account
ON scheduled_transactions(transfer_account_id);

-- Add comments for documentation
COMMENT ON COLUMN scheduled_transactions.is_transfer IS 'True if this scheduled transaction is an account-to-account transfer';
COMMENT ON COLUMN scheduled_transactions.transfer_account_id IS 'Destination account for scheduled transfers';

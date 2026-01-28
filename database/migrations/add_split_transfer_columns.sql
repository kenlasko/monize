-- Migration: Add transfer support columns to transaction_splits table
-- Date: 2026-01-28
-- Description: Adds transfer_account_id and linked_transaction_id columns to support transfers in split transactions

-- Add transfer_account_id column (target account for transfer splits)
ALTER TABLE transaction_splits
ADD COLUMN IF NOT EXISTS transfer_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

-- Add linked_transaction_id column (links to the corresponding transaction in the target account)
ALTER TABLE transaction_splits
ADD COLUMN IF NOT EXISTS linked_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL;

-- Create indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_transaction_splits_transfer_account ON transaction_splits(transfer_account_id);
CREATE INDEX IF NOT EXISTS idx_transaction_splits_linked ON transaction_splits(linked_transaction_id);

-- Add comments for documentation
COMMENT ON COLUMN transaction_splits.transfer_account_id IS 'Target account ID when this split is a transfer (mutually exclusive with category_id)';
COMMENT ON COLUMN transaction_splits.linked_transaction_id IS 'References the transaction created in the target account for transfer splits';

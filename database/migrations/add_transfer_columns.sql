-- Migration: Add transfer support columns to transactions table
-- Date: 2026-01-25
-- Description: Adds is_transfer and linked_transaction_id columns to support account transfers

-- Add is_transfer column (boolean flag to identify transfer transactions)
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS is_transfer BOOLEAN DEFAULT false;

-- Add linked_transaction_id column (links the two transactions that make up a transfer)
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS linked_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL;

-- Create index for linked transactions lookup
CREATE INDEX IF NOT EXISTS idx_transactions_linked ON transactions(linked_transaction_id);

-- Add comment for documentation
COMMENT ON COLUMN transactions.is_transfer IS 'True if this transaction is part of an account-to-account transfer';
COMMENT ON COLUMN transactions.linked_transaction_id IS 'References the other transaction in a transfer pair';

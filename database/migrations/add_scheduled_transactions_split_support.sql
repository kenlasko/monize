-- Migration: Add split support to scheduled_transactions table
-- Adds is_split column to track whether a scheduled transaction has splits

-- Add is_split column if it doesn't exist
ALTER TABLE scheduled_transactions ADD COLUMN IF NOT EXISTS is_split BOOLEAN DEFAULT false;

-- Create index for scheduled_transaction_splits if it doesn't exist
CREATE INDEX IF NOT EXISTS idx_scheduled_transaction_splits_transaction ON scheduled_transaction_splits(scheduled_transaction_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_transaction_splits_category ON scheduled_transaction_splits(category_id);

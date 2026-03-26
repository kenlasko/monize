-- Add exclude_from_net_worth column to accounts table
-- Allows users to exclude specific accounts from net worth calculations
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS exclude_from_net_worth BOOLEAN DEFAULT false;

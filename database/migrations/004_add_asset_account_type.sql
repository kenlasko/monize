-- Migration: Add ASSET account type and asset_category_id field
-- Date: 2025

-- Add ASSET to the account_type enum
ALTER TYPE account_type ADD VALUE IF NOT EXISTS 'ASSET';

-- Add asset_category_id column to accounts table
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS asset_category_id UUID REFERENCES categories(id) ON DELETE SET NULL;

-- Add index for the new foreign key column
CREATE INDEX IF NOT EXISTS idx_accounts_asset_category ON accounts(asset_category_id);

-- Add comment for documentation
COMMENT ON COLUMN accounts.asset_category_id IS 'Category for tracking value changes on asset accounts';

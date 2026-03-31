-- Add favourite_sort_order column to accounts for user-defined ordering of favourite accounts
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS favourite_sort_order INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_accounts_user_favourite_sort ON accounts(user_id, favourite_sort_order);

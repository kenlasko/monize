-- Add category_id column to transactions table for simple (non-split) transactions
-- This provides a convenient way to assign a single category without using splits

ALTER TABLE transactions
ADD COLUMN category_id UUID REFERENCES categories(id) ON DELETE SET NULL;

-- Add index for better query performance
CREATE INDEX idx_transactions_category ON transactions(category_id);

-- Note: For split transactions (is_split = true), categories should be managed via transaction_splits table
-- For simple transactions (is_split = false), use the category_id column directly

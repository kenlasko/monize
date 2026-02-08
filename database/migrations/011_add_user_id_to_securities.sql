-- Migration: Add user_id to securities table for multi-tenant isolation
-- Securities are now scoped per-user instead of being global

-- Add user_id column (nullable initially for backfill)
ALTER TABLE securities ADD COLUMN user_id UUID REFERENCES users(id);

-- Backfill: assign existing securities to users who have investment transactions referencing them
UPDATE securities s SET user_id = (
  SELECT DISTINCT it.user_id FROM investment_transactions it
  WHERE it.security_id = s.id LIMIT 1
);

-- For any orphaned securities with no transactions, assign to the first user
UPDATE securities s SET user_id = (
  SELECT id FROM users LIMIT 1
) WHERE s.user_id IS NULL;

-- Make user_id NOT NULL after backfill
ALTER TABLE securities ALTER COLUMN user_id SET NOT NULL;

-- Replace global unique constraint on symbol with per-user unique
ALTER TABLE securities DROP CONSTRAINT IF EXISTS securities_symbol_key;
ALTER TABLE securities ADD CONSTRAINT securities_user_symbol_unique UNIQUE (user_id, symbol);

-- Add index for user_id lookups
CREATE INDEX IF NOT EXISTS idx_securities_user_id ON securities(user_id);

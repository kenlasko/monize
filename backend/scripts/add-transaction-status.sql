-- Migration: Add transaction status column
-- This replaces the is_cleared and is_reconciled boolean columns with a single status enum column

-- Step 1: Add the new status column with default value
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'UNRECONCILED';

-- Step 2: Migrate existing data based on current boolean values
-- Priority: RECONCILED > CLEARED > UNRECONCILED
UPDATE transactions
SET status = CASE
    WHEN is_reconciled = true THEN 'RECONCILED'
    WHEN is_cleared = true THEN 'CLEARED'
    ELSE 'UNRECONCILED'
END
WHERE status = 'UNRECONCILED' OR status IS NULL;

-- Step 3: Drop the old boolean columns (optional - can keep for backwards compatibility)
-- Uncomment these lines once you've verified the migration worked correctly:
-- ALTER TABLE transactions DROP COLUMN IF EXISTS is_cleared;
-- ALTER TABLE transactions DROP COLUMN IF EXISTS is_reconciled;

-- Step 4: Add an index on status for faster queries
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);

-- Verification query - run this to check the migration worked:
-- SELECT status, COUNT(*) FROM transactions GROUP BY status;

-- Allow a transaction split to embed an investment action (BUY/SELL/DIVIDEND/etc).
-- Lets a single split transaction represent paycheck-with-equity-grant style entries:
-- gross income (+), tax withholding (-), and BUY shares (-) all in one balanced post.

-- 1) Discriminator column for split kind.
ALTER TABLE transaction_splits
  ADD COLUMN IF NOT EXISTS kind VARCHAR(20);

-- Backfill: transfers first (transfer_account_id wins, matching existing service logic).
UPDATE transaction_splits SET kind = 'transfer'
  WHERE kind IS NULL AND transfer_account_id IS NOT NULL;

-- Legacy data hygiene: a transfer-marked row should not also carry a category_id
-- (the category was meaningless for a transfer split). Clear it so the new
-- mutual-exclusion constraint can hold.
UPDATE transaction_splits SET category_id = NULL
  WHERE kind = 'transfer' AND category_id IS NOT NULL;

-- Everything else is a category split (including legacy uncategorized rows where
-- category_id may be NULL — the DTO allows that, so the constraint must too).
UPDATE transaction_splits SET kind = 'category'
  WHERE kind IS NULL;

ALTER TABLE transaction_splits
  ALTER COLUMN kind SET NOT NULL;

ALTER TABLE transaction_splits
  ALTER COLUMN kind SET DEFAULT 'category';

-- 2) Back-link from investment_transactions to the owning split (when embedded).
ALTER TABLE investment_transactions
  ADD COLUMN IF NOT EXISTS transaction_split_id UUID
    REFERENCES transaction_splits(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_investment_transactions_split_id
  ON investment_transactions(transaction_split_id);

-- 3) Mutual-exclusion check between the three split kinds. Category kind allows
-- a NULL category_id (uncategorized split); the only hard rule is that the
-- columns associated with the *other* kinds must be NULL.
ALTER TABLE transaction_splits
  DROP CONSTRAINT IF EXISTS chk_split_kind_exclusive;

ALTER TABLE transaction_splits
  ADD CONSTRAINT chk_split_kind_exclusive CHECK (
    (kind = 'category'   AND transfer_account_id IS NULL) OR
    (kind = 'transfer'   AND transfer_account_id IS NOT NULL AND category_id IS NULL) OR
    (kind = 'investment' AND category_id IS NULL AND transfer_account_id IS NULL)
  );

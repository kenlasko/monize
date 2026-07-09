-- Link an asset/other account to its financing loan or mortgage so the account
-- detail page can show equity (asset value minus the linked loan balance).
-- Nullable; ON DELETE SET NULL so removing the loan just unlinks the asset.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS linked_loan_account_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_accounts_linked_loan_account'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT fk_accounts_linked_loan_account
      FOREIGN KEY (linked_loan_account_id) REFERENCES accounts(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_accounts_linked_loan_account_id
  ON accounts(linked_loan_account_id);

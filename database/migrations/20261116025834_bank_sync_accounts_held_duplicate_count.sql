-- bank_sync_accounts.held_duplicate_count: how many possible duplicates the
-- last write of this bank account held back for the person to decide
-- (docs/specs/import-duplicate-review.md section 4). While it is above zero the
-- account needs its preview (bankAccountNeedsPreview), so the daily sync skips
-- it until the person has decided.
--
-- Expand only: a new column with a default. The previous release neither reads
-- nor writes it, and its inserts get the default. Idempotent: safe to run
-- repeatedly.

ALTER TABLE bank_sync_accounts
    ADD COLUMN IF NOT EXISTS held_duplicate_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE bank_sync_accounts
    DROP CONSTRAINT IF EXISTS ck_bank_sync_accounts_held_duplicate_count;
ALTER TABLE bank_sync_accounts
    ADD CONSTRAINT ck_bank_sync_accounts_held_duplicate_count
    CHECK (held_duplicate_count >= 0);

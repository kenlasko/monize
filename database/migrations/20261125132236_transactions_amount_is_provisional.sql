-- Record whether a transaction's amount is provisional in a column (issue
-- #2389, Discussion #2383; design docs/specs/provisional-amounts.md,
-- sections 5 and 6).
--
-- When an imported file holds a cross-currency transfer, the importer creates
-- the other account's leg before that account's own file has arrived. Until
-- now that leg was marked only by the words PENDING IMPORT in its description
-- (a note the importer has since stopped writing; migration 20261126115405
-- strips it, issue #2400), a field the reader can edit. This
-- adds the column that becomes the only source of truth for the state, and
-- the partial index the importer's pending lookups and the provisional counts
-- read.
--
-- Backfill: a transfer leg (is_transfer) whose description holds the marker
-- text is flagged, linked or not: the importer's pending lookups match an
-- unlinked marked leg too (its source deleted, ON DELETE SET NULL), and once
-- the note is stripped such a leg would be findable by the column alone. A non-transfer row that
-- happens to carry the text is not, and nothing else changes: the description
-- keeps its note until a later migration strips it (task B4), and nothing
-- reads the column yet. The marker is matched exactly as the importer's
-- pattern then did. A shared-expense ledger row (a posting,
-- or an account in a shared group) is skipped: the importer never writes one,
-- and shared_protect_ledger_transaction refuses the update, which would fail
-- the migration.
--
-- Re-runnable: the column and index are guarded, and a flagged row no longer
-- matches amount_is_provisional = false, so a second pass updates nothing.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS amount_is_provisional BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN transactions.amount_is_provisional IS
  'The amount is the importer''s estimate for the other account''s leg of a cross-currency transfer, not yet confirmed by that account''s own file or by the reader. The only source of truth for the state (docs/future-plans/provisional-amounts.md).';

CREATE INDEX IF NOT EXISTS idx_transactions_provisional
  ON transactions(user_id, account_id)
  WHERE amount_is_provisional;

UPDATE transactions
SET amount_is_provisional = true
WHERE amount_is_provisional = false
  AND is_transfer = true
  AND description LIKE '%PENDING IMPORT%'
  AND shared_expense_posting_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = transactions.account_id
      AND a.shared_expense_group_id IS NOT NULL
  );

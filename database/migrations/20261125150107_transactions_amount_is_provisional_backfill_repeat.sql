-- Repeat the issue #2389 backfill of transactions.amount_is_provisional
-- (issue #2390; design docs/specs/provisional-amounts.md, section 11).
--
-- 20261125132236_transactions_amount_is_provisional.sql flagged the transfer
-- legs whose description held the importer's PENDING IMPORT note. A release
-- that carried that migration but not the importer change of issue #2390 kept
-- writing such legs with the note and the column at its default, so the rows
-- it wrote between the two deployments are flagged here by the same rule. The
-- importer now writes the column itself, so no later release creates another
-- such row (the backfill is repeated once more when the note is retired, task
-- B4).
--
-- Same predicate as the first pass: a transfer leg (is_transfer) carrying the
-- marker text, linked or not; a non-transfer row with the text is left alone,
-- the description is left alone, and a shared-expense ledger row is skipped
-- because shared_protect_ledger_transaction would refuse the update.
--
-- Re-runnable: a flagged row no longer matches amount_is_provisional = false,
-- so a second pass updates nothing.

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

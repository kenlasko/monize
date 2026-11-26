-- Repeat the PENDING IMPORT note strip of
-- 20261126115405_transactions_strip_pending_import_note.sql (issue #2402,
-- task Q of the provisional-amounts plan (docs/specs/provisional-amounts.md, section 14); decided on issue
-- #2400).
--
-- That migration runs once at container start. During its rollout a pod of
-- the previous release can still import a cross-currency transfer and write
-- the note beside a correct amount_is_provisional flag; the note stays inert
-- (nothing reads the description) until this statement removes it. Same
-- statement, same scope: transfer legs only, the exact note only, shared
-- expense ledger rows skipped, the flag untouched. Never a repeat of the flag
-- backfill: a reader's Confirm amount clears the flag and a backfill by the
-- text would undo it.
--
-- Re-runnable: a stripped description no longer holds the note, so a pass over
-- rows already handled selects nothing.

DO $$
DECLARE
    note CONSTANT TEXT := chr(9888) || chr(65039)
        || ' PENDING IMPORT: Amount may need adjustment when importing the other account.';
    stripped INTEGER;
BEGIN
    UPDATE transactions t
    SET description = NULLIF(btrim(replace(t.description, note, '')), '')
    WHERE t.is_transfer = true
      AND strpos(t.description, note) > 0
      AND t.shared_expense_posting_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM accounts a
        WHERE a.id = t.account_id
          AND a.shared_expense_group_id IS NOT NULL
      );

    GET DIAGNOSTICS stripped = ROW_COUNT;
    IF stripped > 0 THEN
        RAISE NOTICE 'transactions_strip_pending_import_note_repeat: removed the PENDING IMPORT note from % transfer leg description(s) (issue #2402)', stripped;
    END IF;
END $$;

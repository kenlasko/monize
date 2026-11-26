-- Retire the importer's PENDING IMPORT description note (issue #2400; design
-- docs/future-plans/provisional-amounts.md, decision 1, P1 and section 11).
--
-- Until issue #2389 a cross-currency transfer leg the importer wrote before
-- the other account's file arrived was marked only by a note it appended to
-- the leg's description:
--
--   <memo> <U+26A0 U+FE0F> PENDING IMPORT: Amount may need adjustment when importing the other account.
--
-- transactions.amount_is_provisional now records that state, the two earlier
-- migrations (20261125132236 and 20261125150107) flagged the legs that carried
-- the note, and the importer no longer writes it. This removes the note from
-- the descriptions that still hold it: the exact text is cut out, the rest is
-- trimmed, and a description left empty is stored as NULL. Nothing else on
-- the row changes, and the flag is not touched.
--
-- Deliberately not a third backfill of the flag. Since issue #2392 a reader
-- confirms an amount (the Confirm amount action, or a transfer edit stating
-- the leg's amount) by clearing the flag, and the description keeps the note;
-- such a leg is indistinguishable from an unflagged one an older release
-- wrote (action history is pruned, so it is no evidence), and flagging it
-- again would undo the reader's confirmation. So the note is removed from
-- every transfer leg carrying it, flagged or confirmed, and the flag is left
-- as it stands (decided on issue #2400).
--
-- Scope:
--   * transfer legs only (is_transfer): a non-transfer row whose description
--     holds the words, or even the whole note, is the reader's own text and is
--     left alone;
--   * the exact note only, matched as one string with its emoji (written here
--     as chr() so the file holds none): a description the reader edited so it
--     no longer holds the note verbatim is left alone;
--   * a shared-expense ledger row (shared_expense_posting_id, or an account in
--     a shared group) is skipped, as in the two backfills: the importer never
--     writes one, and shared_protect_ledger_transaction would refuse the edit.
--
-- The restore of a backup taken before this migration applies the same strip
-- (backend/src/backup/restore-legacy-normalizations.ts).
--
-- Re-runnable: a stripped description no longer holds the note, so a second
-- pass selects nothing.

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
        RAISE NOTICE 'transactions_strip_pending_import_note: removed the PENDING IMPORT note from % transfer leg description(s) (issue #2400)', stripped;
    END IF;
END $$;

-- Document scanner: link a scanned attachment to the unprocessed photo it came
-- from (docs/future-plans/document-scanner.md).
--
-- A "scan pair" is two rows in this table: the enhanced image the user sees,
-- and the original camera photo kept beside it. The link lives on the
-- ORIGINAL and points at the visible row, so:
--   * deleting the visible attachment removes its original by ON DELETE
--     CASCADE, with no application code and with the existing AFTER DELETE
--     tombstone trigger firing for both rows (the sweeper then deletes both
--     objects);
--   * an ordinary attachment, and the visible half of a pair, both have NULL
--     here -- which is what "a visible attachment" means everywhere it is
--     read (backend/src/attachments/primary-attachment.util.ts).
--
-- The partial unique index makes "at most one original per attachment" a
-- database fact rather than a service convention, and the CHECK stops a row
-- from being its own original.

ALTER TABLE transaction_attachments
    ADD COLUMN IF NOT EXISTS original_of_attachment_id UUID NULL
        REFERENCES transaction_attachments(id) ON DELETE CASCADE;

COMMENT ON COLUMN transaction_attachments.original_of_attachment_id IS
    'Set on the unprocessed original of a scanned document; points at the visible (enhanced) attachment. NULL for every attachment a user sees.';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_attachment_not_own_original'
    ) THEN
        ALTER TABLE transaction_attachments
            ADD CONSTRAINT chk_attachment_not_own_original
            CHECK (original_of_attachment_id IS NULL
                   OR original_of_attachment_id <> id);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_transaction_attachments_original_of
    ON transaction_attachments(original_of_attachment_id)
    WHERE original_of_attachment_id IS NOT NULL;

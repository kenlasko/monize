-- Bank sync preview details: exceptions and operation-type tags
-- (docs/specs/bank-sync.md section 7b, task BS20).
--
-- Pure expand: two new columns with a constant default or NULL, so the previous
-- release keeps working against this schema during a rolling deploy (it neither
-- reads nor writes them, and its INSERTs take the default).
--
--   * bank_sync_imported_transactions.excluded_at: set on a ledger row the user
--     added to the exceptions from the preview. Such a row has no transaction
--     (transaction_id stays NULL), and it claims its (account_id, external_key)
--     like any other ledger row, so no later sync imports that bank transaction.
--     NULL is an ordinary import. Removing an exception deletes the row, and only
--     a row with excluded_at set and no transaction can be deleted that way.
--   * bank_sync_connections.tag_operation_type: whether a synced transaction is
--     tagged with the bank's operation type (card payment, transfer in, ...). On
--     by default.
ALTER TABLE bank_sync_imported_transactions
    ADD COLUMN IF NOT EXISTS excluded_at TIMESTAMPTZ;

ALTER TABLE bank_sync_connections
    ADD COLUMN IF NOT EXISTS tag_operation_type BOOLEAN NOT NULL DEFAULT true;

-- Bank sync notifications: how the daily sync reports a successful run
-- (docs/specs/bank-sync-notifications.md section 3, task BS12).
--
-- Pure expand: one new column on bank_sync_connections with a constant default,
-- so the previous release keeps working against this schema during a rolling
-- deploy (it neither reads nor writes it, and its INSERTs take the default).
--
--   * notify_success: 'always' notifies after every daily sync, even one that
--     imported nothing; 'when_imported' only when rows were imported (the
--     default); 'never' stays silent. Failures and consent reminders do not
--     depend on it.
--
-- The CHECK is added with the column, so no release has written a value it
-- could reject: the column did not exist before this migration, and every row
-- takes the default. It is the database half of BANK_SYNC_NOTIFY_SUCCESS_MODES
-- in backend/src/bank-sync/bank-sync.constants.ts, which
-- bank-sync-constants.guard.spec.ts holds equal to it.
ALTER TABLE bank_sync_connections
    ADD COLUMN IF NOT EXISTS notify_success VARCHAR(20) NOT NULL DEFAULT 'when_imported';

ALTER TABLE bank_sync_connections
    DROP CONSTRAINT IF EXISTS ck_bank_sync_connections_notify_success;
ALTER TABLE bank_sync_connections
    ADD CONSTRAINT ck_bank_sync_connections_notify_success
    CHECK (notify_success IN ('always', 'when_imported', 'never'));

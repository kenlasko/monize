-- Custom recurrence on scheduled transactions (docs/specs/custom-recurrence.md).
--
-- scheduled_transactions.frequency takes the new value 'CUSTOM' (the column is
-- VARCHAR(20) with no CHECK, so no DDL is needed for it), and the rule a
-- Custom schedule repeats by is stored here as its canonical JSON form
-- (CustomRecurrence, backend/src/common/custom-recurrence.ts): the rule when
-- frequency = 'CUSTOM', NULL otherwise. The service enforces that pairing on
-- every write. A CHECK is deliberately not added: a pod of the previous release
-- could still write a row during a rolling deployment, so the constraint
-- belongs to a later contract migration (docs/database-migrations.md, "narrow
-- a type or add a CHECK").
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; nullable, so the previous release's
-- inserts keep working.
ALTER TABLE scheduled_transactions
    ADD COLUMN IF NOT EXISTS custom_recurrence JSONB;

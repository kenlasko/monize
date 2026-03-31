-- Add EVERY4WEEKS as a supported frequency for scheduled transactions.
-- The frequency column is VARCHAR(20) so no DDL change is needed;
-- this migration exists to keep schema.sql and migrations in sync.
-- No-op: the column already accepts any string value up to 20 characters.
SELECT 1;

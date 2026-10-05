-- Mortgage type contract (docs/specs/mortgage-types.md, decision 6, task
-- P3-B1): accounts.mortgage_type becomes NOT NULL DEFAULT 'ANNUITY' and the
-- two legacy flags it replaced, is_canadian_mortgage and is_variable_rate, are
-- dropped.
--
-- Contract half of "expand now, contract later": the previous release must
-- already read and write mortgage_type (Phase 1, migration
-- 20261002151116_accounts_mortgage_type.sql), and this migration ships at least
-- one release after it, so the image a rollback lands on no longer needs the
-- flags.
--
-- 1. Every MORTGAGE row still null is re-derived from the flags with the
--    Phase 1 backfill CASE (spec table 4.2), before they are dropped: an insert
--    by a pre-Phase-1 pod during that rollout leaves one. The DO block skips it
--    where the flags are already gone (a fresh install from schema.sql, or a
--    second apply).
-- 2. Every other null row (a non-mortgage account; nothing else reads the
--    column there, and a plain LOAN prices as ANNUITY) takes the default, so
--    the column can be NOT NULL and every row is read as stored.
-- 3. The default, NOT NULL, and the two flags dropped. SET DEFAULT and
--    SET NOT NULL are no-ops on re-apply; the drops are guarded.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'accounts'
          AND column_name = 'is_canadian_mortgage'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'accounts'
          AND column_name = 'is_variable_rate'
    ) THEN
        UPDATE accounts
           SET mortgage_type = CASE
                 WHEN COALESCE(is_canadian_mortgage, false)
                      AND NOT COALESCE(is_variable_rate, false) THEN 'CANADIAN_FIXED'
                 ELSE 'ANNUITY'
               END
         WHERE account_type = 'MORTGAGE'
           AND mortgage_type IS NULL;
    END IF;
END $$;

UPDATE accounts
   SET mortgage_type = 'ANNUITY'
 WHERE mortgage_type IS NULL;

ALTER TABLE accounts
  ALTER COLUMN mortgage_type SET DEFAULT 'ANNUITY';
ALTER TABLE accounts
  ALTER COLUMN mortgage_type SET NOT NULL;

ALTER TABLE accounts DROP COLUMN IF EXISTS is_canadian_mortgage;
ALTER TABLE accounts DROP COLUMN IF EXISTS is_variable_rate;

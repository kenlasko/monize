-- Mortgage type contract (docs/specs/mortgage-types.md, decision 6, task
-- P3-B2): accounts.mortgage_type becomes NOT NULL and the legacy
-- is_canadian_mortgage / is_variable_rate flags are dropped.
--
-- contract-after: 1.20.0
-- 1.20.0 is the first release whose code neither reads nor writes either flag,
-- and every writer from it on sets a type or takes the column's DEFAULT
-- 'ANNUITY' (20261003152748_accounts_mortgage_type_default.sql); only 1.19.x
-- maps the flags or writes a null type, and it is no longer a rollback target.
--
-- 1. Every MORTGAGE row still null takes the type its flags denote, with the
--    Phase 1 backfill CASE (spec table 4.2; a NULL flag reads as false): a
--    1.19.x rollback after the default migration may have written one. Guarded
--    on the flags existing, so a fresh install (schema.sql has no flags) and a
--    re-apply skip it.
-- 2. Every other null row takes the default.
-- 3. NOT NULL, then 4. both flags dropped. Every statement is a no-op on
--    re-apply.
DO $$
BEGIN
    IF (
        SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'accounts'
          AND column_name IN ('is_canadian_mortgage', 'is_variable_rate')
    ) = 2 THEN
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
  ALTER COLUMN mortgage_type SET NOT NULL;

ALTER TABLE accounts DROP COLUMN IF EXISTS is_canadian_mortgage;
ALTER TABLE accounts DROP COLUMN IF EXISTS is_variable_rate;

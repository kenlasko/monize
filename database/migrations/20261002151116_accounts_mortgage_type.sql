-- Mortgage type (docs/specs/mortgage-types.md, task P1-B1): one column naming a
-- mortgage's compounding convention and amortization method, replacing the
-- is_canadian_mortgage / is_variable_rate pair in later releases.
--
-- Expand only. The column is nullable with no default, so a row written by a
-- previous-release pod during the rolling deploy stays null and is read through
-- mortgageTypeFromFlags rather than as a wrong 'ANNUITY'. It becomes
-- NOT NULL DEFAULT 'ANNUITY' in the contract migration (P3-B1).
--
-- Backfill per spec table 4.2: Canadian and not variable is 'CANADIAN_FIXED'
-- (the only population getPeriodicRate puts on semi-annual compounding); every
-- other MORTGAGE row is 'ANNUITY'; non-mortgage rows stay null. No account's
-- payment, split or effective rate changes. Both booleans are nullable and the
-- code reads a null as false (isCanadian && !isVariableRate), so a Canadian row
-- with a null is_variable_rate is fixed today and is backfilled as such.
-- 'LINEAR' and 'INTEREST_ONLY' are accepted by the CHECK now so Phase 2 needs
-- no second migration to widen it.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS mortgage_type VARCHAR(20);

-- The backfill runs only while the flags exist: the contract migration
-- (20261003152748_accounts_mortgage_type_required.sql) drops them, and a fresh
-- install replays this file on top of a schema.sql that no longer has them.
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

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_mortgage_type_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_mortgage_type_check
  CHECK (mortgage_type IN ('ANNUITY', 'CANADIAN_FIXED', 'LINEAR', 'INTEREST_ONLY'));

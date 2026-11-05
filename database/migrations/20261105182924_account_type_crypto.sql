-- CRYPTO account type (docs/specs/crypto-accounts.md)
--
-- A cryptocurrency wallet recorded the way a chequing account is: an account
-- denominated in one coin (a currency whose kind is CRYPTO), with a register,
-- transfers, scheduled transactions and reconciliation. INV-CRYPTO-001 (the
-- account type and the currency kind agree) is held by
-- assertAccountCurrencyKind in backend/src/accounts/account-currency-kind.util.ts.
--
-- ADD VALUE IF NOT EXISTS is idempotent, and the value is not used within this
-- migration (PostgreSQL refuses a new enum value in the transaction that added
-- it), so running inside the migration runner's transaction is safe on
-- PostgreSQL 16.

ALTER TYPE account_type ADD VALUE IF NOT EXISTS 'CRYPTO';

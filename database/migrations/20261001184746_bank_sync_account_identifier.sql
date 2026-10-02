-- Bank sync: remember each bank account's full identifier and its account type
-- (docs/specs/bank-sync.md sections 4 and 5a, tasks BS16 and BS19).
--
-- Pure expand: two nullable columns on bank_sync_accounts, nothing existing is
-- altered, so the previous release keeps working against this schema during a
-- rolling deploy (it neither reads nor writes them).
--
--   * account_identifier: the IBAN, else the BBAN or another scheme's number,
--     normalized by the application (spaces and dashes removed, upper case).
--     It has the same sensitivity as accounts.account_number, which Monize
--     already stores; identifier_masked stays the value shown in lists. It is
--     what a bank account is matched to a Monize account by.
--   * cash_account_type: the provider's cash account type (CACC, CARD, SVGS,
--     LOAN, ...), upper-case letters, so the UI can name the account's type and
--     warn when a card is linked to a chequing account.
--
-- Rows that exist before this migration keep NULL in both; the "match by
-- account number" action reads them from the provider on request.
ALTER TABLE bank_sync_accounts
    ADD COLUMN IF NOT EXISTS account_identifier VARCHAR(64),
    ADD COLUMN IF NOT EXISTS cash_account_type VARCHAR(10);

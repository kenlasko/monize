-- A currency is either fiat or a cryptocurrency, and a cryptocurrency names the
-- Yahoo pair it is priced from (docs/specs/crypto-accounts.md, decisions 1, 2).
--
-- currencies.kind is FIAT for every existing row (the column default) and
-- decides behaviour: a CRYPTO currency is the currency of CRYPTO accounts only
-- (INV-CRYPTO-001) and is priced by the crypto exchange rate provider.
-- currencies.quote_symbol is the <COIN>-<FIAT> symbol a coin is priced from
-- (BTC-EUR), NULL on every FIAT row; a CRYPTO row without one is an unpriced
-- coin.
--
-- Expand only: both columns are new, kind carries a default so the previous
-- release's inserts keep working, and quote_symbol is nullable. Idempotent:
-- ADD COLUMN IF NOT EXISTS, and each CHECK is dropped before it is added.
ALTER TABLE currencies ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'FIAT';

ALTER TABLE currencies DROP CONSTRAINT IF EXISTS currencies_kind_check;
ALTER TABLE currencies ADD CONSTRAINT currencies_kind_check
    CHECK (kind IN ('FIAT', 'CRYPTO'));

ALTER TABLE currencies ADD COLUMN IF NOT EXISTS quote_symbol VARCHAR(20);

ALTER TABLE currencies DROP CONSTRAINT IF EXISTS currencies_quote_symbol_crypto_only;
ALTER TABLE currencies ADD CONSTRAINT currencies_quote_symbol_crypto_only
    CHECK (kind = 'CRYPTO' OR quote_symbol IS NULL);

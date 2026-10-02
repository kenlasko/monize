-- Bank sync (Open Banking / PSD2 through a regulated aggregator; the first
-- provider is Enable Banking): four user-owned tables
-- (docs/specs/bank-sync.md section 4, task BS2).
--
-- Pure expand: four new tables, nothing existing is altered, so the previous
-- release keeps working against this schema during a rolling deploy.
--
-- bank_sync_credentials
--   * One row per user and provider: the provider application the user
--     registered. private_key_enc is the RSA private key encrypted with
--     EncryptionService (AES-256-GCM); it is never returned to a client and the
--     column is deliberately not named api_key_enc (INV-BANKSYNC-002).
--
-- bank_sync_connections
--   * One authorization of one user at one institution. auth_state_hash is the
--     SHA-256 hex of the one-time OAuth state; clearing it is the claim that
--     makes a replayed callback find nothing. psu_type is kept so a
--     re-authorization asks for the same kind of access.
--
-- bank_sync_accounts
--   * One account a connection can read, mapped to at most one Monize account.
--     account_id is ON DELETE SET NULL: deleting the Monize account unlinks the
--     bank account, it does not delete the bank's account row.
--   * A linked row always has a cut-off date (sync_from_date), enforced by a
--     CHECK. bank_balance is NUMERIC(20,4), the money precision; it is what the
--     bank reported and never writes accounts.current_balance.
--
-- bank_sync_imported_transactions
--   * The ledger behind INV-BANKSYNC-001 (a bank transaction is imported into a
--     Monize account at most once): UNIQUE (account_id, external_key). It is
--     keyed on the Monize account, not the connection, so disconnecting and
--     reconnecting a bank does not re-import history. transaction_id is
--     ON DELETE SET NULL: a deleted Monize transaction keeps its ledger row, so
--     the next sync does not bring it back.
--
-- Defaults on provider, psu_type, status, auto_sync and the counters are
-- deliberate: the RLS enforcement spec's generic row seeder invents a `t<n>`
-- string for a text column with no default, which the enumerated CHECKs below
-- would reject. The application always writes these columns explicitly.
--
-- All four tables are user-owned: the ordinary direct policy, and the enable in
-- this file (database/CLAUDE.md, Row-level security rule 1).

CREATE TABLE IF NOT EXISTS bank_sync_credentials (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(30) NOT NULL DEFAULT 'enable_banking',
    application_id VARCHAR(100) NOT NULL,
    private_key_enc TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_bank_sync_credentials_provider
      CHECK (provider IN ('enable_banking')),
    CONSTRAINT uq_bank_sync_credentials_user_provider
      UNIQUE (user_id, provider)
);

CREATE TABLE IF NOT EXISTS bank_sync_connections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(30) NOT NULL DEFAULT 'enable_banking',
    institution_name VARCHAR(255) NOT NULL,
    institution_country VARCHAR(2) NOT NULL,
    psu_type VARCHAR(20) NOT NULL DEFAULT 'personal',
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    auth_state_hash VARCHAR(64),
    auth_started_at TIMESTAMPTZ,
    external_session_id VARCHAR(255),
    valid_until TIMESTAMPTZ,
    auto_sync BOOLEAN NOT NULL DEFAULT true,
    last_error VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_bank_sync_connections_provider
      CHECK (provider IN ('enable_banking')),
    CONSTRAINT ck_bank_sync_connections_psu_type
      CHECK (psu_type IN ('personal', 'business')),
    CONSTRAINT ck_bank_sync_connections_status
      CHECK (status IN ('pending', 'active', 'expired', 'revoked', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_bank_sync_connections_user
    ON bank_sync_connections(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_sync_connections_auth_state
    ON bank_sync_connections(auth_state_hash)
    WHERE auth_state_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS bank_sync_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL REFERENCES bank_sync_connections(id) ON DELETE CASCADE,
    external_account_id VARCHAR(255) NOT NULL,
    identification_hash VARCHAR(255),
    display_name VARCHAR(255),
    identifier_masked VARCHAR(50),
    currency_code VARCHAR(3),
    account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    sync_from_date DATE,
    last_synced_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_sync_status VARCHAR(20),
    last_sync_error VARCHAR(500),
    last_imported_count INTEGER NOT NULL DEFAULT 0,
    last_skipped_count INTEGER NOT NULL DEFAULT 0,
    last_refused_count INTEGER NOT NULL DEFAULT 0,
    bank_balance NUMERIC(20,4),
    bank_balance_currency VARCHAR(3),
    bank_balance_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_bank_sync_accounts_last_sync_status
      CHECK (last_sync_status IS NULL OR last_sync_status IN ('succeeded', 'failed')),
    CONSTRAINT ck_bank_sync_accounts_linked_has_cutoff
      CHECK (account_id IS NULL OR sync_from_date IS NOT NULL),
    CONSTRAINT ck_bank_sync_accounts_counts
      CHECK (last_imported_count >= 0 AND last_skipped_count >= 0 AND last_refused_count >= 0),
    CONSTRAINT uq_bank_sync_accounts_connection_external
      UNIQUE (connection_id, external_account_id)
);

CREATE INDEX IF NOT EXISTS idx_bank_sync_accounts_user
    ON bank_sync_accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_sync_accounts_account
    ON bank_sync_accounts(account_id)
    WHERE account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bank_sync_imported_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    external_key VARCHAR(255) NOT NULL,
    transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
    booking_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_bank_sync_imported_transactions_key
      UNIQUE (account_id, external_key)
);

CREATE INDEX IF NOT EXISTS idx_bank_sync_imported_transactions_user
    ON bank_sync_imported_transactions(user_id);
-- The ON DELETE SET NULL above scans this column whenever a transaction row is
-- deleted; without the index that is a sequential scan of the ledger.
CREATE INDEX IF NOT EXISTS idx_bank_sync_imported_transactions_transaction
    ON bank_sync_imported_transactions(transaction_id)
    WHERE transaction_id IS NOT NULL;

-- The touch trigger every sibling table with an updated_at column has.
DROP TRIGGER IF EXISTS update_bank_sync_credentials_updated_at ON bank_sync_credentials;
CREATE TRIGGER update_bank_sync_credentials_updated_at
  BEFORE UPDATE ON bank_sync_credentials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_bank_sync_connections_updated_at ON bank_sync_connections;
CREATE TRIGGER update_bank_sync_connections_updated_at
  BEFORE UPDATE ON bank_sync_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_bank_sync_accounts_updated_at ON bank_sync_accounts;
CREATE TRIGGER update_bank_sync_accounts_updated_at
  BEFORE UPDATE ON bank_sync_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE bank_sync_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_sync_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_sync_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_sync_imported_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bank_sync_credentials_isolation ON bank_sync_credentials;
CREATE POLICY bank_sync_credentials_isolation ON bank_sync_credentials
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

DROP POLICY IF EXISTS bank_sync_connections_isolation ON bank_sync_connections;
CREATE POLICY bank_sync_connections_isolation ON bank_sync_connections
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

DROP POLICY IF EXISTS bank_sync_accounts_isolation ON bank_sync_accounts;
CREATE POLICY bank_sync_accounts_isolation ON bank_sync_accounts
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

DROP POLICY IF EXISTS bank_sync_imported_transactions_isolation ON bank_sync_imported_transactions;
CREATE POLICY bank_sync_imported_transactions_isolation ON bank_sync_imported_transactions
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

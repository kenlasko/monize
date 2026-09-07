-- Monize - Database Schema
-- PostgreSQL Schema for Microsoft Money replacement

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS pg_trgm; -- trigram indexes for transaction search

-- Schema migration tracking (used by db-migrate to track applied migrations)
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Users and Authentication
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE, -- NULL allowed for OIDC users without email
    password_hash VARCHAR(255), -- NULL for OIDC-only users
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    auth_provider VARCHAR(50) DEFAULT 'local', -- 'local', 'oidc'
    oidc_subject VARCHAR(255) UNIQUE,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP,
    last_activity_at TIMESTAMP, -- updated fire-and-forget on every authenticated request (throttled in the request interceptor) so emergency access treats "browsing the app" as resetting the dormancy timer
    reset_token VARCHAR(255),
    reset_token_expiry TIMESTAMP,
    email_verified BOOLEAN NOT NULL DEFAULT false, -- gates local login; new self-service registrants must verify their email when SMTP is enabled (bootstrap/admin/delegate/OIDC accounts are created verified)
    email_verification_token VARCHAR(255), -- hashed token emailed for email verification
    email_verification_token_expiry TIMESTAMP,
    role VARCHAR(20) NOT NULL DEFAULT 'user', -- 'admin', 'user'
    must_change_password BOOLEAN NOT NULL DEFAULT false,
    two_factor_secret VARCHAR(255), -- encrypted TOTP secret for 2FA
    pending_two_factor_secret VARCHAR(255), -- staged secret during 2FA setup
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMP,
    backup_codes TEXT,
    oidc_link_pending BOOLEAN NOT NULL DEFAULT false,
    oidc_link_token VARCHAR(255),
    oidc_link_expires_at TIMESTAMP,
    pending_oidc_subject VARCHAR(255),
    is_delegate_only BOOLEAN NOT NULL DEFAULT false, -- true when the row exists solely as an owner-managed delegate identity (created via Shared Access, never claimed via /register)
    backup_encryption_enabled BOOLEAN NOT NULL DEFAULT false,
    backup_password_enc TEXT -- backup password (login password for local, dedicated password for OIDC) encrypted with ENCRYPTION_KEY for auto-backup use
);

CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token) WHERE reset_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_email_verification_token ON users(email_verification_token) WHERE email_verification_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_oidc_link_token ON users(oidc_link_token) WHERE oidc_link_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_last_activity_at ON users(last_activity_at) WHERE last_activity_at IS NOT NULL;

-- Currencies
CREATE TABLE currencies (
    code VARCHAR(3) PRIMARY KEY, -- ISO 4217 code (USD, CAD, EUR, etc)
    name VARCHAR(100) NOT NULL,
    symbol VARCHAR(10) NOT NULL,
    decimal_places SMALLINT DEFAULT 2,
    is_active BOOLEAN DEFAULT true,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL, -- NULL = system currency
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Per-user currency preferences (visibility + is_active)
CREATE TABLE user_currency_preferences (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code) ON DELETE CASCADE,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, currency_code)
);

CREATE INDEX idx_ucp_user ON user_currency_preferences(user_id);
CREATE INDEX idx_ucp_currency ON user_currency_preferences(currency_code);

-- Exchange Rates (historical data)
CREATE TABLE exchange_rates (
    id BIGSERIAL PRIMARY KEY,
    from_currency VARCHAR(3) REFERENCES currencies(code),
    to_currency VARCHAR(3) REFERENCES currencies(code),
    rate NUMERIC(20, 10) NOT NULL,
    rate_date DATE NOT NULL,
    source VARCHAR(50), -- API source name
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(from_currency, to_currency, rate_date)
);

CREATE INDEX idx_exchange_rates_date ON exchange_rates(rate_date DESC);
CREATE INDEX idx_exchange_rates_currencies ON exchange_rates(from_currency, to_currency);

-- Account Types
CREATE TYPE account_type AS ENUM (
    'CHEQUING',
    'SAVINGS',
    'CREDIT_CARD',
    'LOAN',
    'MORTGAGE',
    'INVESTMENT',
    'CASH',
    'LINE_OF_CREDIT',
    'ASSET',
    'OTHER'
);

-- Accounts
CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_type account_type NOT NULL,
    account_sub_type VARCHAR(50), -- 'INVESTMENT_CASH', 'INVESTMENT_BROKERAGE' for linked investment pairs
    linked_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL, -- links cash <-> brokerage accounts
    name VARCHAR(255) NOT NULL,
    description TEXT,
    currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code),
    account_number VARCHAR(100), -- masked/encrypted
    institution VARCHAR(255), -- legacy free-text institution name (superseded by institution_id)
    institution_id UUID, -- structured financial institution (FK added after institutions table)
    opening_balance NUMERIC(20, 4) DEFAULT 0,
    current_balance NUMERIC(20, 4) DEFAULT 0,
    credit_limit NUMERIC(20, 4), -- for credit cards
    interest_rate NUMERIC(8, 4), -- for loans, mortgages, savings
    -- Credit card statement fields (constraints named to match migrations 027/028
    -- so fresh installs and upgraded installs produce the same constraint set)
    statement_due_day INTEGER, -- day of month payment is due (credit cards only)
    statement_settlement_day INTEGER, -- last day of billing cycle (credit cards only)
    is_closed BOOLEAN DEFAULT false,
    closed_date DATE,
    -- Balance-threshold alerts (migration 187; docs/specs/balance-threshold-notifications.md).
    -- Thresholds in the account's own currency (NULL = off); the *_armed latches
    -- make the crossing rule hold across evaluations (a CAS, INV-BALANCE-002).
    low_balance_threshold NUMERIC(20, 4),
    high_balance_threshold NUMERIC(20, 4),
    low_alert_armed BOOLEAN NOT NULL DEFAULT false,
    high_alert_armed BOOLEAN NOT NULL DEFAULT false,
    is_favourite BOOLEAN DEFAULT false,
    favourite_sort_order INTEGER DEFAULT 0,
    exclude_from_net_worth BOOLEAN DEFAULT false,
    -- Loan-specific fields
    payment_amount NUMERIC(20, 4), -- payment amount per period for loans
    extra_payment_amount NUMERIC(20, 4), -- standing extra-principal instruction inside that payment
    payment_frequency VARCHAR(20), -- 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'
    payment_start_date DATE, -- when loan payments start
    source_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL, -- account payments come from
    principal_category_id UUID, -- category for principal portion (FK added after categories table)
    interest_category_id UUID, -- category for interest portion (FK added after categories table)
    interest_booking_mode VARCHAR(16) NOT NULL DEFAULT 'AUTO', -- how interest is recorded for rate detection: AUTO | SPLIT | SEPARATE
    overpayment_category_id UUID, -- category tagging standalone overpayments/extra principal (FK added after categories table)
    overpayment_memo VARCHAR(255), -- memo text marking a payment as a standalone overpayment (case-insensitive substring match)
    overpayment_payee_id UUID, -- payee whose payments count as standalone overpayments/extra principal (FK added after payees table)
    -- Foreign-transaction fee: the bank's FX conversion fee (a percentage) folded
    -- into the converted amount on foreign-entered transactions.
    fx_fee_percent NUMERIC(8, 4), -- foreign-currency conversion fee as a percentage
    scheduled_transaction_id UUID, -- linked scheduled transaction for payments (FK added after scheduled_transactions table)
    -- Asset-specific fields
    asset_category_id UUID, -- category for tracking value changes on asset accounts (FK added after categories table)
    date_acquired DATE, -- date the asset was acquired (for net worth historical accuracy)
    linked_loan_account_id UUID, -- asset's financing loan/mortgage (self-referential FK added below; for the equity view)
    -- Mortgage-specific fields
    is_canadian_mortgage BOOLEAN DEFAULT false, -- Canadian mortgages use semi-annual compounding for fixed rates
    is_variable_rate BOOLEAN DEFAULT false, -- Variable rate mortgages use monthly compounding
    term_months INTEGER, -- Mortgage term length in months (e.g., 60 for 5-year term)
    term_end_date DATE, -- When the current term ends (for renewal reminders)
    amortization_months INTEGER, -- Total amortization period in months (e.g., 300 for 25 years)
    original_principal NUMERIC(20, 4), -- Original mortgage amount for reference
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_statement_due_day
      CHECK (statement_due_day IS NULL OR (statement_due_day >= 1 AND statement_due_day <= 31)),
    CONSTRAINT chk_statement_settlement_day
      CHECK (statement_settlement_day IS NULL OR (statement_settlement_day >= 1 AND statement_settlement_day <= 31)),
    CONSTRAINT chk_statement_due_day_cc_only
      CHECK (account_type = 'CREDIT_CARD' OR statement_due_day IS NULL),
    CONSTRAINT chk_statement_settlement_day_cc_only
      CHECK (account_type = 'CREDIT_CARD' OR statement_settlement_day IS NULL)
);

CREATE INDEX idx_accounts_user ON accounts(user_id);
CREATE INDEX idx_accounts_type ON accounts(account_type);
CREATE INDEX idx_accounts_account_sub_type ON accounts(account_sub_type);
CREATE INDEX idx_accounts_linked_account_id ON accounts(linked_account_id);
CREATE INDEX idx_accounts_linked_loan_account_id ON accounts(linked_loan_account_id);
CREATE INDEX idx_accounts_asset_category ON accounts(asset_category_id);
CREATE INDEX idx_accounts_term_end_date ON accounts(term_end_date) WHERE account_type = 'MORTGAGE' AND term_end_date IS NOT NULL;
CREATE INDEX idx_accounts_interest_category ON accounts(interest_category_id);
CREATE INDEX idx_accounts_principal_category ON accounts(principal_category_id);
CREATE INDEX idx_accounts_overpayment_category ON accounts(overpayment_category_id);
CREATE INDEX idx_accounts_overpayment_payee ON accounts(overpayment_payee_id);
CREATE INDEX idx_accounts_scheduled_transaction ON accounts(scheduled_transaction_id);
CREATE INDEX idx_accounts_source_account ON accounts(source_account_id);
CREATE INDEX idx_accounts_institution ON accounts(institution_id);

-- Categories for transactions
CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES categories(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    icon VARCHAR(50),
    color VARCHAR(7), -- hex color
    is_income BOOLEAN DEFAULT false,
    is_system BOOLEAN DEFAULT false, -- system categories can't be deleted
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name, parent_id)
);

CREATE INDEX idx_categories_user ON categories(user_id);
CREATE INDEX idx_categories_parent ON categories(parent_id);
CREATE INDEX idx_categories_name_trgm ON categories USING gin (name gin_trgm_ops);

-- Payees
CREATE TABLE payees (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    default_category_id UUID REFERENCES categories(id),
    notes TEXT,
    website VARCHAR(2048), -- the payee's site; stored absolute (https unless an explicit http:// was given)
    -- Brand icon: the website's favicon, fetched server-side and cached here so
    -- the browser never contacts a third party to render it. Same four columns
    -- and same semantics as institutions.
    logo_data BYTEA,
    logo_content_type VARCHAR(100),
    has_logo BOOLEAN NOT NULL DEFAULT false,
    logo_fetched_at TIMESTAMP,
    -- Contact information. address is free text (one field, not structured
    -- parts) because formats are locale-specific and its only consumer is a
    -- maps link that takes a single query string. phone is stored in ONE form
    -- whichever surface wrote it -- E.164 with an optional RFC 3966 extension
    -- suffix (+12064488762, +442079460958;ext=12) -- so two records of the same
    -- number compare equal and a tel: link dials the same digits either way.
    -- Rows written before that rule are deliberately not backfilled: they hold
    -- whatever was typed until the payee is next saved, so a reader must format
    -- through formatPhoneForDisplay rather than assume the shape.
    address TEXT,
    email VARCHAR(255),
    phone VARCHAR(50),
    -- Provenance for contact details a lookup wrote rather than the user.
    -- contact_lookup_at stamps an attempt that got an answer (found something
    -- or established there was nothing), so the background enrichment runs at
    -- most once per payee (its UPDATE is keyed on contact_lookup_at IS NULL).
    -- contact_lookup_source is set only when at least one field was actually
    -- written by a lookup; the detail page's badge keys off it.
    contact_lookup_at TIMESTAMPTZ,
    contact_lookup_source VARCHAR(32),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name),
    CONSTRAINT payees_contact_lookup_source_check
      CHECK (contact_lookup_source IS NULL
             OR contact_lookup_source IN ('ai-web-search','ai-knowledge','ai-relay','google-places'))
);

CREATE INDEX idx_payees_user ON payees(user_id);
CREATE INDEX idx_payees_user_active ON payees(user_id, is_active);
CREATE INDEX idx_payees_name_trgm ON payees USING gin (name gin_trgm_ops);

-- Payee Aliases (for mapping imported payee names to canonical payees)
CREATE TABLE payee_aliases (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payee_id UUID NOT NULL REFERENCES payees(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alias VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_payee_aliases_payee ON payee_aliases(payee_id);
CREATE INDEX idx_payee_aliases_user ON payee_aliases(user_id);
CREATE UNIQUE INDEX idx_payee_aliases_user_alias ON payee_aliases(user_id, LOWER(alias));

-- Financial Institutions (per-user registry of banks/brokerages). The brand
-- icon is the website's favicon, fetched server-side and cached in logo_data so
-- the browser never contacts a third party to render it.
CREATE TABLE institutions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    website TEXT NOT NULL,
    country VARCHAR(2),
    logo_data BYTEA,
    logo_content_type VARCHAR(100),
    has_logo BOOLEAN NOT NULL DEFAULT false,
    logo_fetched_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name)
);

CREATE INDEX idx_institutions_user ON institutions(user_id);

-- Transactions
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    transaction_date DATE NOT NULL,
    payee_id UUID REFERENCES payees(id),
    payee_name VARCHAR(255), -- can be different from payee.name
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL, -- category for non-split transactions
    amount NUMERIC(20, 4) NOT NULL, -- positive for income/deposits, negative for expenses
    currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code),
    exchange_rate NUMERIC(20, 10) DEFAULT 1, -- rate at transaction time (account-currency units per 1 unit of original currency for foreign entry)
    -- Foreign-currency entry: amount actually paid, stored alongside the
    -- account-currency amount. NULL for ordinary transactions.
    original_amount NUMERIC(20, 4), -- amount as typed in the original currency
    original_currency_code VARCHAR(3) CONSTRAINT fk_transactions_original_currency REFERENCES currencies(code), -- currency actually paid in
    description TEXT,
    reference_number VARCHAR(100), -- check number, confirmation number, etc
    reconciled_date DATE,
    status VARCHAR(20) DEFAULT 'UNRECONCILED', -- 'UNRECONCILED', 'CLEARED', 'RECONCILED', 'VOID'
    is_split BOOLEAN DEFAULT false, -- indicates this is a split transaction
    parent_transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE, -- for split children
    is_transfer BOOLEAN DEFAULT false, -- indicates this is part of an account-to-account transfer
    linked_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL, -- links the paired transfer transaction
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_transactions_user ON transactions(user_id);
CREATE INDEX idx_transactions_account ON transactions(account_id);
CREATE INDEX idx_transactions_date ON transactions(transaction_date DESC);
CREATE INDEX idx_transactions_payee ON transactions(payee_id);
CREATE INDEX idx_transactions_category ON transactions(category_id);
CREATE INDEX idx_transactions_parent ON transactions(parent_transaction_id);
CREATE INDEX idx_transactions_linked ON transactions(linked_transaction_id);
CREATE INDEX idx_transactions_original_currency ON transactions(original_currency_code);
-- Trigram indexes accelerate the register/report search (ILIKE '%term%')
CREATE INDEX idx_transactions_payee_name_trgm ON transactions USING gin (payee_name gin_trgm_ops);
CREATE INDEX idx_transactions_description_trgm ON transactions USING gin (description gin_trgm_ops);

-- Transaction Splits (details for split transactions)
CREATE TABLE transaction_splits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    kind VARCHAR(20) NOT NULL DEFAULT 'category', -- 'category', 'transfer', or 'investment'
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    transfer_account_id UUID REFERENCES accounts(id) ON DELETE CASCADE, -- target account for transfer splits
    linked_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL, -- linked transaction in target account
    amount NUMERIC(20, 4) NOT NULL,
    memo TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_split_kind_exclusive CHECK (
        (kind = 'category'   AND transfer_account_id IS NULL) OR
        (kind = 'transfer'   AND transfer_account_id IS NOT NULL AND category_id IS NULL) OR
        (kind = 'investment' AND category_id IS NULL AND transfer_account_id IS NULL)
    )
);

CREATE INDEX idx_transaction_splits_transaction ON transaction_splits(transaction_id);
CREATE INDEX idx_transaction_splits_category ON transaction_splits(category_id);
CREATE INDEX idx_transaction_splits_transfer_account ON transaction_splits(transfer_account_id);
CREATE INDEX idx_transaction_splits_linked ON transaction_splits(linked_transaction_id);

-- Transaction Attachments: receipts/invoices/documents stored in Postgres by
-- default. Metadata lives here; the bytes live in attachment_blobs (database
-- provider) or an external store keyed by storage_key. See migration 109.
CREATE TABLE transaction_attachments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    content_type VARCHAR(100) NOT NULL, -- server-sniffed MIME, not the client's claim
    byte_size BIGINT NOT NULL,
    sha256 CHAR(64) NOT NULL, -- hex digest of the original bytes (integrity + dedup)
    storage_provider VARCHAR(20) NOT NULL DEFAULT 'database', -- 'database' | 'local' | 's3'
    storage_key VARCHAR(512) NOT NULL, -- database/local: attachment id; s3: object key
    -- Set on the unprocessed original of a scanned document, pointing at the
    -- visible (enhanced) attachment; NULL for every attachment a user sees.
    -- The link lives on the original so deleting the visible row cascades to
    -- it. See docs/future-plans/document-scanner.md.
    original_of_attachment_id UUID NULL REFERENCES transaction_attachments(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_attachment_not_own_original
        CHECK (original_of_attachment_id IS NULL OR original_of_attachment_id <> id)
);

CREATE INDEX idx_transaction_attachments_transaction ON transaction_attachments(transaction_id);
CREATE INDEX idx_transaction_attachments_user ON transaction_attachments(user_id);
-- At most one original per attachment: a scan pair is exactly two rows.
CREATE UNIQUE INDEX uq_transaction_attachments_original_of
    ON transaction_attachments(original_of_attachment_id)
    WHERE original_of_attachment_id IS NOT NULL;

-- Attachment bytes for the built-in database storage provider. Kept in a
-- separate table so the metadata table (and its list queries) never touch BYTEA.
CREATE TABLE attachment_blobs (
    attachment_id UUID PRIMARY KEY REFERENCES transaction_attachments(id) ON DELETE CASCADE,
    data BYTEA NOT NULL
);

-- Attachment objects whose metadata is gone and whose bytes still need deleting
-- (migration 140).
--
-- Only the database provider keeps bytes where PostgreSQL can roll them back. A
-- local filesystem write and an S3 put cannot join the transaction, so deleting
-- the object before the metadata delete committed left metadata pointing at bytes
-- that no longer existed. And deleting a transaction removes its attachment
-- metadata by ON DELETE CASCADE with no application code running at all, so
-- those objects were never deleted.
--
-- A trigger writes the tombstone, which is why it covers every path the
-- application does not control.
--
-- NOTE: there is no sweeper yet. This half of the protocol -- the durable record
-- that an external object was orphaned -- ships on its own, and nothing reads the
-- table. Said plainly here because the previous wording named an
-- `AttachmentOrphanSweeper` that does not exist, and a comment asserting a
-- component into being is how the missing half stops being noticed. Until a
-- consumer lands, these rows accumulate (slowly: the trigger fires only for
-- providers other than `database`) and reclaiming the bytes is a manual job.
--
-- Two things whatever sweeper eventually lands must do, both consequences of the
-- unique key below:
--   * re-check `transaction_attachments` for a live row with the same
--     (storage_provider, storage_key) before deleting anything. A tombstone is
--     keyed by object, not by attachment, so an object deleted and later
--     re-uploaded under the same key has one tombstone and one live attachment,
--     and deleting the bytes would destroy the live one.
--   * delete the object first and the row second, so a crash between the two
--     costs a retry rather than a leaked object -- the ordering rule in the root
--     CLAUDE.md.
--
-- user_id is ON DELETE SET NULL, not CASCADE: deleting a user is exactly when
-- their bytes most need removing, so the record must outlive them.
CREATE TABLE attachment_blob_tombstones (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    storage_provider VARCHAR(20) NOT NULL,
    storage_key VARCHAR(255) NOT NULL,
    deleted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Non-NULL marks this row as an upload still in flight and says until when
    -- (migration 146). The sweeper skips a live lease, which is a *latency*
    -- mechanism: it exists so the sweep does not cause avoidable upload failures.
    -- NULL means an ordinary deletion record, swept immediately.
    upload_lease_expires_at TIMESTAMP,
    -- The sweeper's claim, set by a conditional UPDATE *before* the external
    -- delete. This is the *correctness* mechanism: the uploader's "clear the
    -- intent" step requires `swept_at IS NULL` inside the transaction that commits
    -- the metadata row, so metadata pointing at deleted bytes is impossible
    -- whichever of the two wins the row (audit RV4-002).
    swept_at TIMESTAMP,
    -- How long a swept *upload intent* is kept after its object was deleted
    -- (migration 147). The fence above is about metadata; this is about bytes. A
    -- put that stalled past its lease can land after the sweep deleted the key, and
    -- a process killed before its compensating delete leaves those bytes with no
    -- tombstone to enumerate them -- unreferenced and undiscoverable (audit
    -- RRV4-002). Keeping the row until this passes means the next hourly sweep
    -- re-deletes the key and only then retires the row. NULL on an ordinary
    -- deletion record, whose metadata is already gone, so nothing can write those
    -- bytes again.
    late_write_quarantine_until TIMESTAMP,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);

-- The sweeper's candidate predicate: rows with no live upload lease. A quarantined
-- row is found again through this same arm, because the claim that quarantined it
-- also cleared the lease -- which is why `late_write_quarantine_until` carries no
-- index of its own (migration 145): nothing selects on it.
CREATE INDEX idx_abt_sweepable
    ON attachment_blob_tombstones(storage_provider, deleted_at)
    WHERE upload_lease_expires_at IS NULL;

-- Unique, so a tombstone is idempotent: two records for one object describe the
-- same pending deletion, and the trigger can therefore be a plain
-- ON CONFLICT DO NOTHING insert with no bookkeeping of its own.
CREATE UNIQUE INDEX idx_abt_object
    ON attachment_blob_tombstones(storage_provider, storage_key);
CREATE INDEX idx_abt_deleted_at ON attachment_blob_tombstones(deleted_at);

-- SECURITY DEFINER so the tombstone is written as the table owner: under RLS the
-- trigger would otherwise insert as the invoking role and be refused whenever the
-- deleted row's owner is not the session's identity, and a refused trigger fails
-- the DELETE itself. search_path is pinned -- a SECURITY DEFINER function that
-- resolves its tables through the caller's search_path is an escalation hole.
CREATE OR REPLACE FUNCTION record_attachment_blob_tombstone() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    INSERT INTO attachment_blob_tombstones (user_id, storage_provider, storage_key)
    VALUES (OLD.user_id, OLD.storage_provider, OLD.storage_key)
    ON CONFLICT (storage_provider, storage_key) DO NOTHING;
    RETURN OLD;
END;
$$;

-- Only for providers whose bytes live outside PostgreSQL. The database provider
-- keeps them in attachment_blobs, whose own foreign key cascades.
CREATE TRIGGER trg_attachment_blob_tombstone
    AFTER DELETE ON transaction_attachments
    FOR EACH ROW
    WHEN (OLD.storage_provider <> 'database')
    EXECUTE FUNCTION record_attachment_blob_tombstone();

-- Late-write quarantine enforcement (migration 148). The sweeper's claim settles
-- what metadata may commit, not what bytes exist: a put stalled past its lease can
-- land after the key was deleted. The quarantine is a rule spread across the claim,
-- the retire and the uploader's compensating clear, and these two triggers are what
-- make a forgotten predicate in any of them fail loudly rather than silently drop a
-- row whose key may still be written. Covers DELETE only -- TRUNCATE fires no
-- row-level trigger.
CREATE OR REPLACE FUNCTION stamp_attachment_quarantine() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    NEW.late_write_quarantine_until := COALESCE(
        NEW.late_write_quarantine_until,
        OLD.late_write_quarantine_until,
        CURRENT_TIMESTAMP + INTERVAL '6 hours'
    );
    RETURN NEW;
END;
$$;

-- On any claim (swept_at NULL -> non-NULL) of a row that was an upload intent (it
-- had a lease), stamp the quarantine if unset. Covers a writer that does not know
-- the column exists; COALESCE lets the application's own value win.
CREATE TRIGGER trg_abt_stamp_quarantine
    BEFORE UPDATE ON attachment_blob_tombstones
    FOR EACH ROW
    WHEN (
      NEW.swept_at IS NOT NULL
      AND OLD.swept_at IS NULL
      AND OLD.upload_lease_expires_at IS NOT NULL
    )
    EXECUTE FUNCTION stamp_attachment_quarantine();

CREATE OR REPLACE FUNCTION reject_quarantined_tombstone_delete() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
      'attachment tombstone % is under late-write quarantine until %; a stalled upload may still write to this key',
      OLD.storage_key, OLD.late_write_quarantine_until
      USING ERRCODE = 'raise_exception';
END;
$$;

-- Reject deletion of a still-quarantined row. retire()/retireKey() exclude such
-- rows by the quarantine and both uploader clears exclude them by `swept_at IS
-- NULL`, so no application path should ever trip this.
CREATE TRIGGER trg_abt_reject_quarantined_delete
    BEFORE DELETE ON attachment_blob_tombstones
    FOR EACH ROW
    WHEN (
      OLD.late_write_quarantine_until IS NOT NULL
      AND OLD.late_write_quarantine_until > CURRENT_TIMESTAMP
    )
    EXECUTE FUNCTION reject_quarantined_tombstone_delete();

-- Tags
CREATE TABLE tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    color VARCHAR(7),
    icon VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_tags_user_name ON tags(user_id, LOWER(name));
CREATE INDEX idx_tags_user ON tags(user_id);

-- Transaction Tags (many-to-many)
CREATE TABLE transaction_tags (
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (transaction_id, tag_id)
);

CREATE INDEX idx_transaction_tags_tag ON transaction_tags(tag_id);
CREATE INDEX idx_transaction_tags_transaction ON transaction_tags(transaction_id);

-- Transaction Split Tags (many-to-many)
CREATE TABLE transaction_split_tags (
    transaction_split_id UUID NOT NULL REFERENCES transaction_splits(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (transaction_split_id, tag_id)
);

CREATE INDEX idx_transaction_split_tags_tag ON transaction_split_tags(tag_id);
CREATE INDEX idx_transaction_split_tags_split ON transaction_split_tags(transaction_split_id);

-- Securities (stocks, bonds, mutual funds, ETFs)
-- Defined before scheduled_transactions because that table (and others below)
-- carry inline FKs to securities(id); the FK target must exist first when the
-- whole schema is applied as a single script on a fresh database.
CREATE TABLE securities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol VARCHAR(20) NOT NULL, -- ticker symbol (unique per user)
    name VARCHAR(255) NOT NULL,
    security_type VARCHAR(50), -- 'STOCK', 'ETF', 'MUTUAL_FUND', 'BOND', etc
    exchange VARCHAR(50), -- 'NYSE', 'NASDAQ', 'TSX', 'TSXV', etc
    currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code),
    description TEXT, -- free-text notes, optionally pre-filled from the quote provider
    is_active BOOLEAN DEFAULT true,
    is_favourite BOOLEAN NOT NULL DEFAULT false, -- pinned to the dashboard Favourite Securities widget
    skip_price_updates BOOLEAN DEFAULT false, -- for auto-generated symbols that can't be looked up
    sector VARCHAR(100),             -- stock sector from Yahoo Finance (e.g. 'Technology')
    industry VARCHAR(100),           -- stock industry (e.g. 'Consumer Electronics')
    sector_weightings JSONB,         -- ETF sector breakdown [{sector, weight}] (weight is a decimal 0-1, from Yahoo)
    country_weightings JSONB,        -- manual ETF/fund country breakdown [{name, weight}] (weight is a decimal 0-1)
    asset_weightings JSONB,          -- manual ETF/fund asset-class breakdown [{name, weight}] (free-text names, weight is a decimal 0-1)
    sector_data_updated_at TIMESTAMP, -- cache staleness check
    website VARCHAR(2048),           -- issuer/product page; auto-filled from Yahoo for shares
    ir_website VARCHAR(2048),        -- investor-relations page; manual, no provider supplies it
    quote_provider VARCHAR(20),      -- per-security provider override: 'yahoo' | 'msn' | NULL = user default
    msn_instrument_id VARCHAR(50),   -- cached MSN Financial Instrument ID (SecId)
    historical_backfill_attempted_at TIMESTAMP, -- last time we asked the provider for a multi-year backfill
    market_timezone VARCHAR(64),     -- IANA zone the instrument trades in, from the provider (e.g. America/New_York)
    market_open_time TIME,           -- start of the regular session, in market_timezone local time
    market_close_time TIME,          -- end of the regular session, in market_timezone local time
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, symbol),
    CONSTRAINT securities_quote_provider_check
      CHECK (quote_provider IS NULL OR quote_provider IN ('yahoo','msn'))
);

CREATE INDEX idx_securities_user_id ON securities(user_id);
CREATE INDEX idx_securities_symbol ON securities(symbol);
CREATE INDEX idx_securities_exchange ON securities(exchange);
CREATE INDEX idx_securities_user_favourite ON securities(user_id, is_favourite);

-- Security Tags (many-to-many) -- reuses the shared tags pool, mirrors transaction_tags
CREATE TABLE security_tags (
    security_id UUID NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (security_id, tag_id)
);

CREATE INDEX idx_security_tags_tag ON security_tags(tag_id);
CREATE INDEX idx_security_tags_security ON security_tags(security_id);

-- Scheduled Transactions (recurring payments / bills & deposits)
CREATE TABLE scheduled_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL, -- display name for the scheduled transaction
    payee_id UUID REFERENCES payees(id),
    payee_name VARCHAR(255),
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    amount NUMERIC(20, 4) NOT NULL,
    currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code),
    -- Foreign-currency entry (mirrors the same trio on transactions). When set,
    -- original_amount is the fixed amount the biller charges in
    -- original_currency_code, and `amount` is the account-currency estimate
    -- derived from it at exchange_rate -- refreshed daily from the latest rate,
    -- and re-derived for the posting date when the occurrence is posted.
    original_amount NUMERIC(20, 4),
    original_currency_code VARCHAR(3) REFERENCES currencies(code),
    exchange_rate NUMERIC(20, 10) NOT NULL DEFAULT 1,
    description TEXT,
    -- 'ONCE', 'DAILY', 'WEEKLY', 'BIWEEKLY', 'EVERY4WEEKS', 'SEMIMONTHLY',
    -- 'MONTHLY', 'EVERY2MONTHS', 'QUARTERLY', 'EVERY4MONTHS', 'SEMIANNUAL',
    -- 'YEARLY', 'EVERY2YEARS'
    -- (backend/src/scheduled-transactions/dto: FrequencyType)
    frequency VARCHAR(20) NOT NULL,
    next_due_date DATE NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE,
    occurrences_remaining INTEGER, -- if set, countdown of remaining occurrences
    total_occurrences INTEGER, -- original total if using occurrence limit
    is_active BOOLEAN DEFAULT true,
    auto_post BOOLEAN DEFAULT false, -- automatically create transaction when due
    -- Bounded (issue #1247 review): this reaches a date computation, and a value
    -- past JavaScript's Date range serialized the reminder window's upper bound
    -- as "NaN-NaN-NaN", which the text-comparing occurrence expander read as an
    -- unlimited window. See MAX_REMINDER_DAYS_BEFORE in
    -- backend/src/scheduled-transactions/reminder-window.ts.
    reminder_days_before INTEGER DEFAULT 3,
    last_posted_date DATE, -- when the transaction was last posted
    is_split BOOLEAN DEFAULT false, -- indicates amounts are split across categories
    is_transfer BOOLEAN DEFAULT false, -- indicates this is an account-to-account transfer
    transfer_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL, -- destination account for transfers
    is_investment BOOLEAN DEFAULT false, -- indicates this posts as an investment transaction (mutually exclusive with is_transfer)
    investment_action VARCHAR(50), -- BUY/SELL/DIVIDEND/REINVEST/INTEREST/CAPITAL_GAIN/SPLIT/TRANSFER_IN/TRANSFER_OUT/ADD_SHARES/REMOVE_SHARES
    investment_security_id UUID REFERENCES securities(id),
    investment_funding_account_id UUID REFERENCES accounts(id), -- alternate cash source (e.g., bank for contribution+buy)
    investment_quantity NUMERIC(20, 8),
    investment_price NUMERIC(24, 10),
    investment_commission NUMERIC(20, 4) DEFAULT 0,
    investment_total_amount NUMERIC(20, 4), -- for amount-only actions (DIVIDEND, INTEREST, CAPITAL_GAIN)
    investment_exchange_rate NUMERIC(20, 10),
    -- Currency pair the stored FX rate was resolved for (issue #1167). NULL on
    -- rows written before the provenance change; posting reuses the rate only
    -- when this pair still matches the current (security, settlement) currencies.
    investment_exchange_rate_from_currency VARCHAR(3),
    investment_exchange_rate_to_currency VARCHAR(3),
    tag_ids JSONB DEFAULT '[]'::jsonb, -- array of tag UUIDs to apply when posting
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_scheduled_transactions_kind_exclusive CHECK (
        NOT (is_transfer = TRUE AND is_investment = TRUE)
    ),
    CONSTRAINT chk_scheduled_reminder_days_before CHECK (
        reminder_days_before IS NULL OR (reminder_days_before BETWEEN 0 AND 366)
    )
);

CREATE INDEX idx_scheduled_transactions_user ON scheduled_transactions(user_id);
CREATE INDEX idx_scheduled_transactions_next_due ON scheduled_transactions(next_due_date);
CREATE INDEX idx_scheduled_transactions_active ON scheduled_transactions(is_active);
CREATE INDEX idx_scheduled_transactions_transfer_account ON scheduled_transactions(transfer_account_id);
CREATE INDEX idx_scheduled_transactions_inv_security ON scheduled_transactions(investment_security_id) WHERE investment_security_id IS NOT NULL;

-- Scheduled Transaction Splits
CREATE TABLE scheduled_transaction_splits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scheduled_transaction_id UUID NOT NULL REFERENCES scheduled_transactions(id) ON DELETE CASCADE,
    kind VARCHAR(20) NOT NULL DEFAULT 'category', -- 'category', 'transfer', or 'investment'
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    transfer_account_id UUID REFERENCES accounts(id) ON DELETE CASCADE, -- target account for transfer splits
    amount NUMERIC(20, 4) NOT NULL,
    memo TEXT,
    -- Investment-split fields (populated when kind='investment'):
    investment_action VARCHAR(50),
    investment_security_id UUID REFERENCES securities(id),
    investment_quantity NUMERIC(20, 8),
    investment_price NUMERIC(24, 10),
    investment_commission NUMERIC(20, 4),
    investment_exchange_rate NUMERIC(20, 10),
    -- Currency pair the stored FX rate was resolved for (issue #1167); see the
    -- matching columns on scheduled_transactions.
    investment_exchange_rate_from_currency VARCHAR(3),
    investment_exchange_rate_to_currency VARCHAR(3),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_scheduled_split_kind_exclusive CHECK (
        (kind = 'category'   AND transfer_account_id IS NULL AND investment_action IS NULL) OR
        (kind = 'transfer'   AND transfer_account_id IS NOT NULL AND category_id IS NULL AND investment_action IS NULL) OR
        (kind = 'investment' AND category_id IS NULL AND transfer_account_id IS NULL AND investment_action IS NOT NULL)
    )
);

CREATE INDEX idx_scheduled_transaction_splits_scheduled ON scheduled_transaction_splits(scheduled_transaction_id);
CREATE INDEX idx_scheduled_transaction_splits_category ON scheduled_transaction_splits(category_id);
CREATE INDEX idx_scheduled_transaction_splits_transfer_account ON scheduled_transaction_splits(transfer_account_id);
CREATE INDEX idx_scheduled_transaction_splits_inv_security ON scheduled_transaction_splits(investment_security_id);

-- Scheduled Transaction Split Tags (many-to-many)
CREATE TABLE scheduled_transaction_split_tags (
    scheduled_transaction_split_id UUID NOT NULL REFERENCES scheduled_transaction_splits(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (scheduled_transaction_split_id, tag_id)
);

CREATE INDEX idx_scheduled_transaction_split_tags_tag ON scheduled_transaction_split_tags(tag_id);
CREATE INDEX idx_scheduled_transaction_split_tags_split ON scheduled_transaction_split_tags(scheduled_transaction_split_id);

-- Add deferred foreign keys for loan accounts (after categories and scheduled_transactions tables exist)
ALTER TABLE accounts ADD CONSTRAINT fk_accounts_principal_category
    FOREIGN KEY (principal_category_id) REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD CONSTRAINT fk_accounts_interest_category
    FOREIGN KEY (interest_category_id) REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD CONSTRAINT fk_accounts_overpayment_category
    FOREIGN KEY (overpayment_category_id) REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD CONSTRAINT fk_accounts_overpayment_payee
    FOREIGN KEY (overpayment_payee_id) REFERENCES payees(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD CONSTRAINT fk_accounts_scheduled_transaction
    FOREIGN KEY (scheduled_transaction_id) REFERENCES scheduled_transactions(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD CONSTRAINT fk_accounts_asset_category
    FOREIGN KEY (asset_category_id) REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD CONSTRAINT fk_accounts_institution
    FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD CONSTRAINT fk_accounts_linked_loan_account
    FOREIGN KEY (linked_loan_account_id) REFERENCES accounts(id) ON DELETE SET NULL;

-- Scheduled Transaction Overrides (for modifying individual occurrences)
CREATE TABLE scheduled_transaction_overrides (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scheduled_transaction_id UUID NOT NULL REFERENCES scheduled_transactions(id) ON DELETE CASCADE,
    original_date DATE NOT NULL, -- The original calculated occurrence date this override replaces
    override_date DATE NOT NULL, -- The actual date for this occurrence (may differ if date was changed)
    amount NUMERIC(20, 4),
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    description TEXT,
    is_split BOOLEAN,
    splits JSONB, -- JSON array of split overrides: [{categoryId, amount, memo}]
    -- Per-occurrence investment overrides (BUY/SELL/REINVEST etc.); NULL means "use base value"
    investment_quantity NUMERIC(20, 8),
    investment_price NUMERIC(24, 10),
    investment_total_amount NUMERIC(20, 4),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    -- An occurrence's IDENTITY is its recurrence slot, so that is what is
    -- unique: `override_date` is the day the occurrence was moved TO, an
    -- attribute of the override rather than its name. Keyed on override_date
    -- (migration 168) this permitted two overrides for one slot -- the posting
    -- then used whichever row the reader's map happened to keep -- and refused
    -- two different occurrences moved onto the same day, which is legitimate.
    CONSTRAINT uq_sched_txn_overrides_occurrence
        UNIQUE (scheduled_transaction_id, original_date)
);

CREATE INDEX idx_sched_txn_overrides_sched_txn_id ON scheduled_transaction_overrides(scheduled_transaction_id);
CREATE INDEX idx_sched_txn_overrides_date ON scheduled_transaction_overrides(override_date);
-- The override-due predicates every occurrence read runs are
-- `(scheduled_transaction_id, override_date)`. Migration 166 retired the unique
-- constraint that used to supply this index as a side effect of its own; it is
-- declared explicitly now so nothing depends on a constraint for a lookup.
CREATE INDEX idx_sched_txn_overrides_sched_txn_override_date ON scheduled_transaction_overrides(scheduled_transaction_id, override_date);

-- Posted occurrences (migration 140). The occurrence -- not the schedule -- is
-- the thing that must happen once, and this unique key is its name. Manual and
-- automatic posting both insert it inside the same transaction as the money they
-- create, so the key arbitrates between two replicas, a manual post racing the
-- cron, and a retry after a crash. original_due_date is the schedule's own
-- next_due_date at posting time, not posted_date, which an override moves.
CREATE TABLE scheduled_transaction_postings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scheduled_transaction_id UUID NOT NULL REFERENCES scheduled_transactions(id) ON DELETE CASCADE,
    original_due_date DATE NOT NULL,
    posted_date DATE NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_stp_occurrence
    ON scheduled_transaction_postings(scheduled_transaction_id, original_due_date);

-- Security documents: factsheet, KIID, prospectus, annual report, tax slip,
-- research. Real columns rather than a JSONB blob so the type, name, date and
-- address are all sortable (discussion #964). Linked documents only for now;
-- uploads need the attachments table generalised beyond transactions first.
CREATE TABLE security_documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    security_id UUID NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
    document_type VARCHAR(30) NOT NULL DEFAULT 'OTHER',
    name VARCHAR(255) NOT NULL,
    document_date DATE,             -- the date on the document, not when it was added
    url VARCHAR(2048) NOT NULL,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT security_documents_type_check
      CHECK (document_type IN (
        'FACTSHEET','KIID','PROSPECTUS','ANNUAL_REPORT',
        'SEMI_ANNUAL_REPORT','TAX','RESEARCH','OTHER'
      ))
);

CREATE INDEX idx_security_documents_security
  ON security_documents(security_id, document_date DESC NULLS LAST);
CREATE INDEX idx_security_documents_user ON security_documents(user_id);

-- Security Prices (historical)
CREATE TABLE security_prices (
    id BIGSERIAL PRIMARY KEY,
    security_id UUID NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
    price_date DATE NOT NULL,
    open_price NUMERIC(24, 10),
    high_price NUMERIC(24, 10),
    low_price NUMERIC(24, 10),
    close_price NUMERIC(24, 10) NOT NULL,
    adjusted_close NUMERIC(24, 10),
    volume BIGINT,
    source VARCHAR(50), -- yahoo_finance, msn_finance, manual, or transaction action (buy, sell, reinvest, transfer_in, transfer_out)
    quoted_at TIMESTAMPTZ, -- instant the provider says the quote was struck; NULL for manual/transaction-derived rows
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(security_id, price_date)
);

CREATE INDEX idx_security_prices_security ON security_prices(security_id);
CREATE INDEX idx_security_prices_date ON security_prices(price_date DESC);

-- Market Index Prices (global reference data, like exchange_rates)
--
-- An index has no owner and nobody holds units of it, so it is not a security:
-- one S&P 500 close serves the whole deployment. index_code is the app's own
-- stable key (backend/src/securities/market-indexes.ts), not the provider's
-- spelling, so changing provider is not a data migration.
CREATE TABLE market_index_prices (
    id BIGSERIAL PRIMARY KEY,
    index_code VARCHAR(32) NOT NULL,
    price_date DATE NOT NULL,
    close_price NUMERIC(24, 10) NOT NULL,
    adjusted_close NUMERIC(24, 10),
    source VARCHAR(50) NOT NULL, -- yahoo_finance
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(index_code, price_date)
);

CREATE INDEX idx_market_index_prices_code_date ON market_index_prices(index_code, price_date DESC);

-- Per-index fetch bookkeeping, so a provider that cannot serve an index is not
-- re-asked on every request.
CREATE TABLE market_index_sync (
    index_code VARCHAR(32) PRIMARY KEY,
    last_attempt_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_error TEXT
);

-- Outbound market-data provider availability, and what has already been said
-- about it by email. The in-process circuit breaker decides whether to call
-- out; this row is what survives a restart (an outage that restarts the
-- container must not reset the clock the alert gate reads) and what serializes
-- the alert across replicas via a conditional UPDATE on the notification
-- columns. See backend/src/provider-health/ and docs/specs/provider-outage-alerts.md.
CREATE TABLE provider_health (
    provider VARCHAR(64) PRIMARY KEY,
    state VARCHAR(16) NOT NULL DEFAULT 'up',
    recent_failures INTEGER NOT NULL DEFAULT 0,
    outage_started_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    last_failure_reason TEXT,
    last_success_at TIMESTAMPTZ,
    outage_notified_at TIMESTAMPTZ,
    last_notified_at TIMESTAMPTZ,
    CONSTRAINT provider_health_state_check CHECK (state IN ('up', 'down'))
);

CREATE INDEX idx_provider_health_down ON provider_health (provider) WHERE state = 'down';

-- Investment Holdings
CREATE TABLE holdings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    security_id UUID NOT NULL REFERENCES securities(id),
    quantity NUMERIC(20, 8) NOT NULL DEFAULT 0,
    average_cost NUMERIC(24, 10), -- average cost per unit
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id, security_id)
);

CREATE INDEX idx_holdings_account ON holdings(account_id);
CREATE INDEX idx_holdings_security ON holdings(security_id);

-- Investment Transactions
CREATE TYPE investment_action AS ENUM (
    'BUY',
    'SELL',
    'DIVIDEND',
    'INTEREST',
    'CAPITAL_GAIN',
    'SPLIT',
    'TRANSFER_IN',
    'TRANSFER_OUT',
    'REINVEST',
    'ADD_SHARES',
    'REMOVE_SHARES',
    -- Money's full distribution vocabulary (issue #1149, migration 158). Each
    -- is a refinement of a base action: same share/cash behaviour, distinct
    -- income kind for tax reporting.
    'REINVEST_INTEREST',
    'REINVEST_CAPITAL_GAIN_SHORT',
    'REINVEST_CAPITAL_GAIN_LONG',
    'CAPITAL_GAIN_SHORT',
    'CAPITAL_GAIN_LONG',
    'REDEEM'
);

CREATE TABLE investment_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
    transaction_split_id UUID REFERENCES transaction_splits(id) ON DELETE CASCADE, -- when embedded inside a split transaction
    linked_transaction_id UUID REFERENCES investment_transactions(id) ON DELETE SET NULL, -- links the two legs of a security transfer (TRANSFER_OUT <-> TRANSFER_IN)
    security_id UUID REFERENCES securities(id),
    funding_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    action investment_action NOT NULL,
    transaction_date DATE NOT NULL,
    quantity NUMERIC(20, 8),
    price NUMERIC(24, 10),
    commission NUMERIC(20, 4) DEFAULT 0,
    total_amount NUMERIC(20, 4) NOT NULL,
    exchange_rate NUMERIC(20, 10) NOT NULL DEFAULT 1,
    description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'UNRECONCILED', -- 'UNRECONCILED', 'CLEARED', 'RECONCILED', 'VOID'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_investment_transactions_user ON investment_transactions(user_id);
CREATE INDEX idx_investment_transactions_status ON investment_transactions(status);
CREATE INDEX idx_investment_transactions_account ON investment_transactions(account_id);
CREATE INDEX idx_investment_transactions_security ON investment_transactions(security_id);
CREATE INDEX idx_investment_transactions_date ON investment_transactions(transaction_date DESC);
CREATE INDEX idx_investment_transactions_transaction ON investment_transactions(transaction_id);
CREATE INDEX idx_investment_transactions_split_id ON investment_transactions(transaction_split_id);
CREATE INDEX idx_investment_transactions_linked ON investment_transactions(linked_transaction_id);

-- User Preferences
CREATE TABLE user_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    default_currency VARCHAR(3) REFERENCES currencies(code),
    date_format VARCHAR(20) DEFAULT 'YYYY-MM-DD',
    number_format VARCHAR(20) DEFAULT 'en-US',
    theme VARCHAR(20) DEFAULT 'light',
    color_theme VARCHAR(20) NOT NULL DEFAULT 'default',
    timezone VARCHAR(50) DEFAULT 'browser',
    notification_email BOOLEAN DEFAULT true,
    notification_browser BOOLEAN DEFAULT true,
    two_factor_enabled BOOLEAN DEFAULT false,
    getting_started_dismissed BOOLEAN DEFAULT false,
    week_starts_on SMALLINT DEFAULT 1,
    budget_digest_enabled BOOLEAN DEFAULT true,
    budget_digest_day VARCHAR(10) DEFAULT 'MONDAY',
    favourite_report_ids TEXT[] DEFAULT '{}',
    dashboard_widgets TEXT[] DEFAULT '{}', -- ordered visible dashboard widget ids; empty = default layout
    dashboard_widget_config JSONB NOT NULL DEFAULT '{}', -- per-widget settings (timeframe, accounts, chart type), keyed by widget id
    show_created_at BOOLEAN DEFAULT false,
    time_format VARCHAR(10) DEFAULT '24h',
    preferred_exchanges TEXT[] DEFAULT '{}',
    dismissed_update_version VARCHAR(50),
    last_seen_version VARCHAR(50), -- version whose "What's New" notes the user acknowledged (Don't show this again)
    show_whats_new BOOLEAN DEFAULT true, -- settings kill-switch for the What's New auto-popup
    tour_progress JSONB NOT NULL DEFAULT '{}', -- guided-tour completion, keyed by opaque tour id: { status, version?, updatedAt }
    default_quote_provider VARCHAR(20) NOT NULL DEFAULT 'yahoo',
    recent_transactions_limit SMALLINT NOT NULL DEFAULT 5,
    ai_bubble_enabled BOOLEAN DEFAULT false, -- opt-in app-wide floating AI chat bubble
    lock_reconciled_transactions BOOLEAN NOT NULL DEFAULT false, -- strict mode: refuse any alteration of a RECONCILED transaction
    payee_contact_lookup_enabled BOOLEAN NOT NULL DEFAULT false, -- opt-in: look up a new payee's website/address/email/phone through the user's AI provider
    language VARCHAR(10) NOT NULL DEFAULT 'en', -- UI language; ISO 639-1 or BCP 47 tag matched against SUPPORTED_LOCALES
    last_client_timezone VARCHAR(64), -- Most recently reported X-Client-Timezone, used by cron jobs when timezone='browser'
    default_map_provider VARCHAR(20) NOT NULL DEFAULT 'device', -- which map service an address link opens; 'device' means decide from the platform
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT user_preferences_default_quote_provider_check
      CHECK (default_quote_provider IN ('yahoo','msn')),
    CONSTRAINT user_preferences_recent_transactions_limit_check
      CHECK (recent_transactions_limit BETWEEN 1 AND 20),
    CONSTRAINT user_preferences_default_map_provider_check
      CHECK (default_map_provider IN ('device','openstreetmap','google','apple','bing','waze'))
);

-- Auto Backup Settings (per-user configuration for automatic backups to a folder)
CREATE TABLE auto_backup_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT false,
    folder_path VARCHAR(1024) NOT NULL DEFAULT '',
    frequency VARCHAR(20) NOT NULL DEFAULT 'daily',
    backup_time VARCHAR(5) NOT NULL DEFAULT '02:00',
    timezone VARCHAR(100) NOT NULL DEFAULT 'UTC',
    retention_daily SMALLINT NOT NULL DEFAULT 7,
    retention_weekly SMALLINT NOT NULL DEFAULT 4,
    retention_monthly SMALLINT NOT NULL DEFAULT 6,
    last_backup_at TIMESTAMP,
    last_backup_status VARCHAR(20),
    last_backup_error VARCHAR(1024),
    next_backup_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Trusted Devices (for 2FA "remember this device" feature)
CREATE TABLE trusted_devices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL,
    device_name VARCHAR(255) NOT NULL,
    ip_address INET,
    user_agent_hash VARCHAR(64),
    last_used_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_trusted_devices_user ON trusted_devices(user_id);
CREATE UNIQUE INDEX idx_trusted_devices_token ON trusted_devices(token_hash);

-- Refresh Tokens (for JWT refresh token rotation with family-based replay detection)
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL,
    family_id UUID NOT NULL,
    is_revoked BOOLEAN NOT NULL DEFAULT false,
    remember_me BOOLEAN NOT NULL DEFAULT false,
    expires_at TIMESTAMP NOT NULL,
    replaced_by_hash VARCHAR(64),
    acting_as_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    delegation_id UUID,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_family ON refresh_tokens(family_id);
CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens(expires_at);

-- OIDC destructive step-up claims (migration 155). One row per SPENT step-up
-- proof, so a proof authorises one destructive action across the whole
-- deployment rather than once per Node process: `INSERT ... ON CONFLICT DO
-- NOTHING` on the primary key is atomic, so of two concurrent restores routed to
-- two replicas exactly one inserts and the other is refused. Transient auth
-- bookkeeping with a logical five-minute lifetime (each claim opportunistically
-- sweeps rows past expiry; nothing reaps them on a schedule); excluded from
-- backups.
CREATE TABLE oidc_step_up_claims (
    jti TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_oidc_step_up_claims_expires ON oidc_step_up_claims(expires_at);

-- Delegate account access (Phase 1). A user (owner) can grant another user
-- (delegate) scoped access to their data. Delegates are normal `users` rows;
-- this defines the relationship and per-account permissions. Only can_read is
-- enforced in Phase 1; the other grant columns exist for Phase 2.
CREATE TABLE account_delegates (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delegate_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status           VARCHAR(20) NOT NULL DEFAULT 'active', -- 'pending' | 'active' | 'revoked'
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    revoked_at       TIMESTAMP,
    payees_can_create     BOOLEAN NOT NULL DEFAULT false,
    payees_can_edit       BOOLEAN NOT NULL DEFAULT false,
    payees_can_delete     BOOLEAN NOT NULL DEFAULT false,
    categories_can_create BOOLEAN NOT NULL DEFAULT false,
    categories_can_edit   BOOLEAN NOT NULL DEFAULT false,
    categories_can_delete BOOLEAN NOT NULL DEFAULT false,
    tags_can_create       BOOLEAN NOT NULL DEFAULT false,
    tags_can_edit         BOOLEAN NOT NULL DEFAULT false,
    tags_can_delete       BOOLEAN NOT NULL DEFAULT false,
    bills_can_read        BOOLEAN NOT NULL DEFAULT false,
    investments_can_read  BOOLEAN NOT NULL DEFAULT false,
    budgets_can_read      BOOLEAN NOT NULL DEFAULT false,
    reports_can_read      BOOLEAN NOT NULL DEFAULT false,
    ai_can_read           BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT account_delegates_owner_delegate_unique UNIQUE (owner_user_id, delegate_user_id),
    CONSTRAINT account_delegates_no_self CHECK (owner_user_id <> delegate_user_id)
);

CREATE INDEX idx_account_delegates_delegate ON account_delegates(delegate_user_id) WHERE status = 'active';
CREATE INDEX idx_account_delegates_owner ON account_delegates(owner_user_id);

CREATE TABLE account_delegate_grants (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    delegation_id UUID NOT NULL REFERENCES account_delegates(id) ON DELETE CASCADE,
    account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    can_read   BOOLEAN NOT NULL DEFAULT true,
    can_create BOOLEAN NOT NULL DEFAULT false,
    can_edit   BOOLEAN NOT NULL DEFAULT false,
    can_delete BOOLEAN NOT NULL DEFAULT false,
    -- Joint account opt-in (migration 133): with can_read, makes the account
    -- natively visible in the delegate's OWN context. false = plain grant,
    -- visible only while acting in the owner's context.
    is_joint   BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT account_delegate_grants_unique UNIQUE (delegation_id, account_id)
);

CREATE INDEX idx_adg_delegation ON account_delegate_grants(delegation_id);
-- The transactions policy arm and CrossOwnerAccessService probe by account.
CREATE INDEX idx_adg_account ON account_delegate_grants(account_id);

-- A delegate's account favourites, independent of the owner's
-- accounts.is_favourite (which stays owner-scoped).
CREATE TABLE delegate_account_favourites (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    delegate_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (delegate_user_id, account_id)
);

CREATE INDEX idx_delegate_account_favourites_user
    ON delegate_account_favourites(delegate_user_id);

-- A grantee's per-account "exclude this joint account from MY net worth"
-- overlay (migration 133). Row presence = excluded. Keyed by the real user,
-- like delegate_account_favourites, so the owner's
-- accounts.exclude_from_net_worth stays owner-scoped.
CREATE TABLE delegate_net_worth_exclusions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    delegate_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (delegate_user_id, account_id)
);

CREATE INDEX idx_delegate_net_worth_exclusions_user
    ON delegate_net_worth_exclusions(delegate_user_id);

-- Emergency Access. Lets the owner pre-designate one or more contacts who
-- receive a magic link to take over the account after a configurable
-- period of inactivity. The free-form message body is stored as
-- AES-256-GCM ciphertext (EncryptionService, keyed by ENCRYPTION_KEY)
-- so a database dump cannot leak it; the running app decrypts on demand.
CREATE TABLE emergency_access_settings (
    owner_user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled               BOOLEAN NOT NULL DEFAULT false,
    grant_after_days      INTEGER NOT NULL DEFAULT 14 CHECK (grant_after_days > 0),
    reminder_after_days   INTEGER NOT NULL DEFAULT 7  CHECK (reminder_after_days > 0),
    message_ciphertext    TEXT,
    last_reminder_sent_at TIMESTAMP,
    granted_at            TIMESTAMP,
    -- Which grant cycle this owner is on (migration 150). Advanced by the single
    -- statement that transitions ungranted -> granted, so a contact's delivery
    -- state belongs to one cycle instead of to the row: no re-arm path
    -- (revokeAfterReturn, disable/re-enable, a manual reset) has to remember to
    -- clear anything, which is what stopped emergency access from ever firing a
    -- second time (audit RRV4-004).
    grant_generation      INTEGER NOT NULL DEFAULT 1,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT emergency_access_settings_reminder_lt_grant
        CHECK (reminder_after_days < grant_after_days)
);

CREATE TABLE emergency_access_contacts (
    id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    first_name             VARCHAR(100) NOT NULL,
    email                  VARCHAR(255) NOT NULL,
    claim_token_hash       VARCHAR(128),
    claim_token_expires_at TIMESTAMP,
    claim_token_used_at    TIMESTAMP,
    claim_voided_reason    VARCHAR(20), -- 'claimed_by_other' | 'owner_revoked' | NULL
    -- When the notice for `notified_grant_generation` was actually sent
    -- (migration 149). The delivery record, kept apart from the claim that
    -- coordinates the send: a claim answers "may I do this now" and cannot also
    -- answer "has this been done", because the second question has to outlive the
    -- process that asked the first. That is how the daily check finds a grant a
    -- killed replica never delivered (audit FV4-004).
    --
    -- A timestamp for operators, not a predicate: migration 150 moved "is a link
    -- still owed" onto the generation below, because this column was never reset
    -- and therefore made emergency access fire at most once per contact row.
    claim_notified_at      TIMESTAMP,
    -- The grant cycle whose notice this contact received (migration 150). Owed a
    -- link whenever it differs from the owner's `grant_generation`, which is what
    -- makes a re-armed grant owe every contact again without any reset path having
    -- to say so (audit RRV4-004). NULL means never notified.
    notified_grant_generation INTEGER,
    -- The undelivered credential (migration 149), AES-256-GCM under
    -- ENCRYPTION_KEY. Written with the hash before the first send, re-read by a
    -- retry so it re-sends the *same* link rather than minting one that kills the
    -- link already in the recipient's inbox, and cleared in the statement that
    -- records delivery. A credential at rest, so it does not outlive the delivery
    -- it exists for (audit RV4-004).
    claim_token_ciphertext TEXT,
    created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_emergency_access_contacts_owner_email
    ON emergency_access_contacts(owner_user_id, lower(email));

-- "Granted owners with a contact still owed a link", read on every daily sweep
-- (migration 150). Composite rather than partial: the predicate is a disjunction
-- (`notified_grant_generation IS NULL OR notified_grant_generation < $2`) and no
-- partial index can serve the second arm, so both arms read from this one instead.
CREATE INDEX idx_eac_awaiting_notice
    ON emergency_access_contacts(owner_user_id, notified_grant_generation);

CREATE INDEX idx_emergency_access_contacts_token_hash
    ON emergency_access_contacts(claim_token_hash)
    WHERE claim_token_hash IS NOT NULL;

-- Rolling-deployment fence for the binary that predates the delivery columns
-- (migration 151). The pre-149 release rotates `claim_token_hash` guarded only by
-- a snapshot of `granted_at`, so a stale old pod can overwrite -- and kill -- a
-- link the new protocol has already minted or delivered. The current code never
-- writes a new hash without the matching `claim_token_ciphertext` in the same
-- statement, so a rotation touching neither ciphertext nor generation is
-- legacy-shaped, and it is refused exactly when it would destroy new-protocol
-- state: an undelivered credential in flight, or a live delivered link. Hash
-- clears (revocation, consumption) and rotations over rows with no new-protocol
-- state pass through unchanged.
CREATE OR REPLACE FUNCTION reject_legacy_emergency_token_rotation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.claim_token_ciphertext IS NOT NULL THEN
        RAISE EXCEPTION
            'emergency-access contact % has an undelivered credential; a generation-blind token rotation would desync it (a newer release owns this credential cycle)',
            OLD.id;
    END IF;
    IF OLD.notified_grant_generation IS NOT NULL
       AND OLD.claim_token_hash IS NOT NULL
       AND OLD.claim_token_used_at IS NULL
       AND OLD.claim_token_expires_at IS NOT NULL
       AND OLD.claim_token_expires_at >= CURRENT_TIMESTAMP THEN
        RAISE EXCEPTION
            'emergency-access contact % holds a live delivered link; a generation-blind token rotation would kill it (a newer release owns this credential cycle)',
            OLD.id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_eac_reject_legacy_token_rotation
    BEFORE UPDATE ON emergency_access_contacts
    FOR EACH ROW
    WHEN (
      NEW.claim_token_hash IS NOT NULL
      AND NEW.claim_token_hash IS DISTINCT FROM OLD.claim_token_hash
      AND NEW.claim_token_ciphertext IS NOT DISTINCT FROM OLD.claim_token_ciphertext
      AND NEW.notified_grant_generation IS NOT DISTINCT FROM OLD.notified_grant_generation
    )
    EXECUTE FUNCTION reject_legacy_emergency_token_rotation();

-- Custom Reports (user-defined configurable reports)
-- view_type: TABLE, LINE_CHART, BAR_CHART, PIE_CHART
-- timeframe_type: LAST_7_DAYS, LAST_30_DAYS, LAST_MONTH, LAST_3_MONTHS, LAST_6_MONTHS, LAST_12_MONTHS, LAST_YEAR, YEAR_TO_DATE, CUSTOM
-- group_by: NONE, CATEGORY, PAYEE, MONTH, WEEK, DAY
-- filters: { accountIds?: string[], categoryIds?: string[], payeeIds?: string[], searchText?: string }
-- config: {
--   metric: NONE | TOTAL_AMOUNT | COUNT | AVERAGE,
--   includeTransfers: boolean,
--   direction: INCOME_ONLY | EXPENSES_ONLY | BOTH,
--   customStartDate?: string,
--   customEndDate?: string,
--   tableColumns?: (LABEL | VALUE | COUNT | PERCENTAGE | DATE | PAYEE | DESCRIPTION | MEMO | CATEGORY | ACCOUNT)[],
--   sortBy?: LABEL | VALUE | COUNT | PERCENTAGE | DATE | PAYEE | DESCRIPTION | MEMO | CATEGORY | ACCOUNT,
--   sortDirection?: ASC | DESC
-- }
CREATE TABLE custom_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    icon VARCHAR(50),
    background_color VARCHAR(7),
    view_type VARCHAR(20) NOT NULL DEFAULT 'BAR_CHART',
    timeframe_type VARCHAR(30) NOT NULL DEFAULT 'LAST_3_MONTHS',
    group_by VARCHAR(20) NOT NULL DEFAULT 'CATEGORY',
    filters JSONB NOT NULL DEFAULT '{}',
    config JSONB NOT NULL DEFAULT '{"metric": "TOTAL_AMOUNT", "includeTransfers": false, "direction": "EXPENSES_ONLY"}',
    is_favourite BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_custom_reports_user_id ON custom_reports(user_id);
CREATE INDEX idx_custom_reports_user_favourite ON custom_reports(user_id, is_favourite);
CREATE INDEX idx_custom_reports_user_sort ON custom_reports(user_id, sort_order);

-- Custom investment reports (MS Money-style portfolio column reports).
-- config JSONB shape:
-- {
--   columns: string[]      -- ordered column keys (always starts with "symbol")
--   accountIds: string[]   -- holdings accounts to include ([] = all)
--   sortColumn: string|null
--   sortDirection: ASC | DESC
--   asOfDate: string|null  -- YYYY-MM-DD, null = latest market day at run time
-- }
CREATE TABLE investment_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    icon VARCHAR(50),
    background_color VARCHAR(7),
    group_by VARCHAR(20) NOT NULL DEFAULT 'NONE',
    config JSONB NOT NULL DEFAULT '{}',
    is_favourite BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_investment_reports_user_id ON investment_reports(user_id);
CREATE INDEX idx_investment_reports_user_favourite ON investment_reports(user_id, is_favourite);
CREATE INDEX idx_investment_reports_user_sort ON investment_reports(user_id, sort_order);

-- Row-Level Security identity helpers (see docs/future-plans/row-level-security.md).
--
-- app.current_user_id -- effective user (the owner when a delegate is acting).
-- app.real_user_id    -- authenticated identity (the delegate while acting);
--                        equals current_user_id outside delegation.
-- app.bypass_rls      -- set only inside an explicit withSystemContext scope.
--
-- Fail-closed: an unset/empty GUC yields NULL, every policy predicate is false,
-- zero rows. A non-UUID GUC value raises 22P02 rather than returning rows.
-- STABLE lets policies call these as (SELECT app_...()) scalar subqueries, which
-- the planner evaluates once per statement instead of once per row.

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_real_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.real_user_id', true), '')::uuid
$$;

-- COALESCE keeps the function from returning NULL when the GUC is unset: the
-- OR-ed policy predicates are fail-closed either way, but a boolean function
-- that can return NULL would silently match nothing under `NOT app_bypass_rls()`.
CREATE OR REPLACE FUNCTION app_bypass_rls() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.bypass_rls', true) = 'on', false)
$$;

COMMENT ON FUNCTION app_current_user_id() IS
  'RLS: effective user id from the app.current_user_id GUC (owner when a delegate acts). NULL when unset -- policies then match no rows.';
COMMENT ON FUNCTION app_real_user_id() IS
  'RLS: authenticated user id from the app.real_user_id GUC (the delegate while acting; equals app_current_user_id() otherwise).';
COMMENT ON FUNCTION app_bypass_rls() IS
  'RLS: true inside a withSystemContext scope, letting cross-user jobs (cron, seed, admin, pre-session auth) see every row.';
-- Triggers for updated_at timestamps.
--
-- Honours the app.preserve_timestamps GUC so backup restore can write rows with
-- their original updated_at values without ALTER TABLE ... DISABLE TRIGGER (which
-- would require table ownership the runtime role must not have). Inert while the
-- GUC is unset: current_setting(..., true) returns NULL, NULL = 'on' is not true,
-- and the function stamps CURRENT_TIMESTAMP as it always has.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    IF current_setting('app.preserve_timestamps', true) = 'on' THEN
        -- Restore path: keep the updated_at value supplied by the caller.
        RETURN NEW;
    END IF;
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

COMMENT ON FUNCTION update_updated_at_column() IS
  'Stamps NEW.updated_at with CURRENT_TIMESTAMP, unless the app.preserve_timestamps GUC is ''on'' (backup restore).';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_accounts_updated_at BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_transactions_updated_at BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_scheduled_transactions_updated_at BEFORE UPDATE ON scheduled_transactions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_scheduled_transaction_overrides_updated_at BEFORE UPDATE ON scheduled_transaction_overrides FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_securities_updated_at BEFORE UPDATE ON securities FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_security_documents_updated_at BEFORE UPDATE ON security_documents FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_holdings_updated_at BEFORE UPDATE ON holdings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_investment_transactions_updated_at BEFORE UPDATE ON investment_transactions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_user_preferences_updated_at BEFORE UPDATE ON user_preferences FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_trusted_devices_updated_at BEFORE UPDATE ON trusted_devices FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_refresh_tokens_updated_at BEFORE UPDATE ON refresh_tokens FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_custom_reports_updated_at BEFORE UPDATE ON custom_reports FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_investment_reports_updated_at BEFORE UPDATE ON investment_reports FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- NOTE: Account balances (current_balance) are managed by application code
-- (accounts.service.ts, transactions.service.ts, import.service.ts) via updateBalance() calls.
-- No database trigger is used for balance tracking.

-- Currencies are intentionally NOT pre-seeded. A user's currency is created on
-- demand (with a proper symbol) when they pick it at onboarding, and their
-- default-preference currency is created lazily on first use if they skip.

-- Monthly Account Balances (cached end-of-month balances for net worth report)
CREATE TABLE monthly_account_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  month DATE NOT NULL,
  balance NUMERIC(20, 4) NOT NULL DEFAULT 0,
  market_value NUMERIC(20, 4),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (account_id, month)
);

CREATE INDEX idx_mab_user_month ON monthly_account_balances(user_id, month);

-- Create indexes for performance
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_accounts_closed ON accounts(is_closed);
CREATE INDEX idx_accounts_user_favourite_sort ON accounts(user_id, favourite_sort_order);
CREATE INDEX idx_scheduled_transactions_account ON scheduled_transactions(account_id);

-- Composite indexes for common query patterns
CREATE INDEX idx_transactions_user_date ON transactions(user_id, transaction_date DESC);
CREATE INDEX idx_transactions_user_account_date ON transactions(user_id, account_id, transaction_date DESC);
CREATE INDEX idx_transactions_user_date_created ON transactions(user_id, transaction_date DESC, created_at DESC, id DESC);
CREATE INDEX idx_transactions_account_date ON transactions(account_id, transaction_date DESC);
CREATE INDEX idx_mab_account_month ON monthly_account_balances(account_id, month);
CREATE INDEX idx_security_prices_security_date ON security_prices(security_id, price_date DESC);

-- AI Provider Configs (per-user AI provider configuration with encrypted API keys)
CREATE TABLE ai_provider_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,        -- 'anthropic', 'openai', 'ollama', 'openai-compatible'
    display_name VARCHAR(100),            -- User-friendly label
    is_active BOOLEAN DEFAULT true,
    priority INTEGER DEFAULT 0,           -- For fallback ordering (lower = higher priority)
    model VARCHAR(100),                   -- e.g., 'claude-sonnet-4-20250514', 'gpt-4o', 'llama3'
    api_key_enc TEXT,                     -- Encrypted API key (null for Ollama)
    base_url VARCHAR(500),               -- Custom endpoint URL (required for Ollama/compatible)
    config JSONB DEFAULT '{}',           -- Provider-specific settings (temperature, maxTokens, etc.)
    input_cost_per_1m NUMERIC(12, 4),    -- User-defined input cost per 1M tokens (for usage cost estimation)
    output_cost_per_1m NUMERIC(12, 4),   -- User-defined output cost per 1M tokens (for usage cost estimation)
    cost_currency VARCHAR(3) NOT NULL DEFAULT 'USD', -- ISO 4217 currency of the cost rates
    -- Per-query budgets for the AI Assistant's tool-calling loop, owned by the
    -- user who owns this provider. NULL = use the built-in default; the
    -- AI_QUERY_* environment variables size the centrally managed provider
    -- (AI_DEFAULT_PROVIDER) only. See backend/src/ai/query/query-budgets.ts.
    query_max_iterations INTEGER,        -- Analysis steps (loop iterations) per query
    query_max_tool_calls INTEGER,        -- Data lookups (tool calls) per query
    query_timeout_minutes INTEGER,       -- Wall-clock minutes before a query is cut short
    query_max_input_tokens INTEGER,      -- Cumulative input tokens per query
    query_max_tool_result_chars INTEGER, -- Characters kept from a single tool result
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, provider, priority)
);

CREATE INDEX idx_ai_provider_configs_user ON ai_provider_configs(user_id);
CREATE INDEX idx_ai_provider_configs_user_active ON ai_provider_configs(user_id, is_active);

-- Payee contact lookup: Google Places configuration and request counters
-- (migration 188). See backend/src/payees/lookup/google-places/.
-- api_key_enc is ciphertext under ENCRYPTION_KEY, named to match
-- ai_provider_configs.api_key_enc so the backup key transport applies.
-- monthly_cap defaults to 1000: the free monthly allowance of Google's Text
-- Search Enterprise SKU, which is the SKU a field mask asking for websiteUri
-- or internationalPhoneNumber is billed at.
CREATE TABLE payee_lookup_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    api_key_enc TEXT,                     -- Encrypted Google Places API key (null = user configured none)
    google_places_enabled BOOLEAN NOT NULL DEFAULT true,
    -- The AI source's own switch (migration 191). Symmetric with the one
    -- above: disabled means never reached, not even as the fallback when the
    -- Places cap is spent.
    ai_enabled BOOLEAN NOT NULL DEFAULT true,
    cap_enabled BOOLEAN NOT NULL DEFAULT true,
    monthly_cap INTEGER NOT NULL DEFAULT 1000,
    -- Which source answers first (migration 189). An order, not a switch: the
    -- other source is still reached when this one cannot answer for a
    -- configuration or budget reason, never to paper over a failure.
    preferred_source VARCHAR(20) NOT NULL DEFAULT 'google-places',
    -- Which AI provider answers, when AI does (migration 190). NULL = no
    -- preference: every active provider in priority order, as before. Pinned so
    -- a lookup cannot fall through to a model the user did not choose to pay
    -- for. SET NULL on delete: losing the provider must not delete the Google
    -- Places key stored beside it.
    ai_provider_config_id UUID REFERENCES ai_provider_configs(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT payee_lookup_settings_monthly_cap_check
        CHECK (monthly_cap BETWEEN 1 AND 1000000),
    CONSTRAINT payee_lookup_settings_preferred_source_check
        CHECK (preferred_source IN ('google-places', 'ai'))
);

CREATE TRIGGER update_payee_lookup_settings_updated_at
    BEFORE UPDATE ON payee_lookup_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Per-user request counter for a user's own Google Places key. month is a
-- Pacific 'YYYY-MM' string written by the claim statement -- Pacific because
-- Google's free monthly allowance resets at midnight Pacific on the 1st.
CREATE TABLE payee_lookup_usage (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month CHAR(7) NOT NULL,
    google_places_requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, month)
);

-- Request counter for the OPERATOR's key (GOOGLE_PLACES_API_KEY). No owner
-- column: one operator key is one bill. RLS-exempt, like provider_health.
CREATE TABLE google_places_instance_usage (
    month CHAR(7) PRIMARY KEY,
    requests INTEGER NOT NULL DEFAULT 0
);

-- AI Usage Logs (token usage tracking per AI request)
CREATE TABLE ai_usage_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    model VARCHAR(100) NOT NULL,
    feature VARCHAR(50) NOT NULL,         -- 'categorize', 'insight', 'query', 'forecast', 'test'
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    error TEXT,                            -- Error message if request failed
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ai_usage_logs_user ON ai_usage_logs(user_id);
CREATE INDEX idx_ai_usage_logs_user_created ON ai_usage_logs(user_id, created_at DESC);
CREATE INDEX idx_ai_usage_logs_user_feature ON ai_usage_logs(user_id, feature);

CREATE TRIGGER update_ai_provider_configs_updated_at
    BEFORE UPDATE ON ai_provider_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- AI Insights (spending insights and anomaly detection)
CREATE TABLE ai_insights (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,           -- 'anomaly', 'trend', 'subscription', 'budget_pace', 'seasonal', 'new_recurring'
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    severity VARCHAR(20) NOT NULL,       -- 'info', 'warning', 'alert'
    data JSONB DEFAULT '{}',             -- Supporting data (amounts, categories, dates)
    is_dismissed BOOLEAN DEFAULT false,
    generated_at TIMESTAMP NOT NULL,
    expires_at TIMESTAMP NOT NULL,       -- Auto-cleanup old insights
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ai_insights_user ON ai_insights(user_id);
CREATE INDEX idx_ai_insights_user_dismissed ON ai_insights(user_id, is_dismissed);
CREATE INDEX idx_ai_insights_expires ON ai_insights(expires_at);
CREATE INDEX idx_ai_insights_user_type ON ai_insights(user_id, type);

-- Personal Access Tokens (for MCP server and API access)
CREATE TABLE personal_access_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    token_prefix VARCHAR(8) NOT NULL,     -- First 8 chars (e.g., "pat_xxxx") for display identification
    token_hash VARCHAR(64) NOT NULL,      -- SHA-256 hash of the full token
    -- Comma-separated. The vocabulary is defined once in
    -- backend/src/auth/scopes.ts (API_SCOPES) and every consumer derives from
    -- it; do not widen this comment without widening that constant. It used to
    -- list a third scope, 'reports', that no issuance path ever accepted.
    scopes VARCHAR(500) NOT NULL DEFAULT 'read', -- 'read', 'write'
    last_used_at TIMESTAMP,
    expires_at TIMESTAMP,                 -- NULL = never expires
    is_revoked BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_pat_user ON personal_access_tokens(user_id);
CREATE UNIQUE INDEX idx_pat_token_hash ON personal_access_tokens(token_hash);
CREATE INDEX idx_pat_user_active ON personal_access_tokens(user_id, is_revoked)
    WHERE is_revoked = false;

CREATE TRIGGER update_personal_access_tokens_updated_at
    BEFORE UPDATE ON personal_access_tokens
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Budget Planner Tables

-- Budgets - core budget definition
CREATE TABLE budgets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    budget_type VARCHAR(20) NOT NULL DEFAULT 'MONTHLY',
    period_start DATE NOT NULL,
    period_end DATE,
    base_income NUMERIC(20, 4),
    income_linked BOOLEAN DEFAULT false,
    strategy VARCHAR(30) NOT NULL DEFAULT 'FIXED',
    is_active BOOLEAN DEFAULT true,
    currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code),
    config JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_budgets_user ON budgets(user_id);
CREATE INDEX idx_budgets_user_active ON budgets(user_id, is_active);

-- Budget Categories - per-category budget allocation
CREATE TABLE budget_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    budget_id UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    transfer_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    is_transfer BOOLEAN DEFAULT false,
    category_group VARCHAR(20),
    amount NUMERIC(20, 4) NOT NULL,
    is_income BOOLEAN DEFAULT false,
    rollover_type VARCHAR(20) DEFAULT 'NONE',
    rollover_cap NUMERIC(20, 4),
    flex_group VARCHAR(100),
    alert_warn_percent INTEGER DEFAULT 80,
    alert_critical_percent INTEGER DEFAULT 95,
    notes TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_budget_categories_budget ON budget_categories(budget_id);
CREATE INDEX idx_budget_categories_category ON budget_categories(category_id);
CREATE INDEX idx_budget_categories_transfer_account ON budget_categories(transfer_account_id)
    WHERE transfer_account_id IS NOT NULL;
CREATE INDEX idx_budget_categories_flex ON budget_categories(budget_id, flex_group)
    WHERE flex_group IS NOT NULL;

-- Budget Periods - snapshot of each completed period
CREATE TABLE budget_periods (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    budget_id UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    actual_income NUMERIC(20, 4) DEFAULT 0,
    actual_expenses NUMERIC(20, 4) DEFAULT 0,
    total_budgeted NUMERIC(20, 4) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'OPEN',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(budget_id, period_start)
);

CREATE INDEX idx_budget_periods_budget ON budget_periods(budget_id);
CREATE INDEX idx_budget_periods_dates ON budget_periods(budget_id, period_start, period_end);
CREATE INDEX idx_budget_periods_open ON budget_periods(budget_id, status) WHERE status = 'OPEN';

-- Budget Period Categories - per-category actuals for each period
CREATE TABLE budget_period_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    budget_period_id UUID NOT NULL REFERENCES budget_periods(id) ON DELETE CASCADE,
    budget_category_id UUID NOT NULL REFERENCES budget_categories(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    budgeted_amount NUMERIC(20, 4) NOT NULL,
    rollover_in NUMERIC(20, 4) DEFAULT 0,
    actual_amount NUMERIC(20, 4) DEFAULT 0,
    effective_budget NUMERIC(20, 4) NOT NULL,
    rollover_out NUMERIC(20, 4) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(budget_period_id, budget_category_id)
);

CREATE INDEX idx_bpc_period ON budget_period_categories(budget_period_id);
CREATE INDEX idx_bpc_category ON budget_period_categories(category_id);

-- Every durable notification, whatever produced it (migration 179, renamed from
-- budget_alerts). The table stopped being about budgets some time ago:
-- BACKUP_FAILED, SMTP_FAILURE, PROVIDER_OUTAGE and SCHEDULED_POST_FAILED live
-- here with budget_id NULL, and this is what the bell in the header reads. One
-- durable row, one read model, one creation door (NotificationService).
--
-- `severity` is the priority axis discussion #1291 asked for -- it has carried
-- that meaning since the first budget alert -- so there is no second column for
-- it. Localization is the stored English fallback plus the facts in `data`,
-- rendered in the reader's language by the client (or, for copy composed on the
-- server, through emailTranslator); there are no message-key columns for a
-- second mechanism to drift against. There is no `category` column either: what
-- a notification is *about* is a pure function of alert_type, so it is derived
-- by `notificationCategoryOf` rather than stored beside the value it is derived
-- from. Migration 179 has the full reasoning for all four.
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    budget_id UUID REFERENCES budgets(id) ON DELETE CASCADE,
    budget_category_id UUID REFERENCES budget_categories(id) ON DELETE CASCADE,
    alert_type VARCHAR(30) NOT NULL,
    severity VARCHAR(20) NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    data JSONB DEFAULT '{}',
    -- The in-app path this points at, e.g. '/budgets/<id>'. Always a same-origin
    -- path, never a URL: the service worker resolves it against the app's own
    -- origin and discards anything that leaves it.
    target VARCHAR(255),
    is_read BOOLEAN DEFAULT false,
    is_email_sent BOOLEAN DEFAULT false,
    period_start DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    dismissed_at TIMESTAMP,
    dedupe_key VARCHAR(120)
);

CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id, is_read) WHERE is_read = false;
CREATE INDEX idx_notifications_budget_period ON notifications(budget_id, period_start);

-- The app's own de-duplication rule as a database key (migration 140).
-- deduplicateAlerts() drops a candidate matching an existing (alert_type,
-- budget_category_id) unless its severity is strictly higher, so severity
-- belongs in the key and an escalation still inserts. COALESCE because a
-- budget-wide alert has a NULL category and NULL never equals NULL in a unique
-- index: without it the budget-wide alerts would be the only unguarded ones.
--
-- Duplicates predating the key are collapsed by the migration's preflight before
-- it is created, keeping whichever row the user acted on.
CREATE UNIQUE INDEX idx_notifications_fingerprint
    ON notifications(
        budget_id,
        period_start,
        alert_type,
        COALESCE(budget_category_id, '00000000-0000-0000-0000-000000000000'::uuid),
        severity
    );

-- System-level alerts (BACKUP_FAILED, PROVIDER_OUTAGE, SMTP_FAILURE, ...) have
-- budget_id NULL, which the fingerprint index above cannot arbitrate: budget_id
-- is not COALESCE'd there and NULL never equals NULL in a unique index. They
-- carry an explicit dedupe_key instead (migration 170); the partial unique
-- index makes INSERT ... ON CONFLICT DO NOTHING RETURNING id the cross-replica
-- arbiter for both the row and its admin email (only the insert winner sends).
-- Budget-generated alerts keep dedupe_key NULL.
CREATE UNIQUE INDEX idx_notifications_dedupe
    ON notifications(user_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;

-- Per-category notification channel preferences (migration 180,
-- docs/specs/notification-preferences.md). One row per (user, category); an
-- absent row means the default matrix. Phase 1 carries only the live channel,
-- email; push, unifiedpush and the throttle window land with the dispatch that
-- reads them. `category` is a derived NotificationCategory value (PAYMENTS,
-- BUDGETS, SYSTEM today), never a raw alert_type.
CREATE TABLE notification_preferences (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category VARCHAR(20) NOT NULL,
    -- Report-mode email (batch/digest); live and unthrottled (migration 180).
    email BOOLEAN NOT NULL DEFAULT true,
    -- Notification-mode email (immediate, one per event); stored now, delivered
    -- with the push dispatch in Phase 5 (migration 181).
    email_notification BOOLEAN NOT NULL DEFAULT false,
    -- Per-category cooldown for the notification-mode fan-out; 0 disables.
    -- Stored now, enforced in Phase 5 (migration 181).
    throttle_minutes INTEGER NOT NULL DEFAULT 0,
    -- Per-category web push, the other notification-mode fan-out; read by the
    -- Phase 5 dispatch (migration 183). DEFAULT FALSE: a matrix cell cannot turn
    -- a device on, so push stays off until a device is enabled and the category
    -- toggled.
    push BOOLEAN NOT NULL DEFAULT false,
    -- Per-category UnifiedPush/ntfy channel (migration 184); the same encrypted
    -- Web Push wire as `push`, delivered to a distributor endpoint. DEFAULT
    -- FALSE for the push reason: off until a UnifiedPush subscription exists.
    unifiedpush BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, category)
);

CREATE TRIGGER update_notification_preferences_updated_at BEFORE UPDATE ON notification_preferences FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Repeating / one-time notification reminders (migration 182,
-- docs/specs/notification-preferences.md Section 13). One row per active reminder
-- a user asked for; it carries the template a fire re-emits, so a fire never
-- reloads the (possibly dismissed) source notification. Each fire re-emits
-- through NotificationService.create with a per-fire dedupe key (a fresh in-app
-- row every interval). source_notification_id is ON DELETE SET NULL so a deleted
-- source stops the nag rather than deleting the reminder mid-fire.
CREATE TABLE notification_reminders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_notification_id UUID REFERENCES notifications(id) ON DELETE SET NULL,
    alert_type VARCHAR(30) NOT NULL,
    severity VARCHAR(20) NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    data JSONB DEFAULT '{}',
    target VARCHAR(255),
    dedupe_base VARCHAR(80),
    repeat_mode VARCHAR(10) NOT NULL,
    interval_minutes INTEGER NOT NULL,
    next_fire_at TIMESTAMP NOT NULL,
    last_fired_at TIMESTAMP,
    fire_count INTEGER NOT NULL DEFAULT 0,
    stopped_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notification_reminders_due
    ON notification_reminders (next_fire_at) WHERE stopped_at IS NULL;
CREATE INDEX idx_notification_reminders_source
    ON notification_reminders (source_notification_id)
    WHERE source_notification_id IS NOT NULL;
-- At most one active reminder per (user, source).
CREATE UNIQUE INDEX idx_notification_reminders_active_source
    ON notification_reminders (user_id, source_notification_id)
    WHERE stopped_at IS NULL AND source_notification_id IS NOT NULL;

CREATE TRIGGER update_notification_reminders_updated_at BEFORE UPDATE ON notification_reminders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Per-user state for the daily portfolio-movement notification (migration 186;
-- docs/specs/portfolio-movement-notifications.md). The opt-in threshold plus the
-- producer's own last-complete-value baseline. baseline_currency is a resolved
-- reporting-currency snapshot, deliberately not a currencies(code) FK (derived,
-- not user-entered; a currency deletion must not cascade a user's baseline).
CREATE TABLE notification_portfolio_state (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    move_alert_percent NUMERIC(9,4),
    baseline_value NUMERIC(20,4),
    baseline_currency VARCHAR(3),
    baseline_captured_on DATE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id)
);

CREATE TRIGGER update_notification_portfolio_state_updated_at BEFORE UPDATE ON notification_portfolio_state FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Triggers for budget tables updated_at
CREATE TRIGGER update_budgets_updated_at BEFORE UPDATE ON budgets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_budget_categories_updated_at BEFORE UPDATE ON budget_categories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_budget_periods_updated_at BEFORE UPDATE ON budget_periods FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_budget_period_categories_updated_at BEFORE UPDATE ON budget_period_categories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Import Column Mappings (for CSV imports)
CREATE TABLE import_column_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    column_mappings JSONB NOT NULL,
    transfer_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name)
);

CREATE INDEX idx_import_column_mappings_user ON import_column_mappings(user_id);

CREATE TRIGGER update_import_column_mappings_updated_at BEFORE UPDATE ON import_column_mappings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Staged import files: the decrypted bytes of a binary upload (.mny today),
-- held between the wizard's parse/preview call and the background import so any
-- backend replica can run the job. The user's Money password is request-scoped
-- and never stored here. See migration 117.
CREATE TABLE import_staged_files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    source_format VARCHAR(20) NOT NULL DEFAULT 'mny',
    size_bytes BIGINT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    data BYTEA NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_import_staged_files_user ON import_staged_files(user_id);
CREATE INDEX idx_import_staged_files_expires ON import_staged_files(expires_at);

-- One row per background import attempt. A failed job keeps its staged file so
-- Retry is a new job over the same bytes.
CREATE TABLE import_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    staged_file_id UUID REFERENCES import_staged_files(id) ON DELETE SET NULL,
    source_format VARCHAR(20) NOT NULL DEFAULT 'mny',
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' | 'running' | 'completed' | 'failed'
    options JSONB NOT NULL DEFAULT '{}'::jsonb,
    progress JSONB,
    result JSONB,
    error_key VARCHAR(100),
    error_detail TEXT,
    retryable BOOLEAN NOT NULL DEFAULT false,
    -- Set inside the import transaction, so it commits with the rows it
    -- describes (migration 140). Distinguishes "failed before writing anything,
    -- retry is free" from "the ledger is already written and only the completion
    -- metadata is missing" -- two states the retryable flag used to fold into
    -- one and offer as an ordinary retry, which re-imported the file.
    data_committed BOOLEAN NOT NULL DEFAULT false,
    -- The current attempt's identity (migration 144), minted by `claim()` and
    -- required by every write the worker makes. The reaper clears it, which is
    -- what stops a worker it already gave up on from committing anyway: the
    -- import transaction's last statement is a fenced compare-and-set on this
    -- column, and a zero-row result rolls the whole import back (audit RV4-001).
    attempt_token UUID,
    heartbeat_at TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Load-bearing for the partial unique index below, not cosmetic: its
    -- predicate names two statuses, so a status the application never intended
    -- would sit outside the predicate and let a second active job exist.
    CONSTRAINT import_jobs_status_check
        CHECK (status IN ('pending', 'running', 'completed', 'failed'))
);

-- `data_committed` may only go false -> true while the job is `running`
-- (migration 145). The application checkpoint also requires the attempt's token,
-- but that only binds code that knows the column exists: during a rolling
-- deployment a previous-version worker runs `UPDATE import_jobs SET
-- data_committed = true WHERE id = $1`, naming no token, and would otherwise
-- commit the whole file after the new reaper had already failed the job and
-- advertised a retry (audit RRV4-001). The reaper's action is `status = 'failed'`,
-- so this refuses exactly that commit -- to either version -- as a statement error
-- that aborts the import transaction.
--
-- Deliberately not "and has a token": an old worker's normal unreaped state is
-- `running` with a NULL token, and refusing that would break every import in
-- flight during the rollout.
CREATE OR REPLACE FUNCTION reject_unfenced_import_checkpoint() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
      'import job % may not record a data commit while status is %; the attempt was reaped',
      OLD.id, NEW.status
      USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER trg_import_job_fenced_checkpoint
    BEFORE UPDATE ON import_jobs
    FOR EACH ROW
    WHEN (
      NEW.data_committed
      AND NOT OLD.data_committed
      AND NEW.status <> 'running'
    )
    EXECUTE FUNCTION reject_unfenced_import_checkpoint();

CREATE INDEX idx_import_jobs_user ON import_jobs(user_id);
CREATE INDEX idx_import_jobs_staged_file ON import_jobs(staged_file_id);
CREATE INDEX idx_import_jobs_running_heartbeat ON import_jobs(heartbeat_at) WHERE status = 'running';
-- One active import per user, enforced where it cannot be raced (migration 140).
-- The key is the user because that is what the product blocks on: hasActiveJob()
-- asks only whether this user has any pending/running job, and the 409 says "an
-- import is already running".
--
-- A fresh database is trivially in this state; an upgraded one need not be, since
-- more than one active job is exactly what the pre-136 code could produce. The
-- migration therefore repairs before it constrains -- see its preflight, and
-- backend/test/integration/migration-140-preflight.integration.spec.ts.
CREATE UNIQUE INDEX idx_import_jobs_one_active_per_user
    ON import_jobs(user_id)
    WHERE status IN ('pending', 'running');

CREATE TRIGGER update_import_jobs_updated_at BEFORE UPDATE ON import_jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Durable claims on per-user work that must happen at most once (migration 140).
--
-- ScheduleModule lives in the API process, so every backend replica fires every
-- cron (docs/cron-jobs.md). A guard held in process memory is therefore not a
-- guard -- each replica has its own -- and "query for a row like the one I am
-- about to write" is a check-then-act both replicas pass. The unique key makes
-- the claim itself the atomic operation.
--
-- expires_at NULL means a permanent claim (one delivery per user per window);
-- a timestamp means a lease a later worker may retake once it has passed, so a
-- replica killed mid-run does not lock the user out.
CREATE TABLE job_claims (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_type VARCHAR(64) NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    claim_key VARCHAR(200) NOT NULL,
    claimed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- The lease: present while a replica is doing the work, gone or past when it
    -- is not. NULL on a legacy permanent claim.
    expires_at TIMESTAMP,
    -- When the side effect this claim coordinates actually happened
    -- (migration 140). Written *after* the send, and re-read under the lease to
    -- decide whether the work is still owed: a claim taken before the send says
    -- only that somebody intended to send, and an intention does not survive the
    -- process holding it (audit RV4-006). A delivered row is never retaken.
    delivered_at TIMESTAMP,
    -- Which attempt owns the current lease (migration 142). The key above
    -- identifies the *work*; this identifies the holder, so a worker delayed past
    -- its own expiry cannot release a lease another replica has retaken or record a
    -- delivery for a send that replica has not finished (audit DR-RRV4-01). NULL for
    -- a permanent `claimOnce` row, which has no attempt to identify.
    lease_token UUID
);

CREATE UNIQUE INDEX idx_job_claims_key ON job_claims(claim_type, user_id, claim_key);
CREATE INDEX idx_job_claims_claimed_at ON job_claims(claimed_at);

-- Lease-ownership enforcement (migration 142). A session mutating a *live tokenized*
-- lease must own it, proven by the transaction-local `app.job_claim_lease_token`
-- GUC the new release/markDelivered set. The previous binary never sets it, so it
-- cannot delete or mark a lease this deployment has retaken. The WHEN clauses
-- exclude expired rows (retakes, retention sweep), permanent claimOnce rows
-- (NULL token) and delivered rows (NULL expiry), so only the tokenized writes and
-- the old binary's untokenized ones ever reach the guard.
--
-- The depth check exempts the ON DELETE CASCADE from `users`: a cascade carries no
-- lease token because it is the owner going away, not an attempt on the lease, and
-- without the exemption deleting an account raised for as long as the user held any
-- live tokenized lease. A direct DELETE fires this at depth 1; the cascade runs as a
-- trigger on `users` and fires it at depth 2.
CREATE OR REPLACE FUNCTION guard_job_claim_lease_ownership() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    -- Reached from another trigger: the only such path is the ON DELETE CASCADE
    -- from `users`. Nothing to own once the owner is gone.
    IF pg_trigger_depth() > 1 THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    IF COALESCE(current_setting('app.job_claim_lease_token', true), '')
       IS DISTINCT FROM OLD.lease_token::text THEN
        RAISE EXCEPTION
          'job_claims lease % (%/%/%) is held by another attempt; this session does not own it',
          OLD.lease_token, OLD.claim_type, OLD.user_id, OLD.claim_key
          USING ERRCODE = 'raise_exception';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_job_claims_guard_delete
    BEFORE DELETE ON job_claims
    FOR EACH ROW
    WHEN (
      OLD.lease_token IS NOT NULL
      AND OLD.expires_at IS NOT NULL
      AND OLD.expires_at > CURRENT_TIMESTAMP
    )
    EXECUTE FUNCTION guard_job_claim_lease_ownership();

CREATE TRIGGER trg_job_claims_guard_update
    BEFORE UPDATE ON job_claims
    FOR EACH ROW
    WHEN (
      OLD.lease_token IS NOT NULL
      AND OLD.expires_at IS NOT NULL
      AND OLD.expires_at > CURRENT_TIMESTAMP
    )
    EXECUTE FUNCTION guard_job_claim_lease_ownership();

-- Trigger for tags updated_at
CREATE TRIGGER update_tags_updated_at BEFORE UPDATE ON tags FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Action History (undo/redo support)
CREATE TABLE action_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID,
    action VARCHAR(20) NOT NULL,
    before_data JSONB,
    after_data JSONB,
    related_entities JSONB,
    is_undone BOOLEAN NOT NULL DEFAULT false,
    description VARCHAR(500) NOT NULL,
    description_key VARCHAR(100),
    description_params JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_action_history_user_created ON action_history(user_id, created_at DESC);
CREATE INDEX idx_action_history_user_undone ON action_history(user_id, is_undone, created_at DESC);

-- OAuth 2.1 Authorization Server payloads (node-oidc-provider adapter)
CREATE TABLE oauth_payloads (
    id VARCHAR(255) NOT NULL,
    model VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    grant_id VARCHAR(255),
    user_code VARCHAR(255),
    uid VARCHAR(255),
    expires_at TIMESTAMP,
    consumed_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, model)
);

CREATE INDEX idx_oauth_payloads_grant ON oauth_payloads(grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX idx_oauth_payloads_uid ON oauth_payloads(uid) WHERE uid IS NOT NULL;
CREATE INDEX idx_oauth_payloads_user_code ON oauth_payloads(user_code) WHERE user_code IS NOT NULL;
CREATE INDEX idx_oauth_payloads_expires ON oauth_payloads(expires_at) WHERE expires_at IS NOT NULL;

-- Monte Carlo retirement-projection scenarios (saved simulation inputs)
CREATE TABLE monte_carlo_scenarios (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    account_ids UUID[] NOT NULL DEFAULT '{}',
    starting_value NUMERIC(20, 4) NOT NULL DEFAULT 0,
    use_current_balance BOOLEAN NOT NULL DEFAULT TRUE,

    years_to_retirement INTEGER NOT NULL,
    annual_contribution NUMERIC(20, 4) NOT NULL DEFAULT 0,
    contribution_growth_rate NUMERIC(8, 6) NOT NULL DEFAULT 0,

    years_in_retirement INTEGER NOT NULL DEFAULT 0,
    annual_withdrawal NUMERIC(20, 4) NOT NULL DEFAULT 0,

    expected_return NUMERIC(8, 6) NOT NULL,
    volatility NUMERIC(8, 6) NOT NULL,

    inflation_rate NUMERIC(8, 6) NOT NULL DEFAULT 0.025,
    show_real_values BOOLEAN NOT NULL DEFAULT FALSE,
    use_historical_returns BOOLEAN NOT NULL DEFAULT FALSE,

    simulation_count INTEGER NOT NULL DEFAULT 5000,
    target_value NUMERIC(20, 4),
    random_seed BIGINT,

    is_favourite BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    last_run_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT monte_carlo_scenarios_years_to_retirement_check
      CHECK (years_to_retirement BETWEEN 0 AND 100),
    CONSTRAINT monte_carlo_scenarios_years_in_retirement_check
      CHECK (years_in_retirement BETWEEN 0 AND 100),
    CONSTRAINT monte_carlo_scenarios_simulation_count_check
      CHECK (simulation_count BETWEEN 100 AND 50000),
    CONSTRAINT monte_carlo_scenarios_volatility_check
      CHECK (volatility >= 0)
);

CREATE INDEX idx_monte_carlo_scenarios_user ON monte_carlo_scenarios(user_id);
CREATE INDEX idx_monte_carlo_scenarios_user_sort ON monte_carlo_scenarios(user_id, sort_order);

CREATE TRIGGER update_monte_carlo_scenarios_updated_at
  BEFORE UPDATE ON monte_carlo_scenarios
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Per-scenario cash-flow events (one-time or recurring) layered on top of
-- the base contribution/withdrawal phases.
CREATE TABLE monte_carlo_cash_flows (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scenario_id UUID NOT NULL REFERENCES monte_carlo_scenarios(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    amount NUMERIC(20, 4) NOT NULL,
    flow_type VARCHAR(20) NOT NULL,
    start_year INTEGER NOT NULL,
    end_year INTEGER,
    inflation_adjust BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT mc_cash_flows_type_check
      CHECK (flow_type IN ('ONE_TIME', 'RECURRING')),
    CONSTRAINT mc_cash_flows_start_year_check
      CHECK (start_year BETWEEN 1 AND 100),
    CONSTRAINT mc_cash_flows_end_year_check
      CHECK (end_year IS NULL OR end_year BETWEEN start_year AND 100)
);

CREATE INDEX idx_monte_carlo_cash_flows_scenario ON monte_carlo_cash_flows(scenario_id);

-- ============================================================
-- LOAN SCENARIOS (saved overpayment simulations)
-- ============================================================

CREATE TABLE loan_scenarios (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    recurring_extra_amount DECIMAL(20,4),
    recurring_extra_mode VARCHAR(64),
    recurring_extra_frequency VARCHAR(16),
    recurring_extra_start_date DATE,
    recurring_extra_end_date DATE,
    target_monthly_payment DECIMAL(20,4),
    target_monthly_payment_mode VARCHAR(64),
    target_monthly_payment_start_date DATE,
    target_monthly_payment_end_date DATE,
    lump_sums JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_loan_scenarios_user ON loan_scenarios(user_id);
CREATE INDEX idx_loan_scenarios_account ON loan_scenarios(account_id);
CREATE UNIQUE INDEX idx_loan_scenarios_account_name
    ON loan_scenarios(user_id, account_id, LOWER(name));

-- ============================================================
-- LOAN RATE CHANGES (interest-rate history for loans/mortgages)
-- ============================================================

-- 'initial' rows snapshot the origination rate the first time a change is
-- recorded; 'inferred' rows are produced by detection from payment history.
CREATE TABLE loan_rate_changes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    effective_date DATE NOT NULL,
    annual_rate NUMERIC(8,4) NOT NULL,
    new_payment_amount NUMERIC(20,4),
    source VARCHAR(10) NOT NULL DEFAULT 'manual',
    note VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_loan_rate_changes_source CHECK (source IN ('manual', 'inferred', 'initial')),
    CONSTRAINT chk_loan_rate_changes_rate CHECK (annual_rate >= 0 AND annual_rate <= 100),
    CONSTRAINT uq_loan_rate_changes_account_date UNIQUE (account_id, effective_date)
);

CREATE INDEX idx_loan_rate_changes_user ON loan_rate_changes(user_id);
CREATE INDEX idx_loan_rate_changes_account_date
    ON loan_rate_changes(account_id, effective_date);

CREATE TABLE gem_strategies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL DEFAULT 'GEM', -- scenario name; several per user
    cadence VARCHAR(20) NOT NULL DEFAULT 'MONTHLY', -- 'MONTHLY' | 'QUARTERLY'
    lookback_months INTEGER NOT NULL DEFAULT 12, -- momentum window
    tax_rate_percent NUMERIC(9,4), -- applied to an estimated realized gain
    commission_amount NUMERIC(20,4), -- per-switch broker commission estimate
    rules_source_url VARCHAR(500),
    rules_source_label VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_gem_strategies_user ON gem_strategies(user_id);

CREATE TRIGGER update_gem_strategies_updated_at
  BEFORE UPDATE ON gem_strategies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- The brokerage accounts a strategy is run in. The signal is the same for all
-- of them; the report sums the strategy's securities across the set.
CREATE TABLE gem_strategy_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strategy_id UUID NOT NULL REFERENCES gem_strategies(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_gem_strategy_accounts_pair ON gem_strategy_accounts(strategy_id, account_id);
CREATE INDEX idx_gem_strategy_accounts_user ON gem_strategy_accounts(user_id);

CREATE TABLE gem_strategy_assets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strategy_id UUID NOT NULL REFERENCES gem_strategies(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL, -- 'US_EQUITY' | 'EX_US_EQUITY' | 'EM_EQUITY' | 'SAFE' | 'RISK_FREE'
    security_id UUID REFERENCES securities(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_gem_strategy_assets_role ON gem_strategy_assets(strategy_id, role);
CREATE INDEX idx_gem_strategy_assets_user ON gem_strategy_assets(user_id);

CREATE TRIGGER update_gem_strategy_assets_updated_at
  BEFORE UPDATE ON gem_strategy_assets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE gem_strategy_signals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strategy_id UUID NOT NULL REFERENCES gem_strategies(id) ON DELETE CASCADE,
    evaluated_on DATE NOT NULL, -- price date the decision was taken on
    effective_from DATE NOT NULL, -- first day the allocation applies
    state VARCHAR(10) NOT NULL, -- 'RISK_ON' | 'RISK_OFF'
    target_role VARCHAR(20),
    target_security_id UUID REFERENCES securities(id) ON DELETE SET NULL,
    target_weight_percent NUMERIC(9,4) NOT NULL DEFAULT 100,
    momentum JSONB NOT NULL DEFAULT '{}'::jsonb, -- percent per role at evaluation time
    benchmark_role VARCHAR(20), -- role the absolute test measured against; NULL reads as 'SAFE'
    spread_pp NUMERIC(12,4), -- US equity momentum minus benchmark momentum
    lead_pp NUMERIC(12,4), -- winner minus runner-up, RISK_ON only
    previous_role VARCHAR(20), -- role held before this evaluation
    -- Hash of the signal-driving configuration (cadence, lookback, role->security)
    -- this row was calculated under. A period whose fingerprint no longer matches
    -- the strategy is recomputed instead of being served as the current signal.
    config_fingerprint VARCHAR(64),
    -- Version of the evaluation code behind this row. A settings change is
    -- recomputed in place; an algorithm change is not, because the row records
    -- what was actually decided and executed. Older versions are legacy
    -- periods: left untouched, and left out of the current history.
    algorithm_version SMALLINT NOT NULL DEFAULT 1,
    executed BOOLEAN NOT NULL DEFAULT FALSE,
    executed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- One row per period *per evaluation version*: an older version's row is an
-- immutable record of what was decided and executed, and must not stop the
-- current version from answering the same period.
CREATE UNIQUE INDEX idx_gem_strategy_signals_period ON gem_strategy_signals(strategy_id, evaluated_on, algorithm_version);
CREATE INDEX idx_gem_strategy_signals_user ON gem_strategy_signals(user_id);

-- ---------------------------------------------------------------------------
-- Web Push transport (migration 178).
--
-- push_instance_config is the deployment's push identity: one VAPID key pair
-- per Monize instance, generated on first start so a self-hosted administrator
-- registers nothing with Google, Apple or Firebase. The private half is
-- AES-256-GCM ciphertext under ENCRYPTION_KEY; an instance without that
-- variable stores no key at all rather than a plaintext secret. Deployment-wide
-- state with no owner column, so the table is RLS-exempt for the same reason
-- provider_health is -- see the marker block at the foot of the RLS section.
--
-- Neither table is exported by a backup (INTENTIONALLY_EXCLUDED_TABLES in
-- backend/src/backup/export-table-queries.ts): a subscription names a browser
-- on one machine talking to one origin under one VAPID key, and restoring a
-- production backup onto a test instance must not hand that instance the right
-- to push to real phones.
-- ---------------------------------------------------------------------------

CREATE TABLE push_instance_config (
    -- Singleton. The key admits exactly one value, so a second insert is a
    -- conflict rather than a second push identity for one deployment.
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    vapid_public_key VARCHAR(200) NOT NULL,
    vapid_private_key_enc TEXT NOT NULL,
    vapid_generated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Instance kill-switch. Off hides the whole push surface from every
    -- account's settings and makes the sender a no-op; it does not delete
    -- subscriptions, so turning it back on restores the devices as they were.
    web_push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE push_subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    -- SHA-256 hex of the endpoint. The endpoint itself is unbounded text and a
    -- btree index has a row-size limit, so the hash is what gets indexed.
    endpoint_hash VARCHAR(64) NOT NULL,
    p256dh VARCHAR(255) NOT NULL,
    auth VARCHAR(255) NOT NULL,
    -- Which wire this subscription is delivered on (migration 184). 'webpush' is
    -- a browser vendor's push service; 'unifiedpush' is a distributor endpoint
    -- (ntfy/NextPush), the same encrypted Web Push protocol either way. The
    -- per-user channel toggles gate the two independently.
    transport VARCHAR(20) NOT NULL DEFAULT 'webpush'
        CONSTRAINT push_subscriptions_transport_check
        CHECK (transport IN ('webpush', 'unifiedpush')),
    device_name VARCHAR(100),
    user_agent VARCHAR(255),
    -- The address this subscription was registered from (migration 185), so the
    -- device list can tell two browsers on one machine apart -- `device_name` is
    -- derived from the User-Agent and is identical for both. Refreshed on each
    -- re-registration, alongside last_seen_at, and NEVER at delivery time: a
    -- push travels from this server to the push service, which reaches the
    -- device over a connection this deployment does not see, so the address a
    -- device is reachable at today is not knowable here.
    registered_ip INET,
    -- The instance identity this subscription was minted under. A rotation
    -- makes every older subscription undeliverable -- the push service checks
    -- the VAPID signature against the key the subscription was created with --
    -- so the column is what lets the sender skip a stale row even if the
    -- rotation that should have disabled it was interrupted.
    vapid_public_key VARCHAR(200) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_success_at TIMESTAMP,
    failure_count INTEGER NOT NULL DEFAULT 0,
    disabled_at TIMESTAMP,
    disabled_reason VARCHAR(40)
);

-- Globally unique, not unique per user, and that is the security property.
--
-- A push subscription belongs to a browser profile and an origin, NOT to a
-- Monize session: two people sharing one browser get the same endpoint and the
-- same encryption keys from pushManager.subscribe(). Scoped per user, both rows
-- would survive and a notification addressed to the first account would be
-- decrypted and displayed on the device the second account is now using.
--
-- One row per endpoint, and the second subscriber is REFUSED rather than
-- allowed to take the row over: an endpoint is a string the caller supplied,
-- and no ownership check covers it, so a takeover would be a cross-tenant
-- delete on an unverified identifier -- and a silent one. The client answers
-- the refusal by unsubscribing and subscribing again, which mints a fresh
-- endpoint nobody holds, and logging out releases the endpoint the same way.
CREATE UNIQUE INDEX idx_push_subscriptions_endpoint ON push_subscriptions(endpoint_hash);

-- Every send starts with "which of this user's devices are still live".
CREATE INDEX idx_push_subscriptions_user_live ON push_subscriptions(user_id) WHERE disabled_at IS NULL;

-- ===========================================================================
-- Row-Level Security policies
--
-- Mirrored from database/migrations/112_rls_policies_direct.sql,
-- 113_rls_policies_indirect.sql and 114_rls_policies_special.sql so a
-- fresh db-init produces the same catalog as a migrated database.
--
-- These policies are INERT until ALTER TABLE ... ENABLE ROW LEVEL SECURITY
-- ships separately (task M3 / flip B of the rollout). Nothing below changes a
-- query result on its own.
--
-- Adding a table? It must land in exactly one of four buckets -- direct,
-- indirect, bespoke owner column, or the documented exemption list at the
-- bottom of this section. The catalog-driven integration spec fails on any
-- table that is in none of them.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Direct ownership (user_id column)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    t text;
    direct_tables text[] := ARRAY[
        'action_history',
        'attachment_blob_tombstones',
        'ai_insights',
        'ai_provider_configs',
        'ai_usage_logs',
        'auto_backup_settings',
        'budgets',
        'custom_reports',
        'gem_strategies',
        'gem_strategy_accounts',
        'gem_strategy_assets',
        'gem_strategy_signals',
        'import_column_mappings',
        'import_jobs',
        'import_staged_files',
        'institutions',
        'investment_reports',
        'investment_transactions',
        'job_claims',
        'loan_rate_changes',
        'loan_scenarios',
        'monte_carlo_scenarios',
        'notification_portfolio_state',
        'notification_preferences',
        'notification_reminders',
        'notifications',
        'payee_aliases',
        'payee_lookup_settings',
        'payee_lookup_usage',
        'push_subscriptions',
        'scheduled_transactions',
        'securities',
        'transaction_attachments',
        'user_currency_preferences'
    ];
BEGIN
    FOREACH t IN ARRAY direct_tables LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_isolation', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I
               USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
               WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))',
            t || '_isolation', t
        );
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- transactions -- direct ownership plus a delegate READ arm (migration 132).
--
-- Rows in an account covered by an active can_read grant are visible to the
-- delegate's own session (app.real_user_id), which is what lets a cross-owner
-- transfer counterpart -- and the acting delegate's linkedTransaction join --
-- load under enforcement. WITH CHECK stays owner-only: cross-owner writes run
-- under the audited withSystemContext bypass after in-code authorization.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS transactions_isolation ON transactions;
CREATE POLICY transactions_isolation ON transactions
  USING (user_id = (SELECT app_current_user_id())
      OR (SELECT app_bypass_rls())
      OR EXISTS (SELECT 1 FROM account_delegate_grants g
                 JOIN account_delegates d ON d.id = g.delegation_id
                 WHERE g.account_id = transactions.account_id
                   AND g.can_read AND d.status = 'active'
                   AND d.delegate_user_id = (SELECT app_real_user_id())))
  WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

-- ---------------------------------------------------------------------------
-- Joint-account native reads (migration 134): the same delegate READ arm as
-- transactions, on the other tables a grantee's own-context session touches.
-- WITH CHECK stays owner-only everywhere; grantee writes run under the
-- audited withSystemContext bypass after in-code authorization.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS accounts_isolation ON accounts;
CREATE POLICY accounts_isolation ON accounts
  USING (user_id = (SELECT app_current_user_id())
      OR (SELECT app_bypass_rls())
      OR EXISTS (SELECT 1 FROM account_delegate_grants g
                 JOIN account_delegates d ON d.id = g.delegation_id
                 WHERE g.account_id = accounts.id
                   AND g.can_read AND d.status = 'active'
                   AND d.delegate_user_id = (SELECT app_real_user_id())))
  WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

DROP POLICY IF EXISTS monthly_account_balances_isolation ON monthly_account_balances;
CREATE POLICY monthly_account_balances_isolation ON monthly_account_balances
  USING (user_id = (SELECT app_current_user_id())
      OR (SELECT app_bypass_rls())
      OR EXISTS (SELECT 1 FROM account_delegate_grants g
                 JOIN account_delegates d ON d.id = g.delegation_id
                 WHERE g.account_id = monthly_account_balances.account_id
                   AND g.can_read AND d.status = 'active'
                   AND d.delegate_user_id = (SELECT app_real_user_id())))
  WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

-- categories / payees / tags: delegation-scoped read arms. Not account-scoped
-- tables, so the arm is gated on ANY active delegation from the row's owner.
-- This widens nothing the app layer does not already grant: an acting
-- delegate reads the owner's entire reference lists today, and the native
-- surface serves them only through the grant-gated reference-data endpoint.
DROP POLICY IF EXISTS categories_isolation ON categories;
CREATE POLICY categories_isolation ON categories
  USING (user_id = (SELECT app_current_user_id())
      OR (SELECT app_bypass_rls())
      OR EXISTS (SELECT 1 FROM account_delegates d
                 WHERE d.owner_user_id = categories.user_id
                   AND d.status = 'active'
                   AND d.delegate_user_id = (SELECT app_real_user_id())))
  WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

DROP POLICY IF EXISTS payees_isolation ON payees;
CREATE POLICY payees_isolation ON payees
  USING (user_id = (SELECT app_current_user_id())
      OR (SELECT app_bypass_rls())
      OR EXISTS (SELECT 1 FROM account_delegates d
                 WHERE d.owner_user_id = payees.user_id
                   AND d.status = 'active'
                   AND d.delegate_user_id = (SELECT app_real_user_id())))
  WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

DROP POLICY IF EXISTS tags_isolation ON tags;
CREATE POLICY tags_isolation ON tags
  USING (user_id = (SELECT app_current_user_id())
      OR (SELECT app_bypass_rls())
      OR EXISTS (SELECT 1 FROM account_delegates d
                 WHERE d.owner_user_id = tags.user_id
                   AND d.status = 'active'
                   AND d.delegate_user_id = (SELECT app_real_user_id())))
  WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

-- ---------------------------------------------------------------------------
-- Group B: keyed by the AUTHENTICATED user (4 tables)
--
-- These four also have a user_id column, but the id stored in it is the
-- *authenticated* identity, not the effective one. Under delegation those
-- differ, so the uniform Group A predicate would silently return zero rows for
-- the acting delegate -- inside normal request scope, where nothing throws and
-- nothing logs. Verified against the call sites rather than assumed; see the
-- per-table notes below.
--
-- Adding the app_real_user_id() arm cannot widen isolation: app.real_user_id
-- only ever holds the id the JWT layer authenticated, so the arm exposes the
-- caller's own rows and never a third party's. Outside delegation the two GUCs
-- are equal and the arm is redundant.
-- ---------------------------------------------------------------------------

-- refresh_tokens: user_id is ALWAYS the real authenticated user; when a
-- delegate acts, the owner is carried separately in acting_as_user_id
-- (see backend/src/auth/token.service.ts -- "sub is ALWAYS the real
-- authenticated user"). POST /auth/switch-context is @AllowDelegate and both
-- revokes and inserts delegate-keyed rows while the request context names the
-- owner, so the real arm is load-bearing.
--
-- The acting_as_user_id arm covers the inverse direction: an owner deleting
-- their account purges the delegate sessions opened against their data
-- (users.service.ts: delete({ actingAsUserId })). Those rows have another
-- user's user_id, so without this arm the purge would silently no-op and leave
-- live delegate sessions pointing at deleted data.
DROP POLICY IF EXISTS refresh_tokens_isolation ON refresh_tokens;
CREATE POLICY refresh_tokens_isolation ON refresh_tokens
  USING (user_id = (SELECT app_current_user_id())
      OR user_id = (SELECT app_real_user_id())
      OR acting_as_user_id = (SELECT app_current_user_id())
      OR (SELECT app_bypass_rls()))
  WITH CHECK (user_id = (SELECT app_current_user_id())
      OR user_id = (SELECT app_real_user_id())
      OR acting_as_user_id = (SELECT app_current_user_id())
      OR (SELECT app_bypass_rls()));

-- oidc_step_up_claims (migration 155): written on the authenticated request
-- that spends the proof, so the ordinary per-user policy applies.
DROP POLICY IF EXISTS oidc_step_up_claims_isolation ON oidc_step_up_claims;
CREATE POLICY oidc_step_up_claims_isolation ON oidc_step_up_claims
  USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
  WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

-- trusted_devices: uniformly real-user keyed. Every authenticated route that
-- reads or writes it (list / revoke / revoke-all trusted devices, disable 2FA,
-- change password) passes req.user.realUserId, and those routes ARE
-- @AllowDelegate -- so a delegate reaches their own devices while acting.
DROP POLICY IF EXISTS trusted_devices_isolation ON trusted_devices;
CREATE POLICY trusted_devices_isolation ON trusted_devices
  USING (user_id = (SELECT app_current_user_id())
      OR user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()))
  WITH CHECK (user_id = (SELECT app_current_user_id())
      OR user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()));

-- personal_access_tokens: the CRUD routes pass req.user.id but PatController
-- carries no @AllowDelegate, so the delegate guard rejects acting tokens and
-- the two ids coincide today. changePassword already revokes by realUserId.
-- The real arm makes the policy correct under either keying, so adding
-- @AllowDelegate later cannot turn into a silent zero-rows bug.
DROP POLICY IF EXISTS personal_access_tokens_isolation ON personal_access_tokens;
CREATE POLICY personal_access_tokens_isolation ON personal_access_tokens
  USING (user_id = (SELECT app_current_user_id())
      OR user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()))
  WITH CHECK (user_id = (SELECT app_current_user_id())
      OR user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()));

-- user_preferences: mostly effective-user keyed (locale, timezone, currency
-- display -- a delegate sees the owner's), but the 2FA endpoints
-- (confirm-setup, disable, is-enabled) are @AllowDelegate and read/write the
-- DELEGATE's own preferences row via req.user.realUserId. Both arms required.
DROP POLICY IF EXISTS user_preferences_isolation ON user_preferences;
CREATE POLICY user_preferences_isolation ON user_preferences
  USING (user_id = (SELECT app_current_user_id())
      OR user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()))
  WITH CHECK (user_id = (SELECT app_current_user_id())
      OR user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()));

-- ---------------------------------------------------------------------------
-- Indirect ownership (resolved through a parent row)
-- ---------------------------------------------------------------------------

-- transaction_splits / transaction_tags additionally carry the joint-account
-- delegate READ arm (migration 134): the indirect predicate restates
-- ownership, so they do not inherit the transactions policy's arm.
DROP POLICY IF EXISTS transaction_splits_isolation ON transaction_splits;
CREATE POLICY transaction_splits_isolation ON transaction_splits
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.id = transaction_splits.transaction_id
      AND t.user_id = (SELECT app_current_user_id()))
      OR EXISTS (
    SELECT 1 FROM transactions t
    JOIN account_delegate_grants g ON g.account_id = t.account_id
    JOIN account_delegates d ON d.id = g.delegation_id
    WHERE t.id = transaction_splits.transaction_id
      AND g.can_read AND d.status = 'active'
      AND d.delegate_user_id = (SELECT app_real_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.id = transaction_splits.transaction_id
      AND t.user_id = (SELECT app_current_user_id())));

-- transaction_tags -> transactions.user_id
DROP POLICY IF EXISTS transaction_tags_isolation ON transaction_tags;
CREATE POLICY transaction_tags_isolation ON transaction_tags
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.id = transaction_tags.transaction_id
      AND t.user_id = (SELECT app_current_user_id()))
      OR EXISTS (
    SELECT 1 FROM transactions t
    JOIN account_delegate_grants g ON g.account_id = t.account_id
    JOIN account_delegates d ON d.id = g.delegation_id
    WHERE t.id = transaction_tags.transaction_id
      AND g.can_read AND d.status = 'active'
      AND d.delegate_user_id = (SELECT app_real_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.id = transaction_tags.transaction_id
      AND t.user_id = (SELECT app_current_user_id())));

-- transaction_split_tags -> transaction_splits -> transactions.user_id (two-hop)
DROP POLICY IF EXISTS transaction_split_tags_isolation ON transaction_split_tags;
CREATE POLICY transaction_split_tags_isolation ON transaction_split_tags
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM transaction_splits ts
    JOIN transactions t ON t.id = ts.transaction_id
    WHERE ts.id = transaction_split_tags.transaction_split_id
      AND t.user_id = (SELECT app_current_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM transaction_splits ts
    JOIN transactions t ON t.id = ts.transaction_id
    WHERE ts.id = transaction_split_tags.transaction_split_id
      AND t.user_id = (SELECT app_current_user_id())));

-- attachment_blobs -> transaction_attachments.user_id
-- (transaction_attachments is itself a direct table -- see 112.)
DROP POLICY IF EXISTS attachment_blobs_isolation ON attachment_blobs;
CREATE POLICY attachment_blobs_isolation ON attachment_blobs
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM transaction_attachments ta
    WHERE ta.id = attachment_blobs.attachment_id
      AND ta.user_id = (SELECT app_current_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM transaction_attachments ta
    WHERE ta.id = attachment_blobs.attachment_id
      AND ta.user_id = (SELECT app_current_user_id())));

-- ---------------------------------------------------------------------------
-- Scheduled transactions family
-- ---------------------------------------------------------------------------

-- scheduled_transaction_splits -> scheduled_transactions.user_id
DROP POLICY IF EXISTS scheduled_transaction_splits_isolation ON scheduled_transaction_splits;
CREATE POLICY scheduled_transaction_splits_isolation ON scheduled_transaction_splits
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM scheduled_transactions st
    WHERE st.id = scheduled_transaction_splits.scheduled_transaction_id
      AND st.user_id = (SELECT app_current_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM scheduled_transactions st
    WHERE st.id = scheduled_transaction_splits.scheduled_transaction_id
      AND st.user_id = (SELECT app_current_user_id())));

-- scheduled_transaction_split_tags -> scheduled_transaction_splits
--   -> scheduled_transactions.user_id (two-hop)
DROP POLICY IF EXISTS scheduled_transaction_split_tags_isolation ON scheduled_transaction_split_tags;
CREATE POLICY scheduled_transaction_split_tags_isolation ON scheduled_transaction_split_tags
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM scheduled_transaction_splits sts
    JOIN scheduled_transactions st ON st.id = sts.scheduled_transaction_id
    WHERE sts.id = scheduled_transaction_split_tags.scheduled_transaction_split_id
      AND st.user_id = (SELECT app_current_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM scheduled_transaction_splits sts
    JOIN scheduled_transactions st ON st.id = sts.scheduled_transaction_id
    WHERE sts.id = scheduled_transaction_split_tags.scheduled_transaction_split_id
      AND st.user_id = (SELECT app_current_user_id())));

-- scheduled_transaction_overrides -> scheduled_transactions.user_id
DROP POLICY IF EXISTS scheduled_transaction_overrides_isolation ON scheduled_transaction_overrides;
CREATE POLICY scheduled_transaction_overrides_isolation ON scheduled_transaction_overrides
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM scheduled_transactions st
    WHERE st.id = scheduled_transaction_overrides.scheduled_transaction_id
      AND st.user_id = (SELECT app_current_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM scheduled_transactions st
    WHERE st.id = scheduled_transaction_overrides.scheduled_transaction_id
      AND st.user_id = (SELECT app_current_user_id())));

-- scheduled_transaction_postings -> scheduled_transactions.user_id (migration 140)
DROP POLICY IF EXISTS scheduled_transaction_postings_isolation ON scheduled_transaction_postings;
CREATE POLICY scheduled_transaction_postings_isolation ON scheduled_transaction_postings
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM scheduled_transactions st
    WHERE st.id = scheduled_transaction_postings.scheduled_transaction_id
      AND st.user_id = (SELECT app_current_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM scheduled_transactions st
    WHERE st.id = scheduled_transaction_postings.scheduled_transaction_id
      AND st.user_id = (SELECT app_current_user_id())));

-- ---------------------------------------------------------------------------
-- Securities family
--
-- securities is per-user (symbol is unique per user), so a security's price
-- history and tags belong to exactly one user despite looking like reference
-- data. holdings hang off the account, not the security.
-- ---------------------------------------------------------------------------

-- security_documents carries its own user_id (migration 118)
DROP POLICY IF EXISTS security_documents_isolation ON security_documents;
CREATE POLICY security_documents_isolation ON security_documents
  USING (
    user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls())
  )
  WITH CHECK (
    user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls())
  );

-- security_prices -> securities.user_id
DROP POLICY IF EXISTS security_prices_isolation ON security_prices;
CREATE POLICY security_prices_isolation ON security_prices
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM securities s
    WHERE s.id = security_prices.security_id
      AND s.user_id = (SELECT app_current_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM securities s
    WHERE s.id = security_prices.security_id
      AND s.user_id = (SELECT app_current_user_id())));

-- security_tags -> securities.user_id
DROP POLICY IF EXISTS security_tags_isolation ON security_tags;
CREATE POLICY security_tags_isolation ON security_tags
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM securities s
    WHERE s.id = security_tags.security_id
      AND s.user_id = (SELECT app_current_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM securities s
    WHERE s.id = security_tags.security_id
      AND s.user_id = (SELECT app_current_user_id())));

-- holdings -> accounts.user_id
DROP POLICY IF EXISTS holdings_isolation ON holdings;
CREATE POLICY holdings_isolation ON holdings
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = holdings.account_id
      AND a.user_id = (SELECT app_current_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = holdings.account_id
      AND a.user_id = (SELECT app_current_user_id())));

-- ---------------------------------------------------------------------------
-- Budgets family
-- ---------------------------------------------------------------------------

-- budget_categories -> budgets.user_id
DROP POLICY IF EXISTS budget_categories_isolation ON budget_categories;
CREATE POLICY budget_categories_isolation ON budget_categories
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM budgets b
    WHERE b.id = budget_categories.budget_id
      AND b.user_id = (SELECT app_current_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM budgets b
    WHERE b.id = budget_categories.budget_id
      AND b.user_id = (SELECT app_current_user_id())));

-- budget_periods -> budgets.user_id
DROP POLICY IF EXISTS budget_periods_isolation ON budget_periods;
CREATE POLICY budget_periods_isolation ON budget_periods
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM budgets b
    WHERE b.id = budget_periods.budget_id
      AND b.user_id = (SELECT app_current_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM budgets b
    WHERE b.id = budget_periods.budget_id
      AND b.user_id = (SELECT app_current_user_id())));

-- budget_period_categories -> budget_periods -> budgets.user_id (two-hop)
DROP POLICY IF EXISTS budget_period_categories_isolation ON budget_period_categories;
CREATE POLICY budget_period_categories_isolation ON budget_period_categories
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM budget_periods bp
    JOIN budgets b ON b.id = bp.budget_id
    WHERE bp.id = budget_period_categories.budget_period_id
      AND b.user_id = (SELECT app_current_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM budget_periods bp
    JOIN budgets b ON b.id = bp.budget_id
    WHERE bp.id = budget_period_categories.budget_period_id
      AND b.user_id = (SELECT app_current_user_id())));

-- ---------------------------------------------------------------------------
-- Monte Carlo
-- ---------------------------------------------------------------------------

-- monte_carlo_cash_flows -> monte_carlo_scenarios.user_id
DROP POLICY IF EXISTS monte_carlo_cash_flows_isolation ON monte_carlo_cash_flows;
CREATE POLICY monte_carlo_cash_flows_isolation ON monte_carlo_cash_flows
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM monte_carlo_scenarios s
    WHERE s.id = monte_carlo_cash_flows.scenario_id
      AND s.user_id = (SELECT app_current_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM monte_carlo_scenarios s
    WHERE s.id = monte_carlo_cash_flows.scenario_id
      AND s.user_id = (SELECT app_current_user_id())));

-- ---------------------------------------------------------------------------
-- Delegation grants
--
-- account_delegate_grants -> account_delegates, which has no user_id either:
-- it is owner_user_id / delegate_user_id keyed. The parent predicate therefore
-- mirrors the account_delegates policy in 114 -- visible to the owner through
-- app.current_user_id and to the delegate through app.real_user_id, so a
-- delegate can still read which of the owner's accounts they were granted
-- while acting (current = owner, real = delegate).
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS account_delegate_grants_isolation ON account_delegate_grants;
CREATE POLICY account_delegate_grants_isolation ON account_delegate_grants
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM account_delegates ad
    WHERE ad.id = account_delegate_grants.delegation_id
      AND (ad.owner_user_id = (SELECT app_current_user_id())
        OR ad.delegate_user_id = (SELECT app_real_user_id()))))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM account_delegates ad
    WHERE ad.id = account_delegate_grants.delegation_id
      AND (ad.owner_user_id = (SELECT app_current_user_id())
        OR ad.delegate_user_id = (SELECT app_real_user_id()))));

-- ---------------------------------------------------------------------------
-- Bespoke owner columns, and the documented exemptions
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS users_self ON users;
CREATE POLICY users_self ON users
  USING (id = (SELECT app_current_user_id())
      OR id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()))
  WITH CHECK (id = (SELECT app_current_user_id())
      OR id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()));

-- ---------------------------------------------------------------------------
-- account_delegates -- visible from both sides of the delegation.
--
-- The owner reaches it through app.current_user_id (managing who they share
-- with). The delegate reaches it through app.real_user_id, which works both in
-- their own session (current = real = delegate) and while acting for the owner
-- (current = owner, real = delegate) -- the latter is what lets the delegate
-- guard resolve its own grant row on every acting request.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS account_delegates_isolation ON account_delegates;
CREATE POLICY account_delegates_isolation ON account_delegates
  USING (owner_user_id = (SELECT app_current_user_id())
      OR delegate_user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()))
  WITH CHECK (owner_user_id = (SELECT app_current_user_id())
      OR delegate_user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()));

-- ---------------------------------------------------------------------------
-- delegate_account_favourites -- belongs to the delegate personally.
--
-- Keyed by the delegate's own identity even while they act as the owner
-- (current = owner, real = delegate), so this is the one table scoped by
-- app.real_user_id alone. Matching app.current_user_id as well would let an
-- owner read the private favourites of the delegates they share with.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS delegate_account_favourites_isolation ON delegate_account_favourites;
CREATE POLICY delegate_account_favourites_isolation ON delegate_account_favourites
  USING (delegate_user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()))
  WITH CHECK (delegate_user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()));

-- delegate_net_worth_exclusions -- same shape and rationale as
-- delegate_account_favourites: the grantee's private per-account overlay
-- (migration 133), never readable by the owner.
DROP POLICY IF EXISTS delegate_net_worth_exclusions_isolation ON delegate_net_worth_exclusions;
CREATE POLICY delegate_net_worth_exclusions_isolation ON delegate_net_worth_exclusions
  USING (delegate_user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()))
  WITH CHECK (delegate_user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()));

-- ---------------------------------------------------------------------------
-- emergency_access_settings / emergency_access_contacts -- owner-keyed only.
--
-- The authenticated surface (emergency-access.controller.ts, class-guarded by
-- AuthGuard('jwt') + StepUpGuard, no @AllowDelegate) is entirely owner-keyed:
-- every service call passes req.user.id as the owner and every query filters
-- owner_user_id. There is no "who named me as an emergency contact" lookup, so
-- no grantee-side arm is needed (audited in task C4).
--
-- The grantee-facing side is the public claim flow, which identifies the
-- grantee by emailed claim token rather than by user id and runs entirely under
-- withSystemContext -- the bypass arm.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS emergency_access_settings_isolation ON emergency_access_settings;
CREATE POLICY emergency_access_settings_isolation ON emergency_access_settings
  USING (owner_user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
  WITH CHECK (owner_user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

DROP POLICY IF EXISTS emergency_access_contacts_isolation ON emergency_access_contacts;
CREATE POLICY emergency_access_contacts_isolation ON emergency_access_contacts
  USING (owner_user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
  WITH CHECK (owner_user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

-- ---------------------------------------------------------------------------
-- RLS exemptions: tables deliberately NOT policied, and therefore never
-- enabled by 123_rls_enable.sql.
--
-- The rationale for each entry -- and the boundary each one does NOT authorize
-- -- is docs/row-level-security-contract.md. That document is canonical: this
-- block is the machine-readable set, not a second copy of the reasoning.
--
-- The `rls-exempt:` lines below are parsed by
-- backend/src/common/db/rls-exempt-tables.spec.ts, which checks them against
-- RLS_EXEMPT_TABLES in backend/src/common/db/rls-exempt-tables.ts in both
-- directions and throws if this marker block goes missing. That constant is
-- what the two RLS integration specs import, so the list exists once.
--
-- Adding a table here is a deliberate decision that needs a contract entry: a
-- table in neither a policy migration nor this list fails
-- backend/test/integration/rls-enforcement.integration.spec.ts.
--
-- rls-exempt: currencies
-- rls-exempt: exchange_rates
-- rls-exempt: google_places_instance_usage
-- rls-exempt: market_index_prices
-- rls-exempt: market_index_sync
-- rls-exempt: oauth_payloads
-- rls-exempt: provider_health
-- rls-exempt: push_instance_config
-- rls-exempt: schema_migrations
-- ---------------------------------------------------------------------------

-- Verification helper (run manually; not part of the migration's effect):
--   SELECT tablename, policyname FROM pg_policies
--    WHERE schemaname = 'public' ORDER BY tablename;
-- Expected: 62 policies -- 26 direct + 4 real-user-keyed (112),
--           15 indirect (113), 5 special (114),
--           2 direct for the .mny import's staging + job tables (117),
--           1 direct for security_documents (118),
--           4 direct for the GEM strategy tables (124, 125),
--           2 direct for job_claims and attachment_blob_tombstones,
--           1 indirect for scheduled_transaction_postings (133),
--           1 direct for the OIDC step-up claim ledger (155),
--           1 direct for push_subscriptions (178),
--           1 direct for notification_preferences (180),
--           1 direct for notification_reminders (182), and
--           1 direct for notification_portfolio_state (185).

-- ---------------------------------------------------------------------------
-- Enable row-level security (migration 123).
--
-- Mirrors 123_rls_enable.sql. Keep this block LAST in the RLS section: it
-- enforces whatever is policied at the moment it runs, so a CREATE POLICY
-- appended below it would create a policied-but-unenforced table on every fresh
-- install.
--
-- Enabling RLS does not affect the table owner, and at RLS_MODE=off -- the
-- default, and where every deployment starts -- the app connects as the owner.
-- So this is inert for a new install and stays inert until an operator moves
-- the app onto the unprivileged monize_app role. FORCE ROW LEVEL SECURITY is
-- deliberately not used: it would apply policies to the owner as well and break
-- db-init, db-migrate and backup restore.
--
-- Derived from pg_policies, never from a hard-coded list -- enabling RLS on a
-- table with no policy is a deny-all outage, and the four exempt tables above
-- have no policy and are therefore never touched. A new user-owned table must
-- ship its policy AND its enable; see database/CLAUDE.md.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    t text;
BEGIN
    FOR t IN
        SELECT DISTINCT tablename
          FROM pg_policies
         WHERE schemaname = 'public'
         ORDER BY tablename
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
END $$;

-- -------------------------------------------------------------------------
-- One global answer to "is this currency code still referenced?" (migration 136).
--
-- `currencies` is shared reference data, and columns across most of the
-- financial tables point at `currencies(code)`. Deleting a row any of them still
-- holds either aborts with a foreign-key violation or -- for
-- `user_currency_preferences`, the one FK that cascades -- silently removes
-- another user's activation.
--
-- The two callers that used to decide this each got it wrong: the currencies
-- service enumerated only some of the columns, and the backup restore's
-- cleanup enumerated all of them but ran inside the restoring user's transaction,
-- where RLS hides the other users' rows the `NOT EXISTS` clauses were looking
-- for. So the predicate lives here and both call it.
--
-- SECURITY DEFINER is what makes it global: policies are evaluated against
-- `current_user`, which inside a definer function is this function's owner, and
-- the owner is not subject to its own policies (FORCE ROW LEVEL SECURITY is
-- deliberately unused -- see the RLS notes at the end of this file). It runs in
-- the caller's transaction, so the check and the delete it guards stay one
-- read-modify-write, which a separate system-context connection could not be.
--
-- The privilege is one VARCHAR in, one boolean out: no row contents leave the
-- function and the caller cannot influence which tables are consulted.
-- `search_path` is pinned so `public` cannot be shadowed. EXECUTE is revoked
-- from PUBLIC and re-granted to the runtime role by db-init (a GRANT naming that
-- role cannot live in SQL that runs before the role exists).
--
-- `currency-references.spec.ts` fails when a FK to `currencies(code)` is not
-- consulted below, so a migration adding one cannot leave this behind.
CREATE OR REPLACE FUNCTION currency_code_in_use_globally(p_code VARCHAR)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_currency_preferences WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM exchange_rates
      WHERE from_currency = p_code OR to_currency = p_code
    UNION ALL SELECT 1 FROM accounts WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM transactions
      WHERE currency_code = p_code OR original_currency_code = p_code
    UNION ALL SELECT 1 FROM securities WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM scheduled_transactions
      WHERE currency_code = p_code OR original_currency_code = p_code
    UNION ALL SELECT 1 FROM budgets WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM user_preferences WHERE default_currency = p_code
  )
$$;

COMMENT ON FUNCTION currency_code_in_use_globally(VARCHAR) IS
  'True when any row anywhere still references currencies(code) = p_code. '
  'SECURITY DEFINER so the answer is genuinely global rather than the calling '
  'tenant''s view of it; runs in the caller''s transaction so the check and the '
  'delete it guards are one read-modify-write. Must consult every FK to '
  'currencies(code) -- enforced by currency-references.spec.ts.';

REVOKE ALL ON FUNCTION currency_code_in_use_globally(VARCHAR) FROM PUBLIC;

-- -------------------------------------------------------------------------
-- Which currency codes does one user reference?
--
-- The companion to `currency_code_in_use_globally` (migration 136), and a
-- separate question: that one asks whether *anybody* still holds a code, this
-- one asks which codes a single user holds. Both enumerate the columns that
-- reference `currencies(code)`, which is precisely the list that has drifted
-- before, so both live in SQL beside each other and
-- `currency-references.spec.ts` checks each against the schema.
--
-- Two callers ask it in two slightly different ways, so it is two functions --
-- one list, derived twice, rather than the list written twice:
--
--   * `currency_codes_referenced_by_user_data` -- the codes this user's *data*
--     is denominated in. What the delete gate needs: deleting a currency the
--     caller still has a budget or an account in has to be refused.
--   * `currency_codes_referenced_by_user` -- the above plus the user's own
--     activation row. What the backup export needs: a currency the user
--     activated but has not spent anything in yet must still travel with the
--     backup, or the restore has a preference row pointing at a definition that
--     is not in the file.
--
-- The composite calls the data function rather than repeating its branches. The
-- delete gate could not use the composite: it runs *before* deleting the
-- caller's own preference row, so the activation it is about to remove would
-- always answer "in use" and no currency could ever be deleted.
--
-- The backup export needs this because it selected currencies by
-- `created_by_user_id`. Currencies are shared -- any user may activate a code
-- another user created -- so a user whose accounts are denominated in somebody
-- else's custom currency exported the references without the definition, and a
-- restore onto a fresh instance invented name, symbol and decimal places from a
-- fallback. A currency defined as `PTS / Family Points / * / 0 decimals` came
-- back as `PTS / PTS / PTS / 2 decimals`: the stored amounts were unchanged, but
-- a balance of 7 rendered as `PTS 7.00` instead of `*7`.
--
-- The delete gate needs it because `CurrenciesService.isInUse` was a third
-- hand-written spelling of the same list and was missing `budgets.currency_code`
-- -- so a user with a budget denominated in a custom currency was told the code
-- was not "in use by your accounts, securities, or other records", had their
-- activation deleted, and was left with a budget in a currency they could no
-- longer see or reactivate.
--
-- Both are deliberately SECURITY INVOKER, unlike their sibling in 133. They must
-- answer for the calling tenant only, and under RLS the caller's own policies
-- give exactly that -- so the ordinary rules apply and no privilege is granted.
--
-- `exchange_rates` is absent on purpose: it is global reference data with no
-- `user_id`, so it cannot contribute to a per-user answer. The guard test knows
-- this rule (a referencing table with no `user_id` column is exempt here) rather
-- than carrying an exception list.

-- NULLs are filtered once here rather than per branch: three of the columns are
-- nullable, and a NULL in the result set turns a caller's `NOT IN` into a
-- silently empty answer.
CREATE OR REPLACE FUNCTION currency_codes_referenced_by_user_data(p_user_id uuid)
RETURNS SETOF varchar
LANGUAGE sql
STABLE
AS $$
  SELECT code FROM (
    SELECT default_currency AS code FROM user_preferences WHERE user_id = p_user_id
    UNION SELECT currency_code FROM accounts WHERE user_id = p_user_id
    UNION SELECT currency_code FROM transactions WHERE user_id = p_user_id
    UNION SELECT original_currency_code FROM transactions WHERE user_id = p_user_id
    UNION SELECT currency_code FROM securities WHERE user_id = p_user_id
    UNION SELECT currency_code FROM scheduled_transactions WHERE user_id = p_user_id
    UNION SELECT original_currency_code FROM scheduled_transactions WHERE user_id = p_user_id
    UNION SELECT currency_code FROM budgets WHERE user_id = p_user_id
  ) referenced
  WHERE code IS NOT NULL
$$;

COMMENT ON FUNCTION currency_codes_referenced_by_user_data(uuid) IS
  'The currency codes one user''s data is denominated in, excluding their own '
  'user_currency_preferences activation row. What the delete gate needs, since it '
  'runs before removing that row. SECURITY INVOKER: the answer is meant to be the '
  'calling tenant''s, which the caller''s own RLS policies already give. Must '
  'consult every FK to currencies(code) whose table has a user_id -- enforced by '
  'currency-references.spec.ts. exchange_rates is excluded: global reference data '
  'with no owner cannot contribute to a per-user answer.';

CREATE OR REPLACE FUNCTION currency_codes_referenced_by_user(p_user_id uuid)
RETURNS SETOF varchar
LANGUAGE sql
STABLE
AS $$
  SELECT currency_code FROM user_currency_preferences WHERE user_id = p_user_id
  UNION SELECT referenced.code
    FROM currency_codes_referenced_by_user_data(p_user_id) AS referenced(code)
$$;

COMMENT ON FUNCTION currency_codes_referenced_by_user(uuid) IS
  'Every currency code one user references: the codes their data is denominated '
  'in, plus the codes they have activated. What the backup export needs, so an '
  'activated-but-unused currency definition still travels with the backup. '
  'Derives from currency_codes_referenced_by_user_data rather than repeating its '
  'branches -- that list has drifted three times.';

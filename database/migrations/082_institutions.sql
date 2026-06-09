-- Financial Institutions: a per-user registry of banks and brokerages.
-- Accounts can be assigned to an institution. The institution's brand icon is
-- the bank's favicon, fetched server-side from Google's faviconV2 endpoint and
-- cached in the database (logo_data) so the user's browser never has to contact
-- a third party to render it.

CREATE TABLE IF NOT EXISTS institutions (
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

CREATE INDEX IF NOT EXISTS idx_institutions_user ON institutions(user_id);

-- Link accounts to an institution. ON DELETE SET NULL so removing an
-- institution simply unassigns its accounts rather than deleting them.
ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS institution_id UUID REFERENCES institutions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_institution ON accounts(institution_id);

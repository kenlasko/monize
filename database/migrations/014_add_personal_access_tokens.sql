-- Add personal access tokens for MCP and API access
CREATE TABLE IF NOT EXISTS personal_access_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    token_prefix VARCHAR(8) NOT NULL,
    token_hash VARCHAR(64) NOT NULL,
    scopes VARCHAR(500) NOT NULL DEFAULT 'read',
    last_used_at TIMESTAMP,
    expires_at TIMESTAMP,
    is_revoked BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE personal_access_tokens OWNER TO monize;

CREATE INDEX idx_pat_user ON personal_access_tokens(user_id);
CREATE UNIQUE INDEX idx_pat_token_hash ON personal_access_tokens(token_hash);
CREATE INDEX idx_pat_user_active ON personal_access_tokens(user_id, is_revoked)
    WHERE is_revoked = false;

CREATE TRIGGER update_personal_access_tokens_updated_at
    BEFORE UPDATE ON personal_access_tokens
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 055: OAuth 2.1 Authorization Server tables for MCP remote connector flow.
--
-- node-oidc-provider stores all model payloads (Client, AuthorizationCode,
-- AccessToken, RefreshToken, Grant, Session, Interaction, etc.) in a single
-- table keyed by (id, model). The adapter contract requires lookups by id,
-- by uid (for sessions/interactions), by user_code (for device flow), and
-- bulk revocation by grant_id.

CREATE TABLE IF NOT EXISTS oauth_payloads (
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

CREATE INDEX IF NOT EXISTS idx_oauth_payloads_grant ON oauth_payloads(grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_payloads_uid ON oauth_payloads(uid) WHERE uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_payloads_user_code ON oauth_payloads(user_code) WHERE user_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_payloads_expires ON oauth_payloads(expires_at) WHERE expires_at IS NOT NULL;

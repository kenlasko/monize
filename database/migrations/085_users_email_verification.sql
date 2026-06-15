-- Email verification for new local accounts (sent when SMTP is configured).
--
-- email_verified gates local login: a self-service registrant who signs up
-- while SMTP is enabled cannot log in until they confirm ownership of their
-- email via the verification link. Accounts created any other way (the first
-- bootstrap user, admin-created users, invited delegates, OIDC users) are
-- created already-verified.
--
-- Existing accounts predate this feature, so they must be treated as verified
-- to avoid locking anyone out. The column is therefore first added with
-- DEFAULT true (which backfills every existing row), then the default is
-- flipped to false so only new self-registrations start unverified. Both
-- statements are idempotent: re-running skips the ADD (column already exists)
-- and re-applies the harmless default change.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT false;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token_expiry TIMESTAMP;

-- Partial index for the verification-token lookup (mirrors idx_users_reset_token).
CREATE INDEX IF NOT EXISTS idx_users_email_verification_token
  ON users(email_verification_token) WHERE email_verification_token IS NOT NULL;

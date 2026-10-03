-- OAuth2 (XOAUTH2) login for the email receipts mailbox: Google and Microsoft 365
-- (docs/future-plans/email-receipts.md sections 3a and 4, task B9).
--
-- Expand only, so the previous release keeps working against this schema during
-- a rolling deploy: password_enc stops being NOT NULL (a relaxed constraint),
-- and the three new columns are nullable or carry a default that describes every
-- existing row (auth_method 'password'). The previous release writes a password
-- on every insert and never sets the new columns, which the new CHECK accepts.
--
-- A mailbox is one of two shapes, and the CHECK says which:
--   password: a stored password, no provider, no refresh token;
--   oauth2:   a provider and no password. The refresh token may be absent, which
--             is what a disconnected (or revoked) mailbox looks like: it keeps its
--             row, its settings and its receipts until the user reconnects.
-- The refresh token is AES-256-GCM ciphertext under ENCRYPTION_KEY, like
-- password_enc; the table is excluded from backups (INTENTIONALLY_EXCLUDED_TABLES),
-- so neither reaches an archive and no support-backup rule is needed.

ALTER TABLE email_receipt_mailboxes ALTER COLUMN password_enc DROP NOT NULL;

ALTER TABLE email_receipt_mailboxes
    ADD COLUMN IF NOT EXISTS auth_method VARCHAR(10) NOT NULL DEFAULT 'password';
ALTER TABLE email_receipt_mailboxes
    ADD COLUMN IF NOT EXISTS oauth_provider VARCHAR(12);
ALTER TABLE email_receipt_mailboxes
    ADD COLUMN IF NOT EXISTS oauth_refresh_token_enc TEXT;

ALTER TABLE email_receipt_mailboxes
    DROP CONSTRAINT IF EXISTS ck_email_receipt_mailboxes_auth_method;
ALTER TABLE email_receipt_mailboxes
    ADD CONSTRAINT ck_email_receipt_mailboxes_auth_method
    CHECK (auth_method IN ('password', 'oauth2'));

ALTER TABLE email_receipt_mailboxes
    DROP CONSTRAINT IF EXISTS ck_email_receipt_mailboxes_oauth_provider;
ALTER TABLE email_receipt_mailboxes
    ADD CONSTRAINT ck_email_receipt_mailboxes_oauth_provider
    CHECK (oauth_provider IS NULL OR oauth_provider IN ('google', 'microsoft'));

ALTER TABLE email_receipt_mailboxes
    DROP CONSTRAINT IF EXISTS ck_email_receipt_mailboxes_credentials;
ALTER TABLE email_receipt_mailboxes
    ADD CONSTRAINT ck_email_receipt_mailboxes_credentials
    CHECK (
      (auth_method = 'password'
        AND password_enc IS NOT NULL
        AND oauth_provider IS NULL
        AND oauth_refresh_token_enc IS NULL)
      OR
      (auth_method = 'oauth2'
        AND oauth_provider IS NOT NULL
        AND password_enc IS NULL)
    );

-- Add pending_two_factor_secret column for staged 2FA setup
-- The secret is only promoted to two_factor_secret after TOTP confirmation
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pending_two_factor_secret VARCHAR NULL;

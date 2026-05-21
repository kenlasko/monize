-- Track the last time the user did anything authenticated (any HTTP request
-- with a valid JWT, not just sign-in). The global RequestContextInterceptor
-- updates this column fire-and-forget on every authenticated request,
-- throttled in-memory to once every five minutes per user to avoid hot
-- writes. Emergency access uses this -- not last_login -- to decide whether
-- the account is dormant, so simply browsing the app resets the timer.
--
-- Backfilled from last_login so existing users do not appear dormant
-- immediately after the migration.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP;

UPDATE users
SET last_activity_at = last_login
WHERE last_activity_at IS NULL AND last_login IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_last_activity_at
  ON users(last_activity_at)
  WHERE last_activity_at IS NOT NULL;

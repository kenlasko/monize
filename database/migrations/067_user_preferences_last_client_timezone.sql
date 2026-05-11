-- Persist the last-known browser timezone reported by the user, so background
-- jobs (e.g. the scheduled-transactions auto-post cron) can compute "today"
-- in the user's actual local time even when user_preferences.timezone is the
-- "browser" sentinel. Without this, a user in EDT can see transactions
-- auto-posted ~5 hours early when UTC rolls past midnight before they do.

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS last_client_timezone VARCHAR(64);

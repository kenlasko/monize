-- Add dismissed_update_version column to user_preferences so admins can dismiss
-- the "upstream update available" banner on a per-version basis. When a new
-- upstream release is detected, the stored version no longer matches the latest
-- and the banner re-appears.

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS dismissed_update_version VARCHAR(50);

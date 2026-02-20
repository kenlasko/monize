-- Add week_starts_on preference (0=Sunday, 1=Monday, ..., 6=Saturday)
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS week_starts_on SMALLINT DEFAULT 1;

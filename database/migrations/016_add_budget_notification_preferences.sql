-- Add budget notification preferences to user_preferences table
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS budget_digest_enabled BOOLEAN DEFAULT true;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS budget_digest_day VARCHAR(10) DEFAULT 'MONDAY';

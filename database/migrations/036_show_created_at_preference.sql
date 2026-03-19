-- Add show_created_at preference to allow viewing/editing transaction created_at timestamps
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS show_created_at BOOLEAN DEFAULT false;

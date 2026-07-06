-- Per-user dashboard layout: ordered list of visible widget ids.
-- Empty array = the built-in default layout (existing users see no change).
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS dashboard_widgets TEXT[] DEFAULT '{}';

-- Add ai_import_instructions column to user_preferences
ALTER TABLE user_preferences ADD COLUMN ai_import_instructions TEXT DEFAULT NULL;

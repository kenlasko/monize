-- Migration 108: Update user_preferences column defaults to INR and en-IN
ALTER TABLE user_preferences ALTER COLUMN default_currency SET DEFAULT 'INR';
ALTER TABLE user_preferences ALTER COLUMN number_format SET DEFAULT 'en-IN';
ALTER TABLE user_preferences DROP CONSTRAINT IF EXISTS user_preferences_default_quote_provider_check;
ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_default_quote_provider_check CHECK (default_quote_provider IN ('yahoo','msn','mfapi'));

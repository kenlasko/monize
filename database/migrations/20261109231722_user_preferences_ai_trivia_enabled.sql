-- Whether the trivia line beside the dashboard greeting is shown and built.
-- Default ON; a user can switch it off in AI Settings.
--
-- Expand only; idempotent: safe to run multiple times.
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS ai_trivia_enabled BOOLEAN DEFAULT true;

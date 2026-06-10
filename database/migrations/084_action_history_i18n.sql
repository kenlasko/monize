-- Localize the action history descriptions.
-- The English `description` is retained as a fallback (and for older rows that
-- predate this change), while `description_key` + `description_params` let the
-- client render the text in the viewer's current language.

ALTER TABLE action_history
    ADD COLUMN IF NOT EXISTS description_key VARCHAR(100);

ALTER TABLE action_history
    ADD COLUMN IF NOT EXISTS description_params JSONB;

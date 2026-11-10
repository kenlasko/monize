-- The trivia line beside the dashboard greeting (docs/future-plans/dashboard-trivia.md):
-- one row per user, replaced whole by the daily generation, holding the sentences
-- and the figures they quote.
--
-- Expand only; idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS dashboard_trivia (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    items JSONB NOT NULL DEFAULT '[]',
    figures JSONB NOT NULL DEFAULT '{}',
    -- The language the sentences are in, or the browser's where the reader's
    -- preference is to follow it: the daily job has no browser to ask.
    language VARCHAR(10),
    generated_at TIMESTAMP NOT NULL
);

ALTER TABLE dashboard_trivia ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dashboard_trivia_isolation ON dashboard_trivia;
CREATE POLICY dashboard_trivia_isolation ON dashboard_trivia
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

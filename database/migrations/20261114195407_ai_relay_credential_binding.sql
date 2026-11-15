-- Bind a web-chat relay turn to the CREDENTIAL that serves it, not only to the
-- user (kenlasko/monize#2176).
--
-- Before this, any credential of the user could claim the user's pending chat
-- prompts (reading the prompt and its history) and answer them, and could
-- overwrite a turn another credential had claimed: the claim and the answer
-- were both keyed on user_id alone.
--
-- ai_relay_agents.agent_credential is the one credential currently serving the
-- user's web chat, and agent_seen_at the last time it asked for work. Another
-- credential takes the chat over only once that holder has gone quiet and has
-- no turn in flight; until then its polls claim nothing.
--
-- ai_relay_prompts.claimed_credential is the credential that claimed a turn.
-- Only that credential may answer it, or adopt it from a reconnected session.
-- A turn claimed without one (before this migration, or by a pod still on the
-- previous release during the rollout) can no longer be answered by the new
-- release; it expires on its deadline like any abandoned turn. Accepting a NULL
-- would leave exactly the user-wide answer this closes.
--
-- All three are nullable additions, so the previous release's own statements
-- keep working against this schema for the length of a rolling deployment.

ALTER TABLE ai_relay_agents
    ADD COLUMN IF NOT EXISTS agent_credential TEXT;
ALTER TABLE ai_relay_agents
    ADD COLUMN IF NOT EXISTS agent_seen_at TIMESTAMPTZ;
ALTER TABLE ai_relay_prompts
    ADD COLUMN IF NOT EXISTS claimed_credential TEXT;

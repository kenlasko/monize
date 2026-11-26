-- Per-occurrence auto-post choice on a scheduled transaction's override.
--
-- NULL follows the schedule's own auto_post. TRUE posts this one occurrence
-- automatically when the schedule does not (or when the schedule's amount is an
-- estimate and this override states the occurrence's amount); FALSE leaves this
-- one occurrence for a person to post on a schedule that otherwise auto-posts.
-- Nullable with no default, so the previous release, which never writes it,
-- keeps working during a rollout and every existing override follows its
-- schedule.

ALTER TABLE scheduled_transaction_overrides
  ADD COLUMN IF NOT EXISTS auto_post BOOLEAN;

COMMENT ON COLUMN scheduled_transaction_overrides.auto_post IS
  'This occurrence''s auto-post choice: NULL follows the schedule, TRUE posts it automatically, FALSE leaves it for manual posting.';

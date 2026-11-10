-- Estimated scheduled amounts (issue #2096, docs/specs/scheduled-amount-estimate.md).
--
-- When amount_is_estimated is true, every occurrence without an override that
-- states its own amount is priced from the payee and category's payment
-- history, per calendar month, by ScheduledAmountEstimateService. The stored
-- `amount` stays the snapshot for the next occurrence, refreshed on save.
--
-- An estimated schedule is a plain one: never a split, a transfer, an
-- investment, a foreign-currency entry or an auto-posted schedule. The service
-- refuses those combinations and the auto-post cron skips the flag; a CHECK is
-- deliberately not added here, because a pod of the previous release could
-- still write auto_post on a row during a rolling deployment
-- (docs/database-migrations.md, "narrow a type or add a CHECK").
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, with a default so the previous
-- release's inserts keep working.
ALTER TABLE scheduled_transactions
    ADD COLUMN IF NOT EXISTS amount_is_estimated BOOLEAN NOT NULL DEFAULT false;

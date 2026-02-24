-- Migration: Persist bill alerts and enable soft delete for all alerts
--
-- Bill alerts (upcoming manual bills) were previously generated on-the-fly
-- and never saved to the database. Dismissing or marking them as read only
-- affected in-memory state, so they reappeared after browser refresh.
--
-- Changes:
-- 1. Make budget_id nullable (bill alerts don't belong to a budget)
-- 2. Add dismissed_at column for soft delete (prevents re-creation of dismissed alerts)

ALTER TABLE budget_alerts ALTER COLUMN budget_id DROP NOT NULL;

ALTER TABLE budget_alerts ADD COLUMN dismissed_at TIMESTAMP;

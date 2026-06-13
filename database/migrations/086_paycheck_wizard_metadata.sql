-- Add paycheck_metadata column to scheduled_transactions
ALTER TABLE scheduled_transactions ADD COLUMN paycheck_metadata JSONB DEFAULT NULL;

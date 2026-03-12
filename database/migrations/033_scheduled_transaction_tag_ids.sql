-- Add tag_ids JSONB column to scheduled_transactions for storing associated tag IDs
ALTER TABLE scheduled_transactions ADD COLUMN IF NOT EXISTS tag_ids JSONB DEFAULT '[]'::jsonb;

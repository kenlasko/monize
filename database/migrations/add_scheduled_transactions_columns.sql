-- Migration: Add additional columns to scheduled_transactions table
-- These columns support the Bills & Deposits feature

-- Add name column for identifying the scheduled transaction
ALTER TABLE scheduled_transactions ADD COLUMN IF NOT EXISTS name VARCHAR(255);

-- Add currency_code column
ALTER TABLE scheduled_transactions ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) DEFAULT 'CAD';

-- Add occurrences tracking columns
ALTER TABLE scheduled_transactions ADD COLUMN IF NOT EXISTS occurrences_remaining INTEGER;
ALTER TABLE scheduled_transactions ADD COLUMN IF NOT EXISTS total_occurrences INTEGER;

-- Rename columns to match application conventions (if they exist with old names)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scheduled_transactions' AND column_name = 'auto_enter') THEN
        ALTER TABLE scheduled_transactions RENAME COLUMN auto_enter TO auto_post;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scheduled_transactions' AND column_name = 'notify_days_before') THEN
        ALTER TABLE scheduled_transactions RENAME COLUMN notify_days_before TO reminder_days_before;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scheduled_transactions' AND column_name = 'last_processed_date') THEN
        ALTER TABLE scheduled_transactions RENAME COLUMN last_processed_date TO last_posted_date;
    END IF;
END $$;

-- Add auto_post column if it doesn't exist (in case of fresh install)
ALTER TABLE scheduled_transactions ADD COLUMN IF NOT EXISTS auto_post BOOLEAN DEFAULT false;

-- Add reminder_days_before column if it doesn't exist
ALTER TABLE scheduled_transactions ADD COLUMN IF NOT EXISTS reminder_days_before INTEGER DEFAULT 3;

-- Add last_posted_date column if it doesn't exist
ALTER TABLE scheduled_transactions ADD COLUMN IF NOT EXISTS last_posted_date DATE;

-- Update name from payee_name for existing records where name is null
UPDATE scheduled_transactions SET name = COALESCE(payee_name, 'Scheduled Payment') WHERE name IS NULL;

-- Make name not null after populating
ALTER TABLE scheduled_transactions ALTER COLUMN name SET NOT NULL;

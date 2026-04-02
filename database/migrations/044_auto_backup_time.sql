-- Add backup_time column to auto_backup_settings for configurable backup scheduling
ALTER TABLE auto_backup_settings ADD COLUMN IF NOT EXISTS backup_time VARCHAR(5) NOT NULL DEFAULT '02:00';

-- Add timezone column to auto_backup_settings for local time scheduling
ALTER TABLE auto_backup_settings ADD COLUMN IF NOT EXISTS timezone VARCHAR(100) NOT NULL DEFAULT 'UTC';

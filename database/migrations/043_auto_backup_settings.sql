-- Auto backup settings: per-user configuration for automatic backups to a folder
CREATE TABLE IF NOT EXISTS auto_backup_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT false,
    folder_path VARCHAR(1024) NOT NULL DEFAULT '',
    frequency VARCHAR(20) NOT NULL DEFAULT 'daily',
    backup_time VARCHAR(5) NOT NULL DEFAULT '02:00',
    retention_daily SMALLINT NOT NULL DEFAULT 7,
    retention_weekly SMALLINT NOT NULL DEFAULT 4,
    retention_monthly SMALLINT NOT NULL DEFAULT 6,
    last_backup_at TIMESTAMP,
    last_backup_status VARCHAR(20),
    last_backup_error VARCHAR(1024),
    next_backup_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- For existing installations that already have the table without backup_time
ALTER TABLE auto_backup_settings ADD COLUMN IF NOT EXISTS backup_time VARCHAR(5) NOT NULL DEFAULT '02:00';

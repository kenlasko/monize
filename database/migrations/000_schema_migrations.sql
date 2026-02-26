-- 000: Bootstrap migration tracking table
-- This table is used by db-migrate to track which migrations have been applied.
-- It must be the first migration so subsequent migrations can be tracked.

CREATE TABLE IF NOT EXISTS schema_migrations (
    filename VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

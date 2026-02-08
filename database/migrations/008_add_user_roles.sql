-- Migration: Add role and must_change_password fields to users table

ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;

-- Retroactively promote the earliest user to admin
UPDATE users SET role = 'admin'
WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
AND (SELECT COUNT(*) FROM users) > 0;

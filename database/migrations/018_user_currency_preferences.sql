-- 018: Multi-user currency support
-- Adds per-user currency visibility and is_active preferences
-- System currencies (created_by_user_id IS NULL) remain visible to all users
-- User-created currencies are only visible to users with a preference row

-- Track who created non-system currencies
ALTER TABLE currencies ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Per-user currency preferences (visibility + is_active)
CREATE TABLE IF NOT EXISTS user_currency_preferences (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code) ON DELETE CASCADE,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, currency_code)
);

CREATE INDEX IF NOT EXISTS idx_ucp_user ON user_currency_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_ucp_currency ON user_currency_preferences(currency_code);

-- Data migration: for each user, create preference rows for currencies
-- that are inactive (preserve their deactivated state) or in active use
INSERT INTO user_currency_preferences (user_id, currency_code, is_active)
SELECT DISTINCT u.id, c.code, c.is_active
FROM users u
CROSS JOIN currencies c
WHERE c.created_by_user_id IS NULL AND (
    c.is_active = false
    OR EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id AND a.currency_code = c.code)
    OR EXISTS (SELECT 1 FROM securities s WHERE s.user_id = u.id AND s.currency_code = c.code)
    OR EXISTS (SELECT 1 FROM user_preferences up WHERE up.user_id = u.id AND up.default_currency = c.code)
)
ON CONFLICT DO NOTHING;

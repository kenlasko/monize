-- Action history for undo/redo support
-- Stores before/after snapshots of user actions to enable reversing changes

CREATE TABLE IF NOT EXISTS action_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID,
    action VARCHAR(20) NOT NULL,
    before_data JSONB,
    after_data JSONB,
    related_entities JSONB,
    is_undone BOOLEAN NOT NULL DEFAULT false,
    description VARCHAR(500) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_action_history_user_created
    ON action_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_history_user_undone
    ON action_history(user_id, is_undone, created_at DESC);

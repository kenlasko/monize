-- Add tags support to scheduled transaction splits (many-to-many junction table)
CREATE TABLE IF NOT EXISTS scheduled_transaction_split_tags (
    scheduled_transaction_split_id UUID NOT NULL REFERENCES scheduled_transaction_splits(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (scheduled_transaction_split_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_scheduled_transaction_split_tags_tag ON scheduled_transaction_split_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_transaction_split_tags_split ON scheduled_transaction_split_tags(scheduled_transaction_split_id);

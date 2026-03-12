-- Add tags for transactions. Tags provide a cross-cutting classification
-- beyond categories (e.g. "Vacation", "Tax Deductible", "Reimbursable").
-- Tags can be assigned to both transactions and individual splits.

CREATE TABLE IF NOT EXISTS tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    color VARCHAR(7),
    icon VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_user_name ON tags(user_id, LOWER(name));
CREATE INDEX IF NOT EXISTS idx_tags_user ON tags(user_id);

-- Junction table: transaction <-> tag (many-to-many)
CREATE TABLE IF NOT EXISTS transaction_tags (
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (transaction_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_transaction_tags_tag ON transaction_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_transaction_tags_transaction ON transaction_tags(transaction_id);

-- Junction table: transaction_split <-> tag (many-to-many)
CREATE TABLE IF NOT EXISTS transaction_split_tags (
    transaction_split_id UUID NOT NULL REFERENCES transaction_splits(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (transaction_split_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_transaction_split_tags_tag ON transaction_split_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_transaction_split_tags_split ON transaction_split_tags(transaction_split_id);

-- Trigger for updated_at on tags
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'update_tags_updated_at'
    ) THEN
        CREATE TRIGGER update_tags_updated_at
            BEFORE UPDATE ON tags
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;
